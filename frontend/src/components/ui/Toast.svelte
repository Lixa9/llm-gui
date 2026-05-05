<script lang="ts" module>
  export type ToastType = 'info' | 'success' | 'error' | 'warning';
  interface Toast { id: string; type: ToastType; message: string; }

  let toasts = $state<Toast[]>([]);

  export function toast(message: string, type: ToastType = 'info', duration = 3000) {
    const id = crypto.randomUUID();
    toasts = [...toasts, { id, type, message }];
    if (duration > 0) setTimeout(() => dismiss(id), duration);
  }

  export function dismiss(id: string) {
    toasts = toasts.filter(t => t.id !== id);
  }

  export function getToasts() { return toasts; }
</script>
