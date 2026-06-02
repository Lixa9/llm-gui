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

interface XmlTag {
  name: string;
  isEnd: boolean;
  selfClosing?: boolean;
  attributes: Record<string, string>;
}

interface XmlToken {
  type: 'tag' | 'text';
  tag?: XmlTag;
  text?: string;
}

function parseXml(xml: string): XmlToken[] {
  const tokens: XmlToken[] = [];
  let i = 0;
  while (i < xml.length) {
    const start = xml.indexOf('<', i);
    if (start === -1) {
      const text = xml.slice(i);
      if (text.trim()) tokens.push({ type: 'text', text: text.trim() });
      break;
    }
    if (start > i) {
      const text = xml.slice(i, start);
      if (text.trim()) tokens.push({ type: 'text', text: text.trim() });
    }
    const end = xml.indexOf('>', start);
    if (end === -1) break;
    const rawTag = xml.slice(start + 1, end);
    i = end + 1;

    if (rawTag.startsWith('?') || rawTag.startsWith('!')) continue;

    const isEnd = rawTag.startsWith('/');
    const selfClosing = rawTag.endsWith('/');
    const cleanTag = isEnd ? rawTag.slice(1) : selfClosing ? rawTag.slice(0, -1) : rawTag;
    
    const trimmed = cleanTag.trim();
    const firstSpace = trimmed.search(/\s/);
    let name = '';
    const attributes: Record<string, string> = {};
    if (firstSpace === -1) {
      name = trimmed;
    } else {
      name = trimmed.slice(0, firstSpace);
      const attrStr = trimmed.slice(firstSpace).trim();
      const attrRegex = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
      let match;
      while ((match = attrRegex.exec(attrStr)) !== null) {
        const key = match[1];
        const val = match[2] ?? match[3] ?? match[4] ?? '';
        attributes[key] = val;
      }
    }

    tokens.push({
      type: 'tag',
      tag: { name, isEnd, selfClosing, attributes }
    });
  }
  return tokens;
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

  const tokens = parseXml(xml);
  let text = '';
  let inTextTag = false;
  for (const token of tokens) {
    if (token.type === 'tag' && token.tag) {
      if (token.tag.name === 'w:t' && !token.tag.isEnd) inTextTag = true;
      if (token.tag.name === 'w:t' && token.tag.isEnd) inTextTag = false;
      if (token.tag.name === 'w:p' && !token.tag.isEnd) text += '\n';
    } else if (token.type === 'text' && inTextTag && token.text) {
      text += token.text + ' ';
    }
  }

  const raw = text.replace(/\s+/g, ' ').trim() || '[File appears empty or has no extractable text]';
  const { text: truncatedText, warning } = truncate(raw);
  return { text: truncatedText, meta: { format: 'docx', ...(warning && { truncated: true }) }, ...(warning && { warning }) };
}

