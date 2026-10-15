import { editableTextMetrics } from './editableTextMetrics';

// Native controls cannot trim their internal text box. Keep their caret and
// glyph metrics together, then balance single-line padding like control labels.
let context: CanvasRenderingContext2D | null = null;
const corrections = new Map<string, number>();
const updates = new Set<() => void>();
let observer: ResizeObserver | undefined;
let frame: number | undefined;

function correction(style: CSSStyleDeclaration): number {
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const cached = corrections.get(font);
  if (cached !== undefined) return cached;
  context ??= document.createElement('canvas').getContext('2d');
  if (!context) return 0;
  context.font = font;
  const metrics = context.measureText('H');
  const offset = (metrics.actualBoundingBoxAscent - metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent) / 2;
  const value = Number.isFinite(offset) ? offset : 0;
  corrections.set(font, value);
  return value;
}

function schedule() {
  if (frame !== undefined) return;
  frame = requestAnimationFrame(() => {
    frame = undefined;
    for (const update of updates) update();
  });
}

function fontsChanged() {
  corrections.clear();
  schedule();
}

function watch(node: HTMLElement, update: () => void) {
  if (updates.size === 0) {
    window.addEventListener('resize', schedule);
    document.fonts.addEventListener('loadingdone', fontsChanged);
    void document.fonts.ready.then(fontsChanged);
    observer = new ResizeObserver(schedule);
  }
  updates.add(update);
  observer?.observe(node);
  update();
  return () => {
    updates.delete(update);
    observer?.unobserve(node);
    if (updates.size === 0) {
      window.removeEventListener('resize', schedule);
      document.fonts.removeEventListener('loadingdone', fontsChanged);
      observer?.disconnect();
      observer = undefined;
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
    }
  };
}

function preserve(node: HTMLElement, property: string) {
  const value = node.style.getPropertyValue(property);
  const priority = node.style.getPropertyPriority(property);
  return () => {
    if (value) node.style.setProperty(property, value, priority);
    else node.style.removeProperty(property);
  };
}

export function centerControlText(node: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) {
  const restoreTop = preserve(node, 'padding-top');
  const restoreBottom = preserve(node, 'padding-bottom');
  const restoreFamily = preserve(node, 'font-family');
  const restoreLineHeight = preserve(node, 'line-height');
  const unwatch = watch(node, () => {
    restoreTop();
    restoreBottom();
    restoreFamily();
    restoreLineHeight();
    let style = getComputedStyle(node);
    // Password masking glyphs use browser-specific metrics, not the cap height
    // of the characters being entered. Keep their original native face.
    if (node instanceof HTMLTextAreaElement || (node instanceof HTMLInputElement && node.type !== 'password')) {
      const metrics = editableTextMetrics(style, schedule);
      if (metrics) {
        const normalLineHeight = style.lineHeight === 'normal';
        node.style.fontFamily = metrics.family;
        if (normalLineHeight) node.style.lineHeight = `${metrics.lineHeight}px`;
        style = getComputedStyle(node);
      }
    }
    // Multiline controls keep their existing line spacing and padding.
    if (node instanceof HTMLTextAreaElement) return;
    const top = parseFloat(style.paddingTop);
    const bottom = parseFloat(style.paddingBottom);
    const offset = Math.max(-top, Math.min(bottom, correction(style)));
    node.style.paddingTop = `${top + offset}px`;
    node.style.paddingBottom = `${bottom - offset}px`;
  });
  return { destroy() { unwatch(); restoreTop(); restoreBottom(); restoreFamily(); restoreLineHeight(); } };
}

// Keep existing clipping/ellipsis behavior for text that already has a box.
export function centerInlineText(node: HTMLElement) {
  const restore = preserve(node, 'transform');
  const unwatch = watch(node, () => {
    node.style.transform = `translateY(${correction(getComputedStyle(node))}px)`;
  });
  return { destroy() { unwatch(); restore(); } };
}

// The regular line-box fallback also needs font correction in older browsers.
export function centerLabelText(node: HTMLElement) {
  if (!CSS.supports('text-box-trim', 'trim-both')) return centerInlineText(node);
}
