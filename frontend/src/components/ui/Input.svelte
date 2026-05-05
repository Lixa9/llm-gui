<script lang="ts">
  interface Props {
    value?: string;
    placeholder?: string;
    type?: string;
    disabled?: boolean;
    autofocus?: boolean;
    oninput?: (e: Event) => void;
    onkeydown?: (e: KeyboardEvent) => void;
    onfocus?: () => void;
    onblur?: () => void;
  }
  let { value = $bindable(''), placeholder, type = 'text', disabled, autofocus, oninput, onkeydown, onfocus, onblur }: Props = $props();
</script>

<input
  {type}
  {placeholder}
  {disabled}
  {autofocus}
  bind:value
  class="input"
  oninput={oninput}
  onkeydown={onkeydown}
  onfocus={onfocus}
  onblur={onblur}
/>

<style>
  .input {
    width: 100%;
    padding: 6px 10px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-size: 13px;
    outline: none;
    transition: border-color 0.15s;
  }
  .input:focus { border-color: var(--accent); }
  .input:disabled { opacity: 0.5; }
</style>
