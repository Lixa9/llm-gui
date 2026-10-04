import type { AttachmentBlock } from './processing.ts';

/** The UI needs coverage, not duplicated extracted payloads and internal links. */
export function publicFileMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const { content_blocks: _blocks, epub_image_locations: _locations, ...coverage } = meta;
  return coverage;
}

/** Keep delimited payloads parseable when applying the shared text limit. */
export function textPrefix(text: string, max: number, format?: 'csv' | 'jsonl'): string {
  if (text.length <= max) return text;
  if (!format) {
    const end = max > 0 && /[\uD800-\uDBFF]/.test(text[max - 1]) ? max - 1 : max;
    return text.slice(0, end);
  }
  let quoted = false, end = 0;
  for (let i = 0; i < max; i++) {
    if (format === 'csv' && text[i] === '"') {
      if (quoted && text[i + 1] === '"') { i++; continue; }
      quoted = !quoted;
    }
    if (text[i] === '\n' && !quoted) end = i + 1;
  }
  return text.slice(0, end);
}

export function limitBlocks(blocks: AttachmentBlock[], max: number): {
  blocks: AttachmentBlock[]; truncated: boolean;
} {
  let remaining = max, truncated = false;
  const limited = blocks.map(block => {
    if (block.type !== 'text') return block;
    const text = textPrefix(block.text, remaining, block.format);
    remaining -= text.length;
    if (text.length === block.text.length) return block;
    truncated = true;
    return { ...block, text, notices: [...(block.notices ?? []), 'Text omitted at the document text limit.'] };
  });
  return { blocks: limited, truncated };
}
