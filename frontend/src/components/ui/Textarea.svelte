<script lang="ts">
  interface Props {
    value?: string;
    placeholder?: string;
    disabled?: boolean;
    autofocus?: boolean;
    rows?: number;
    maxRows?: number;
    oninput?: (e: Event) => void;
    onkeydown?: (e: KeyboardEvent) => void;
  }
  let { value = $bindable(''), placeholder, disabled, autofocus, rows = 1, maxRows = 12, oninput, onkeydown }: Props = $props();

  let el: HTMLTextAreaElement | undefined = $state();

  function autoResize() {
    if (!el) return;
    el.style.height = 'auto';
    const lineH = parseInt(getComputedStyle(el).lineHeight) || 20;
    const maxH = lineH * maxRows + 16;
    el.style.height = Math.min(el.scrollHeight, maxH) + 'px';
  }

  $effect(() => {
    if (el) autoResize();
  });

  function handleInput(e: Event) {
    autoResize();
    oninput?.(e);
  }
</script>

<textarea
  bind:this={el}
  bind:value
  {placeholder}
  {disabled}
  {autofocus}
  {rows}
  class="textarea"
  oninput={handleInput}
  onkeydown={onkeydown}
></textarea>

<style>
  .textarea {
    width: 100%;
    padding: 8px 10px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 13px;
    outline: none;
    resize: none;
    line-height: 1.5;
    transition: border-color 0.15s;
    overflow-y: auto;
  }
  .textarea:focus { border-color: var(--accent); }
  .textarea:disabled { opacity: 0.5; }
</style>
