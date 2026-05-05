// We use a URL-referenced sound file rather than importing directly to avoid bundler type issues
let audio: HTMLAudioElement | null = null;

export function playCompletionSound(enabled: boolean, volume: number): void {
  if (!enabled) return;
  try {
    if (!audio) {
      audio = new Audio('/complete.mp3');
    }
    audio.volume = Math.max(0, Math.min(1, volume));
    audio.currentTime = 0;
    audio.play().catch(() => {
      // NotAllowedError or NotSupportedError — silently ignore
    });
  } catch {
    // ignore
  }
}
