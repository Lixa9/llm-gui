export function createCheckpointWriter(
  write: (text: string) => Promise<boolean>,
  onError: (error: Error) => void,
  intervalMs = 500,
) {
  let latest: string | undefined;
  let pending: Promise<void> | null = null;
  let stopped = false;
  let lastWrite = 0;
  let timer: NodeJS.Timeout | null = null;

  const launch = () => {
    if (stopped || pending || latest === undefined) return;
    const text = latest;
    latest = undefined;
    lastWrite = Date.now();
    pending = Promise.resolve().then(() => write(text)).then(success => {
      if (!success) throw new Error('Generation checkpoint lost its lease');
    }).catch(error => {
      stopped = true;
      if (timer) clearTimeout(timer);
      onError(error instanceof Error ? error : new Error(String(error)));
    }).finally(() => {
      pending = null;
      schedule();
    });
  };
  const schedule = () => {
    if (stopped || pending || timer || latest === undefined) return;
    const delay = Math.max(0, intervalMs - (Date.now() - lastWrite));
    if (!delay) launch();
    else {
      timer = setTimeout(() => { timer = null; launch(); }, delay);
      timer.unref();
    }
  };
  return {
    submit(text: string) { if (!stopped) { latest = text; schedule(); } },
    async stop() {
      stopped = true;
      latest = undefined;
      if (timer) clearTimeout(timer);
      timer = null;
      await pending;
    },
  };
}
