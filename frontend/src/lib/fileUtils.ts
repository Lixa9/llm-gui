export function fileIcon(mime: string | undefined): string {
  if (!mime) return '📃';
  if (mime === 'application/pdf') return '📄';
  if (mime.includes('spreadsheet') || mime.includes('excel') || mime === 'application/vnd.oasis.opendocument.spreadsheet') return '📊';
  if (mime.includes('wordprocessingml') || mime === 'application/vnd.oasis.opendocument.text') return '📝';
  if (mime === 'text/html') return '🌐';
  if (mime === 'application/epub+zip') return '📚';
  return '📃';
}
