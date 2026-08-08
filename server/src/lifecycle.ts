const activeTasks = new Set<Promise<unknown>>();

export function trackBackgroundTask<T>(task: Promise<T>): Promise<T> {
  activeTasks.add(task);
  task.then(
    () => activeTasks.delete(task),
    () => activeTasks.delete(task),
  );
  return task;
}

export async function waitForBackgroundTasks(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (activeTasks.size > 0 && Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    await Promise.race([
      Promise.allSettled([...activeTasks]),
      new Promise(resolve => setTimeout(resolve, Math.min(remaining, 250))),
    ]);
  }
}
