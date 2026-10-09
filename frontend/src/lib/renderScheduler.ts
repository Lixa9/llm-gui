export function createRenderScheduler(render: (text: string) => void, intervalMs = 50) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest = '';
  let lastRender = -Infinity;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastRender = Date.now();
    render(latest);
  };
  return {
    update(text: string, streaming: boolean) {
      latest = text;
      if (!streaming || Date.now() - lastRender >= intervalMs) flush();
      else if (!timer) timer = setTimeout(flush, intervalMs - (Date.now() - lastRender));
    },
    destroy() { if (timer) clearTimeout(timer); timer = null; },
  };
}
