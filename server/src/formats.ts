import { basename, extname } from 'node:path';

export interface FileFormat {
  mime: string;
  extensions: string[];
  kind: 'image' | 'document' | 'text' | 'archive';
}
export const FILE_FORMATS: FileFormat[] = [
  { mime: 'image/jpeg', extensions: ['jpg', 'jpeg'], kind: 'image' },
  { mime: 'image/png', extensions: ['png'], kind: 'image' },
  { mime: 'image/gif', extensions: ['gif'], kind: 'image' },
  { mime: 'image/webp', extensions: ['webp'], kind: 'image' },
  { mime: 'image/heic', extensions: ['heic', 'heif'], kind: 'image' },
  { mime: 'image/tiff', extensions: ['tif', 'tiff'], kind: 'image' },
  { mime: 'image/bmp', extensions: ['bmp'], kind: 'image' },
  { mime: 'image/svg+xml', extensions: ['svg'], kind: 'image' },
  { mime: 'application/pdf', extensions: ['pdf'], kind: 'document' },
  {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extensions: ['docx'],
    kind: 'document',
  },
  { mime: 'application/msword', extensions: ['doc'], kind: 'document' },
  { mime: 'application/rtf', extensions: ['rtf'], kind: 'document' },
  { mime: 'application/vnd.oasis.opendocument.text', extensions: ['odt'], kind: 'document' },
  {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    extensions: ['pptx'],
    kind: 'document',
  },
  { mime: 'application/vnd.ms-powerpoint', extensions: ['ppt'], kind: 'document' },
  { mime: 'application/vnd.oasis.opendocument.presentation', extensions: ['odp'], kind: 'document' },
  {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    extensions: ['xlsx'],
    kind: 'document',
  },
  { mime: 'application/vnd.ms-excel', extensions: ['xls'], kind: 'document' },
  { mime: 'application/vnd.oasis.opendocument.spreadsheet', extensions: ['ods'], kind: 'document' },
  { mime: 'application/epub+zip', extensions: ['epub'], kind: 'document' },
  { mime: 'message/rfc822', extensions: ['eml'], kind: 'document' },
  { mime: 'text/html', extensions: ['html', 'htm'], kind: 'text' },
  { mime: 'text/markdown', extensions: ['md', 'markdown'], kind: 'text' },
  { mime: 'application/json', extensions: ['json'], kind: 'text' },
  { mime: 'application/x-ndjson', extensions: ['jsonl', 'ndjson'], kind: 'text' },
  { mime: 'application/yaml', extensions: ['yaml', 'yml'], kind: 'text' },
  { mime: 'application/xml', extensions: ['xml'], kind: 'text' },
  { mime: 'text/csv', extensions: ['csv'], kind: 'text' },
  { mime: 'text/tab-separated-values', extensions: ['tsv'], kind: 'text' },
  {
    mime: 'text/plain',
    extensions: [
      'txt',
      'text',
      'py',
      'js',
      'mjs',
      'cjs',
      'ts',
      'tsx',
      'jsx',
      'java',
      'c',
      'h',
      'cpp',
      'hpp',
      'cs',
      'go',
      'rs',
      'sh',
      'bash',
      'sql',
      'css',
      'toml',
      'ini',
      'conf',
      'properties',
      'log',
      'diff',
      'patch',
    ],
    kind: 'text',
  },
  { mime: 'application/zip', extensions: ['zip'], kind: 'archive' },
  { mime: 'application/x-tar', extensions: ['tar'], kind: 'archive' },
  { mime: 'application/gzip', extensions: ['gz', 'tgz'], kind: 'archive' },
];
const aliases: Record<string, string> = {
  'image/heif': 'image/heic',
  'image/x-tiff': 'image/tiff',
  'image/x-ms-bmp': 'image/bmp',
  'text/rtf': 'application/rtf',
  'text/yaml': 'application/yaml',
  'text/x-yaml': 'application/yaml',
  'application/x-yaml': 'application/yaml',
  'text/xml': 'application/xml',
  'application/x-zip-compressed': 'application/zip',
  'application/x-gzip': 'application/gzip',
  'application/jsonl': 'application/x-ndjson',
};
export function recognizeFormat(filename: string, suppliedMime = ''): FileFormat {
  const ext = extname(filename).slice(1).toLowerCase();
  const name = basename(filename).toLowerCase();
  const byName =
    FILE_FORMATS.find((f) => f.extensions.includes(ext)) ??
    (['dockerfile', 'makefile', '.env', '.gitignore'].includes(name)
      ? FILE_FORMATS.find((f) => f.mime === 'text/plain')
      : undefined);
  const mime = suppliedMime.toLowerCase().split(';')[0].trim();
  // An extension is authoritative for ambiguous browser MIME labels. The parser
  // still verifies the actual bytes; recognizing a name never makes bytes safe.
  const format = byName ?? FILE_FORMATS.find((f) => f.mime === (aliases[mime] ?? mime));
  if (!format) throw new Error('Unsupported file format');
  return format;
}
export function decodeText(bytes: Buffer): string {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  if (text.includes('\0')) throw new Error('Binary content cannot be read as text');
  return text;
}
