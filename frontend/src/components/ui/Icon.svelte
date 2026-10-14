<script module lang="ts">
  export type IconName = 'copy' | 'edit' | 'regenerate' | 'fork' | 'trash' | 'more'
    | 'pin' | 'folder' | 'no-folder' | 'plus' | 'attach' | 'expand' | 'collapse'
    | 'send' | 'stop' | 'close';
</script>

<script lang="ts">
  interface Props {
    name: IconName;
    size?: number;
  }
  let { name, size = 16 }: Props = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.75"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  {#if name === 'copy'}
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V4H4v12h4" />
  {:else if name === 'edit'}
    <path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z" />
  {:else if name === 'regenerate'}
    <path d="M3 10a9 9 0 1 1 2.6 8.4M3 4v6h6" />
  {:else if name === 'fork'}
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="5" r="2" />
    <path d="M6 7v10m0-4h6a6 6 0 0 0 6-6" />
  {:else if name === 'trash'}
    <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />
  {:else if name === 'more'}
    <circle cx="5" cy="12" r="1" fill="currentColor" />
    <circle cx="12" cy="12" r="1" fill="currentColor" />
    <circle cx="19" cy="12" r="1" fill="currentColor" />
  {:else if name === 'pin'}
    <path d="m16 3 5 5-4 1-4 4-1 4-5-5 4-1 4-4 1-4ZM3 21l6-6" />
  {:else if name === 'folder'}
    <path d="M3 7V5h6l2 2h10v13H3V7Z" />
  {:else if name === 'no-folder'}
    <circle cx="12" cy="12" r="9" />
    <path d="m6 6 12 12" />
  {:else if name === 'plus'}
    <path d="M12 5v14M5 12h14" />
  {:else if name === 'attach'}
    <path d="m21 11-9 9a6 6 0 0 1-8.5-8.5l9.5-9.5a4 4 0 0 1 5.7 5.7l-9.5 9.5a2 2 0 0 1-2.8-2.8l9-9" />
  {:else if name === 'expand'}
    <path d="M8 3H3v5m0-5 7 7m6 11h5v-5m0 5-7-7" />
  {:else if name === 'collapse'}
    <path d="M3 8h5V3m0 5L2 2m19 14h-5v5m0-5 6 6" />
  {:else if name === 'send'}
    <path d="M12 20V4m-6 6 6-6 6 6" />
  {:else if name === 'stop'}
    <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none" />
  {:else if name === 'close'}
    <path d="m6 6 12 12M6 18 18 6" />
  {/if}
</svg>

<style>
  svg {
    display: block;
    flex-shrink: 0;
  }
</style>
