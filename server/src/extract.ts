import { mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join, extname } from 'path';

export interface FileMeta {
  format: 'plain' | 'pdf' | 'docx' | 'odt' | 'xlsx' | 'ods' | 'html';
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
const PDF_PAGE_CAP = 100;
const DOC_IMAGE_CAP = 20;

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= TEXT_CAP) return { text, truncated: false };
  return { text: text.slice(0, TEXT_CAP) + '\n\n[Content truncated at 1,000,000 characters]', truncated: true };
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

  return extractPlain(bytes, mimeType);
}

async function extractPlain(bytes: Buffer, mimeType: string): Promise<ExtractionResult> {
  let raw: string;
  try {
    raw = bytes.toString('utf-8');
    // strip BOM
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  } catch {
    raw = bytes.toString('latin1');
  }
  const { text, truncated } = truncate(raw.trim() || '[File appears empty or has no extractable text]');
  return {
    text,
    meta: { format: 'plain', ...(truncated && { truncated: true }) },
    ...(truncated && { warning: 'Content truncated at 1,000,000 characters' }),
  };
}

async function extractHtml(bytes: Buffer): Promise<ExtractionResult> {
  const { parse } = await import('node-html-parser');
  let raw: string;
  try {
    raw = bytes.toString('utf-8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  } catch {
    raw = bytes.toString('latin1');
  }
  const root = parse(raw);
  // remove script and style nodes
  root.querySelectorAll('script, style').forEach(n => n.remove());
  const extracted = root.text.replace(/\s+/g, ' ').trim() || '[File appears empty or has no extractable text]';
  const { text, truncated } = truncate(extracted);
  return {
    text,
    meta: { format: 'html', ...(truncated && { truncated: true }) },
    ...(truncated && { warning: 'Content truncated at 1,000,000 characters' }),
  };
}

async function extractDocx(bytes: Buffer): Promise<ExtractionResult> {
  const mammoth = await import('mammoth');
  const result = await mammoth.extractRawText({ buffer: bytes });
  const raw = result.value.trim() || '[File appears empty or has no extractable text]';
  const { text, truncated } = truncate(raw);
  return {
    text,
    meta: { format: 'docx', ...(truncated && { truncated: true }) },
    ...(truncated && { warning: 'Content truncated at 1,000,000 characters' }),
  };
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
  const { text, truncated } = truncate(raw);
  return {
    text,
    meta: { format: 'odt', ...(truncated && { truncated: true }) },
    ...(truncated && { warning: 'Content truncated at 1,000,000 characters' }),
  };
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
  const { text, truncated } = truncate(raw);
  return {
    text,
    meta: { format, sheet_names: wb.SheetNames, ...(truncated && { truncated: true }) },
    ...(truncated && { warning: 'Content truncated at 1,000,000 characters' }),
  };
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
  format: 'docx' | 'odt',
): Promise<{ count: number; served: number; warning?: string }> {
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(bytes);
  const entries = zip.getEntries();

  const prefix = format === 'docx' ? 'word/media/' : 'Pictures/';
  const imageEntries = entries.filter(e =>
    e.entryName.startsWith(prefix) && !e.isDirectory
  );

  const count = imageEntries.length;
  if (count === 0) return { count: 0, served: 0 };

  const imagesDir = join(uploadsDir, 'doc-images', sha256);
  mkdirSync(imagesDir, { recursive: true });

  const served = Math.min(count, DOC_IMAGE_CAP);
  for (let i = 0; i < served; i++) {
    const entry = imageEntries[i];
    const ext = extname(entry.entryName) || '.bin';
    const padded = String(i + 1).padStart(3, '0');
    await writeFile(join(imagesDir, `img-${padded}${ext}`), entry.getData());
  }

  const warning = count > DOC_IMAGE_CAP
    ? `Showing first ${DOC_IMAGE_CAP} of ${count} embedded images`
    : undefined;

  return { count, served, warning };
}
