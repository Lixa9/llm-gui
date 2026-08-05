export async function loadResource<T>(
  loader: () => Promise<T>,
  apply: (value: T) => void,
  setLoading: (value: boolean) => void,
  setError: (value: string | null) => void,
): Promise<void> {
  setLoading(true);
  setError(null);
  try {
    apply(await loader());
  } catch (error) {
    setError((error as Error).message);
  } finally {
    setLoading(false);
  }
}