async function extractOdt(bytes: Buffer): Promise<ExtractionResult> {
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(bytes);
  const entry = zip.getEntry('content.xml');
  if (!entry) throw new Error('ODT file has no content.xml');
  const xml = entry.getData().toString('utf-8');

  const tokens = parseXml(xml);
  let text = '';
  let inP = false;
  for (const token of tokens) {
    if (token.type === 'tag' && token.tag) {
      if (token.tag.name === 'text:p' && !token.tag.isEnd) { inP = true; text += '\n'; }
      if (token.tag.name === 'text:p' && token.tag.isEnd) inP = false;
    } else if (token.type === 'text' && inP && token.text) {
      text += token.text + ' ';
    }
  }

  const raw = text.replace(/\s+/g, ' ').trim() || '[File appears empty or has no extractable text]';
  const { text: truncatedText, warning } = truncate(raw);
  return { text: truncatedText, meta: { format: 'odt', ...(warning && { truncated: true }) }, ...(warning && { warning }) };
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
    const tokens = parseXml(xml);
    const sheetNames: string[] = [];
    const sections: string[] = [];

    let currentSheetName = '';
    let sheetRows: string[] = [];
    let currentRowCells: string[] = [];
    let currentCellText = '';
    let inCell = false;
    let cellRepeated = 1;

    for (const token of tokens) {
      if (token.type === 'tag' && token.tag) {
        const { name, isEnd, attributes } = token.tag;
        if (name === 'table:table') {
          if (!isEnd) {
            currentSheetName = attributes['table:name'] || '';
            sheetNames.push(currentSheetName);
            sheetRows = [];
          } else {
            if (sheetRows.length > 0) {
              sections.push(`=== Sheet: ${currentSheetName} ===\n${sheetRows.join('\n')}`);
            }
          }
        } else if (name === 'table:table-row') {
          if (!isEnd) {
            currentRowCells = [];
          } else {
            if (currentRowCells.some(c => c !== '')) {
              let lastNonEmpty = currentRowCells.length - 1;
              while (lastNonEmpty >= 0 && currentRowCells[lastNonEmpty] === '') {
                lastNonEmpty--;
              }
              const rowJoined = currentRowCells.slice(0, lastNonEmpty + 1).join(',');
              sheetRows.push(rowJoined);
            }
          }
        } else if (name === 'table:table-cell') {
          if (!isEnd) {
            inCell = true;
            currentCellText = '';
            const rep = attributes['table:number-columns-repeated'];
            cellRepeated = rep ? Math.min(parseInt(rep, 10), 100) : 1;
          } else {
            inCell = false;
            const val = currentCellText.replace(/\s+/g, ' ').trim();
            const formatted = val.includes(',') ? `"${val.replace(/"/g, '""')}"` : val;
            for (let k = 0; k < cellRepeated; k++) {
              currentRowCells.push(formatted);
            }
          }
        }
      } else if (token.type === 'text' && inCell && token.text) {
        currentCellText += token.text + ' ';
      }
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
  const workbookTokens = parseXml(workbookXml);
  for (const token of workbookTokens) {
    if (token.type === 'tag' && token.tag && token.tag.name === 'sheet' && !token.tag.isEnd) {
      const name = token.tag.attributes['name'] || '';
      const rId = token.tag.attributes['r:id'] || token.tag.attributes['id'] || '';
      if (name && rId) {
        sheetNames.push(name);
        sheetRels.push({ name, rId });
      }
    }
  }

  // rId → target path from xl/_rels/workbook.xml.rels
  const relsEntry = zip.getEntry('xl/_rels/workbook.xml.rels');
  const relsXml = relsEntry ? relsEntry.getData().toString('utf-8') : '';
  const relMap = new Map<string, string>();
  if (relsXml) {
    const relsTokens = parseXml(relsXml);
    for (const token of relsTokens) {
      if (token.type === 'tag' && token.tag && token.tag.name === 'Relationship' && !token.tag.isEnd) {
        const id = token.tag.attributes['Id'] || '';
        const target = token.tag.attributes['Target'] || '';
        if (id && target) {
          relMap.set(id, target);
        }
      }
    }
  }

  // Shared strings
  const ssEntry = zip.getEntry('xl/sharedStrings.xml');
  const sharedStrings: string[] = [];
  if (ssEntry) {
    const ssXml = ssEntry.getData().toString('utf-8');
    const ssTokens = parseXml(ssXml);
    let currentString = '';
    let inSi = false;
    let inT = false;
    for (const token of ssTokens) {
      if (token.type === 'tag' && token.tag) {
        const { name, isEnd } = token.tag;
        if (name === 'si') {
          if (!isEnd) {
            inSi = true;
            currentString = '';
          } else {
            inSi = false;
            sharedStrings.push(currentString.replace(/\s+/g, ' ').trim());
          }
        } else if (name === 't') {
          inT = !isEnd;
        }
      } else if (token.type === 'text' && inSi && inT && token.text) {
        currentString += token.text;
      }
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

    const wsTokens = parseXml(wsXml);
    let currentCellRef = '';
    let currentCellType = '';
    let inV = false;
    let currentVal = '';

    const commitCell = () => {
      if (currentCellRef) {
        const match = currentCellRef.match(/^([A-Z]+)(\d+)$/);
        if (match) {
          const col = colIndex(match[1]);
          const row = parseInt(match[2], 10) - 1;
          let val = '';
          if (currentCellType === 's') {
            const idx = parseInt(currentVal, 10);
            val = sharedStrings[idx] ?? '';
          } else {
            val = currentVal;
          }
          cellMap.set(`${row}:${col}`, val);
          if (row > maxRow) maxRow = row;
          if (col > maxCol) maxCol = col;
        }
      }
      currentCellRef = '';
      currentCellType = '';
      currentVal = '';
    };

    for (const token of wsTokens) {
      if (token.type === 'tag' && token.tag) {
        const { name: tagName, isEnd, selfClosing, attributes } = token.tag;
        if (tagName === 'c') {
          if (!isEnd) {
            currentCellRef = attributes['r'] || '';
            currentCellType = attributes['t'] || '';
            currentVal = '';
            if (selfClosing) {
              commitCell();
            }
          } else {
            commitCell();
          }
        } else if (tagName === 'v') {
          inV = !isEnd;
        }
      } else if (token.type === 'text' && inV && token.text) {
        currentVal += token.text;
      }
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

  const containerTokens = parseXml(containerXml);
  let opfPath = '';
  for (const token of containerTokens) {
    if (token.type === 'tag' && token.tag && token.tag.name === 'rootfile') {
      opfPath = token.tag.attributes['full-path'] || '';
      if (opfPath) break;
    }
  }
  if (!opfPath) throw new Error('EPUB container.xml has no rootfile full-path');

  const opfBase = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  const opfEntry = zip.getEntry(opfPath);
  if (!opfEntry) throw new Error(`EPUB OPF not found: ${opfPath}`);
  const opfXml = opfEntry.getData().toString('utf-8');

  // Parse manifest and spine via parseXml
  const manifest = new Map<string, { href: string; mediaType: string }>();
  const spineIds: string[] = [];
  const opfTokens = parseXml(opfXml);
  for (const token of opfTokens) {
    if (token.type === 'tag' && token.tag) {
      const { name, attributes } = token.tag;
      if (name === 'item') {
        const id = attributes['id'];
        const href = attributes['href'];
        const mediaType = attributes['media-type'] || '';
        if (id && href) manifest.set(id, { href, mediaType });
      } else if (name === 'itemref') {
        const idref = attributes['idref'];
        if (idref) spineIds.push(idref);
      }
    }
  }

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
    const containerTokens = parseXml(containerXml);
    let opfPath = '';
    for (const token of containerTokens) {
      if (token.type === 'tag' && token.tag && token.tag.name === 'rootfile') {
        opfPath = token.tag.attributes['full-path'] || '';
        if (opfPath) break;
      }
    }
    const opfBase = opfPath?.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
    const opfXml = opfPath ? (zip.getEntry(opfPath)?.getData().toString('utf-8') ?? '') : '';

    const imageEntriesList: { data: Buffer; ext: string }[] = [];
    if (opfXml) {
      const opfTokens = parseXml(opfXml);
      for (const token of opfTokens) {
        if (token.type === 'tag' && token.tag && token.tag.name === 'item') {
          const href = token.tag.attributes['href'];
          const mediaType = token.tag.attributes['media-type'] || '';
          if (href && mediaType.startsWith('image/')) {
            const entry = zip.getEntry(opfBase + href) ?? zip.getEntry(href);
            if (entry) {
              const ext = mediaType === 'image/png' ? '.png' : mediaType === 'image/gif' ? '.gif' : mediaType === 'image/webp' ? '.webp' : '.jpg';
              imageEntriesList.push({ data: entry.getData(), ext });
            }
          }
        }
      }
    }
    imageEntries = imageEntriesList;
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
