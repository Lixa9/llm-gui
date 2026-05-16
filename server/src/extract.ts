import { mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join, extname } from 'path';

export interface FileMeta {
  format: 'plain' | 'pdf' | 'docx' | 'odt' | 'xlsx' | 'ods' | 'html' | 'epub';
  page_count?: number;
  served_pages?: number;
  sheet_names?: string[];
  embedded_image_count?: number;
  served_image_count?: number;
  truncated?: boolean;
}

export interface ExtractionResult {
  text: string | null;
  meta: FileMeta;
  warning?: string;
}

const TEXT_CAP = 1_000_000;
export const PDF_PAGE_CAP = 100;
const DOC_IMAGE_CAP = 20;

function truncate(text: string): { text: string; warning?: string } {
  if (text.length <= TEXT_CAP) return { text };
  return {
    text: text.slice(0, TEXT_CAP) + '\n\n[Content truncated at 1,000,000 characters]',
    warning: 'Content truncated at 1,000,000 characters',
  };
}

export async function extractText(bytes: Buffer, mimeType: string): Promise<ExtractionResult> {
  if (mimeType === 'application/pdf') {
    return { text: null, meta: { format: 'pdf' } };
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    return extractDocx(bytes);
  }

  if (mimeType === 'application/vnd.oasis.opendocument.text') {
    return extractOdt(bytes);
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.ms-excel' ||
    mimeType === 'application/vnd.oasis.opendocument.spreadsheet'
  ) {
    return extractSpreadsheet(bytes, mimeType);
  }

  if (mimeType === 'text/html') {
    return extractHtml(bytes);
  }

  if (mimeType === 'application/epub+zip') {
    return extractEpub(bytes);
  }

  return extractPlain(bytes, mimeType);
}

async function extractPlain(bytes: Buffer, mimeType: string): Promise<ExtractionResult> {
  let raw = bytes.toString('utf-8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const { text, warning } = truncate(raw.trim() || '[File appears empty or has no extractable text]');
  return { text, meta: { format: 'plain', ...(warning && { truncated: true }) }, ...(warning && { warning }) };
}

async function extractHtml(bytes: Buffer): Promise<ExtractionResult> {
  const { parse } = await import('node-html-parser');
  let raw = bytes.toString('utf-8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const root = parse(raw);
  root.querySelectorAll('script, style').forEach(n => n.remove());
  const extracted = root.text.replace(/\s+/g, ' ').trim() || '[File appears empty or has no extractable text]';
  const { text, warning } = truncate(extracted);
  return { text, meta: { format: 'html', ...(warning && { truncated: true }) }, ...(warning && { warning }) };
}

async function extractDocx(bytes: Buffer): Promise<ExtractionResult> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer: bytes });
  const raw = result.value.trim() || '[File appears empty or has no extractable text]';
  const { text, warning } = truncate(raw);
  return { text, meta: { format: 'docx', ...(warning && { truncated: true }) }, ...(warning && { warning }) };
}

async function extractOdt(bytes: Buffer): Promise<ExtractionResult> {
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(bytes);
  const entry = zip.getEntry('content.xml');
  if (!entry) throw new Error('ODT file has no content.xml');
  const xml = entry.getData().toString('utf-8');
  const raw = xml
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || '[File appears empty or has no extractable text]';
  const { text, warning } = truncate(raw);
  return { text, meta: { format: 'odt', ...(warning && { truncated: true }) }, ...(warning && { warning }) };
}

async function extractSpreadsheet(bytes: Buffer, mimeType: string): Promise<ExtractionResult> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(bytes, { type: 'buffer' });
  const format = mimeType.includes('oasis') ? 'ods' : 'xlsx';
  const sections = wb.SheetNames.map(name => {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
    return `=== Sheet: ${name} ===\n${csv}`;
  });
  const raw = sections.join('\n\n').trim() || '[File appears empty or has no extractable text]';
  const { text, warning } = truncate(raw);
  return { text, meta: { format, sheet_names: wb.SheetNames, ...(warning && { truncated: true }) }, ...(warning && { warning }) };
}

