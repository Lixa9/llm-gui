// A native caret uses the font's ascent/descent, while our control labels use
// visible cap height. Rebalance those metrics on an alias of the same local
// face so the caret and letters share a center, without drawing a custom caret.
interface EditableFont {
  family: string;
  lineHeight: number;
}

const fonts = new Map<string, EditableFont | null>();
let nextFace = 0;

// Generic/platform font names cannot be used in local(). These are potential
// equivalents, accepted only after checking their glyph metrics against the
// actual font. The original stack remains the fallback for other scripts.
const localFallbacks = [
  'SF Pro Text', 'SF Pro Display', '.AppleSystemUIFont',
  'Segoe UI', 'Roboto', 'Helvetica Neue', 'Helvetica', 'Arial',
  'Liberation Sans', 'DejaVu Sans', 'Noto Sans', 'Ubuntu', 'FreeSans',
  'Liberation Mono', 'DejaVu Sans Mono', 'Noto Sans Mono', 'FreeMono',
  'WenQuanYi Zen Hei', 'WenQuanYi Zen Hei Mono',
];

function fingerprint(context: CanvasRenderingContext2D) {
  return ['H', 'xgjÅ', 'WiM 0123456789'].flatMap(text => {
    const metrics = context.measureText(text);
    return [metrics.width, metrics.actualBoundingBoxLeft, metrics.actualBoundingBoxRight,
      metrics.actualBoundingBoxAscent, metrics.actualBoundingBoxDescent];
  });
}

async function loadFont(font: string, family: string, size: number, weight: string, style: string): Promise<EditableFont | null> {
  if (typeof FontFace === 'undefined' || !('ascentOverride' in FontFace.prototype) || !('descentOverride' in FontFace.prototype)) return null;
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return null;
  context.font = font;
  const original = fingerprint(context);
  const metrics = context.measureText('H');
  const ascent = metrics.fontBoundingBoxAscent;
  const descent = metrics.fontBoundingBoxDescent;
  const offset = (metrics.actualBoundingBoxAscent - ascent + descent) / 2;
  if (!Number.isFinite(offset) || Math.abs(offset) < 0.01 || descent - offset < 0 || ascent + offset < 0) return null;

  const names = family.match(/"[^"]*"|'[^']*'|[^,]+/g)?.map(name => name.trim().replace(/^(["'])(.*)\1$/, '$2')) ?? [];
  for (const name of new Set([...names, ...localFallbacks])) {
    const alias = `EditableText${nextFace++}`;
    const face = new FontFace(alias, `local(${JSON.stringify(name)})`, { weight, style });
    try {
      await face.load();
      document.fonts.add(face);
      context.font = `${style} ${weight} ${size}px "${alias}"`;
      const candidate = fingerprint(context);
      const candidateMetrics = context.measureText('H');
      if (!candidate.every((value, index) => Math.abs(value - original[index]) < 0.01)
        || candidateMetrics.fontBoundingBoxAscent !== ascent || candidateMetrics.fontBoundingBoxDescent !== descent) {
        document.fonts.delete(face);
        continue;
      }

      // Preserve auto-sized input heights when replacing a font's line metrics.
      const probe = document.createElement('span');
      probe.style.cssText = 'position:absolute;visibility:hidden;display:block;white-space:pre;pointer-events:none';
      probe.style.font = font;
      probe.textContent = 'H';
      document.body.append(probe);
      const lineHeight = probe.getBoundingClientRect().height;
      probe.remove();

      // Use a fresh face: engines can cache the initial metrics once a face
      // has been measured, including inside native editing controls.
      document.fonts.delete(face);
      const alignedAlias = `EditableText${nextFace++}`;
      const alignedFace = new FontFace(alignedAlias, `local(${JSON.stringify(name)})`, {
        weight, style,
        ascentOverride: `${(ascent + offset) / size * 100}%`,
        descentOverride: `${(descent - offset) / size * 100}%`,
      });
      await alignedFace.load();
      document.fonts.add(alignedFace);
      return { family: `"${alignedAlias}", ${family}`, lineHeight };
    } catch {
      // Missing/private local faces or unsupported metric overrides: retain the
      // browser's original font and native editing behavior.
      document.fonts.delete(face);
    }
  }
  return null;
}

export function editableTextMetrics(style: CSSStyleDeclaration, ready: () => void): EditableFont | null {
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  if (!fonts.has(font)) {
    fonts.set(font, null);
    void loadFont(font, style.fontFamily, parseFloat(style.fontSize), style.fontWeight, style.fontStyle)
      .then(result => { fonts.set(font, result); ready(); });
  }
  return fonts.get(font) ?? null;
}
