import { mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join, extname } from 'path';

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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
  let raw = bytes.toString('utf-8');
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const extracted = stripHtml(raw) || '[File appears empty or has no extractable text]';
  const { text, warning } = truncate(extracted);
  return { text, meta: { format: 'html', ...(warning && { truncated: true }) }, ...(warning && { warning }) };
}

async function extractDocx(bytes: Buffer): Promise<ExtractionResult> {
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(bytes);
  const entry = zip.getEntry('word/document.xml');
  if (!entry) throw new Error('DOCX has no word/document.xml');
  const xml = entry.getData().toString('utf-8');
  const raw = xml
    .replace(/<w:p[ >]/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim() || '[File appears empty or has no extractable text]';
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
  const AdmZip = (await import('adm-zip')).default;

  if (mimeType === 'application/vnd.ms-excel') {
    // Legacy XLS binary format — not supported without a binary parser
    return { text: '[XLS binary format not supported — please convert to XLSX]', meta: { format: 'xlsx' } };
  }

  const zip = new AdmZip(bytes);
  const format = mimeType.includes('oasis') ? 'ods' : 'xlsx';

  if (format === 'ods') {
    // ODS: content.xml has <table:table table:name="…"> with <table:table-row> / <table:table-cell>
    const entry = zip.getEntry('content.xml');
    if (!entry) throw new Error('ODS has no content.xml');
    const xml = entry.getData().toString('utf-8');
    const sheetNames: string[] = [];
    const sections: string[] = [];

    for (const tableMatch of xml.matchAll(/<table:table\s[^>]*table:name="([^"]+)"[^>]*>([\s\S]*?)<\/table:table>/g)) {
      const sheetName = tableMatch[1];
      sheetNames.push(sheetName);
      const tableBody = tableMatch[2];
      const rows: string[] = [];
      for (const rowMatch of tableBody.matchAll(/<table:table-row[^>]*>([\s\S]*?)<\/table:table-row>/g)) {
        const cells: string[] = [];
        for (const cellMatch of rowMatch[1].matchAll(/<table:table-cell[^>]*>([\s\S]*?)<\/table:table-cell>/g)) {
          const val = cellMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
          cells.push(val.includes(',') ? `"${val.replace(/"/g, '""')}"` : val);
        }
        if (cells.some(c => c !== '')) rows.push(cells.join(','));
      }
      if (rows.length) sections.push(`=== Sheet: ${sheetName} ===\n${rows.join('\n')}`);
    }

    const raw = sections.join('\n\n').trim() || '[File appears empty or has no extractable text]';
    const { text, warning } = truncate(raw);
    return { text, meta: { format: 'ods', sheet_names: sheetNames, ...(warning && { truncated: true }) }, ...(warning && { warning }) };
  }

  // XLSX: xl/workbook.xml (sheet list), xl/sharedStrings.xml (string table), xl/worksheets/sheet*.xml
  const workbookEntry = zip.getEntry('xl/workbook.xml');
  if (!workbookEntry) throw new Error('XLSX has no xl/workbook.xml');
  const workbookXml = workbookEntry.getData().toString('utf-8');

  // Sheet name → rId mapping from workbook
  const sheetNames: string[] = [];
  const sheetRels: { name: string; rId: string }[] = [];
  for (const m of workbookXml.matchAll(/<sheet\s[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    sheetNames.push(m[1]);
    sheetRels.push({ name: m[1], rId: m[2] });
  }

  // rId → target path from xl/_rels/workbook.xml.rels
  const relsEntry = zip.getEntry('xl/_rels/workbook.xml.rels');
  const relsXml = relsEntry ? relsEntry.getData().toString('utf-8') : '';
  const relMap = new Map<string, string>();
  for (const m of relsXml.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    relMap.set(m[1], m[2]);
  }

  // Shared strings
  const ssEntry = zip.getEntry('xl/sharedStrings.xml');
  const sharedStrings: string[] = [];
  if (ssEntry) {
    const ssXml = ssEntry.getData().toString('utf-8');
    for (const m of ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      sharedStrings.push(m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
    }
  }

  const sections: string[] = [];
  for (const { name, rId } of sheetRels) {
    const target = relMap.get(rId);
    if (!target) continue;
    const wsPath = target.startsWith('worksheets/') ? `xl/${target}` : target;
    const wsEntry = zip.getEntry(wsPath);
    if (!wsEntry) continue;
    const wsXml = wsEntry.getData().toString('utf-8');

    // Collect cell addresses and values to build a 2D grid
    const cellMap = new Map<string, string>();
    let maxRow = 0, maxCol = 0;
    for (const m of wsXml.matchAll(/<c r="([A-Z]+)(\d+)"(?:\s[^>]*)?\s*t="([^"]*)"[^>]*>[\s\S]*?<v>([\s\S]*?)<\/v>/g)) {
      const col = colIndex(m[1]), row = parseInt(m[2], 10) - 1;
      const t = m[3], raw = m[4];
      const val = t === 's' ? (sharedStrings[parseInt(raw, 10)] ?? '') : raw;
      cellMap.set(`${row}:${col}`, val);
      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;
    }
    // Also handle cells with no explicit type (numeric)
    for (const m of wsXml.matchAll(/<c r="([A-Z]+)(\d+)"(?:\s[^>]*)?>[^<]*<v>([\s\S]*?)<\/v>/g)) {
      const col = colIndex(m[1]), row = parseInt(m[2], 10) - 1;
      const key = `${row}:${col}`;
      if (!cellMap.has(key)) cellMap.set(key, m[3]);
      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;
    }

    const rows: string[] = [];
    for (let r = 0; r <= maxRow; r++) {
      const cells: string[] = [];
      for (let c = 0; c <= maxCol; c++) {
        const v = cellMap.get(`${r}:${c}`) ?? '';
        cells.push(v.includes(',') ? `"${v.replace(/"/g, '""')}"` : v);
      }
      if (cells.some(c => c !== '')) rows.push(cells.join(','));
    }
    if (rows.length) sections.push(`=== Sheet: ${name} ===\n${rows.join('\n')}`);
  }

  const raw = sections.join('\n\n').trim() || '[File appears empty or has no extractable text]';
  const { text, warning } = truncate(raw);
  return { text, meta: { format: 'xlsx', sheet_names: sheetNames, ...(warning && { truncated: true }) }, ...(warning && { warning }) };
}

function colIndex(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

async function extractEpub(bytes: Buffer): Promise<ExtractionResult> {
  const AdmZip = (await import('adm-zip')).default;
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
    const text = stripHtml(html);
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