async function extractEpub(bytes: Buffer): Promise<ExtractionResult> {
  const AdmZip = (await import('adm-zip')).default;
  const { parse } = await import('node-html-parser');
  const zip = new AdmZip(bytes);

  // Locate OPF file via META-INF/container.xml
  const containerEntry = zip.getEntry('META-INF/container.xml');
  if (!containerEntry) throw new Error('EPUB missing META-INF/container.xml');
  const containerXml = containerEntry.getData().toString('utf-8');
  const opfPath = containerXml.match(/full-path="([^"]+)"/)?.[1];
  if (!opfPath) throw new Error('EPUB container.xml has no rootfile full-path');

  const opfBase = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const opfEntry = zip.getEntry(opfPath);
  if (!opfEntry) throw new Error(`EPUB OPF not found: ${opfPath}`);
  const opfXml = opfEntry.getData().toString('utf-8');

  // Parse manifest: id → { href, mediaType }
  const manifest = new Map<string, { href: string; mediaType: string }>();
  for (const item of opfXml.match(/<item\s[^>]+>/g) ?? []) {
    const id = item.match(/\bid="([^"]+)"/)?.[1];
    const href = item.match(/\bhref="([^"]+)"/)?.[1];
    const mediaType = item.match(/\bmedia-type="([^"]+)"/)?.[1] ?? '';
    if (id && href) manifest.set(id, { href, mediaType });
  }

  // Parse spine: ordered idrefs
  const spineIds = [...opfXml.matchAll(/\bidref="([^"]+)"/g)].map(m => m[1]);

  // Extract text from spine HTML files in order
  const textParts: string[] = [];
  for (const idref of spineIds) {
    const item = manifest.get(idref);
    if (!item) continue;
    const entryPath = opfBase + item.href;
    const entry = zip.getEntry(entryPath) ?? zip.getEntry(item.href);
    if (!entry) continue;
    const html = entry.getData().toString('utf-8');
    const root = parse(html);
    root.querySelectorAll('script, style').forEach(n => n.remove());
    const text = root.text.replace(/\s+/g, ' ').trim();
    if (text) textParts.push(text);
  }

  const raw = textParts.join('\n\n').trim() || '[File appears empty or has no extractable text]';
  const { text, warning } = truncate(raw);
  return { text, meta: { format: 'epub', ...(warning && { truncated: true }) }, ...(warning && { warning }) };
}

export async function renderPdfPages(
  bytes: Buffer,
  sha256: string,
  uploadsDir: string,
): Promise<{ page_count: number; served: number; warning?: string }> {
  const mupdf = (await import('mupdf')).default;

  const pagesDir = join(uploadsDir, 'pdf-pages', sha256);
  mkdirSync(pagesDir, { recursive: true });

  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
  const page_count = doc.countPages();
  const served = Math.min(page_count, PDF_PAGE_CAP);
  const matrix = mupdf.Matrix.scale(150 / 72, 150 / 72);

  for (let i = 0; i < served; i++) {
    const page = doc.loadPage(i);
    const pixmap = page.toPixmap(matrix, mupdf.ColorSpace.DeviceRGB, false);
    const padded = String(i + 1).padStart(3, '0');
    await writeFile(join(pagesDir, `page-${padded}.jpg`), Buffer.from(pixmap.asJPEG(85)));
    pixmap.destroy();
    page.destroy();
  }
  doc.destroy();

  return {
    page_count,
    served,
    warning: page_count > PDF_PAGE_CAP ? `Showing first ${PDF_PAGE_CAP} of ${page_count} pages` : undefined,
  };
}

export async function extractDocImages(
  bytes: Buffer,
  sha256: string,
  uploadsDir: string,
  format: 'docx' | 'odt' | 'epub',
): Promise<{ count: number; served: number; warning?: string }> {
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(bytes);

  let imageEntries: { data: Buffer; ext: string }[];

  if (format === 'epub') {
    // Discover images via OPF manifest (handles any directory layout)
    const containerXml = zip.getEntry('META-INF/container.xml')?.getData().toString('utf-8') ?? '';
    const opfPath = containerXml.match(/full-path="([^"]+)"/)?.[1];
    const opfBase = opfPath?.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    const opfXml = opfPath ? (zip.getEntry(opfPath)?.getData().toString('utf-8') ?? '') : '';

    imageEntries = (opfXml.match(/<item\s[^>]+>/g) ?? [])
      .flatMap(item => {
        const href = item.match(/\bhref="([^"]+)"/)?.[1];
        const mediaType = item.match(/\bmedia-type="(image\/[^"]+)"/)?.[1];
        if (!href || !mediaType) return [];
        const entry = zip.getEntry(opfBase + href) ?? zip.getEntry(href);
        if (!entry) return [];
        const ext = mediaType === 'image/png' ? '.png' : mediaType === 'image/gif' ? '.gif' : mediaType === 'image/webp' ? '.webp' : '.jpg';
        return [{ data: entry.getData(), ext }];
      });
  } else {
    const prefix = format === 'docx' ? 'word/media/' : 'Pictures/';
    imageEntries = zip.getEntries()
      .filter(e => e.entryName.startsWith(prefix) && !e.isDirectory)
      .map(e => ({ data: e.getData(), ext: extname(e.entryName) || '.bin' }));
  }

  const count = imageEntries.length;
  if (count === 0) return { count: 0, served: 0 };

  const imagesDir = join(uploadsDir, 'doc-images', sha256);
  mkdirSync(imagesDir, { recursive: true });

  const served = Math.min(count, DOC_IMAGE_CAP);
  for (let i = 0; i < served; i++) {
    const { data, ext } = imageEntries[i];
    const padded = String(i + 1).padStart(3, '0');
    await writeFile(join(imagesDir, `img-${padded}${ext}`), data);
  }

  return {
    count,
    served,
    warning: count > DOC_IMAGE_CAP ? `Showing first ${DOC_IMAGE_CAP} of ${count} embedded images` : undefined,
  };
}
