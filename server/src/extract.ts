import { extname, posix } from 'path';
import { decodeText } from './formats.ts';
import { limitBlocks, textPrefix } from './content-blocks.ts';
import type { AttachmentBlock } from './processing.ts';

const MAX_ARCHIVE_ENTRIES = 2_000;
const MAX_ARCHIVE_EXPANDED_BYTES = 64 * 1024 * 1024;

export function assertArchiveBudget(zip: { getEntries(): Array<{ header?: { size?: number } }> }): void {
  const entries = zip.getEntries();
  if (entries.length > MAX_ARCHIVE_ENTRIES) throw new Error('Archive contains too many entries');
  const expanded = entries.reduce((sum, entry) => sum + (entry.header?.size ?? 0), 0);
  if (expanded > MAX_ARCHIVE_EXPANDED_BYTES) throw new Error('Archive expands beyond the allowed size');
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, value => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' }[value] ?? value))
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
  format: string;
  page_count?: number;
  served_pages?: number;
  sheet_names?: string[];
  embedded_image_count?: number;
  served_image_count?: number;
  truncated?: boolean;
  epub_image_locations?: Record<string, string[]>;
}

export interface ExtractionResult {
  text: string | null;
  meta: FileMeta;
  warning?: string;
  blocks?: AttachmentBlock[];
}

const TEXT_CAP = 1_000_000;
export const PDF_PAGE_CAP = 100;
const DOC_IMAGE_CAP = 20;

function truncate(text: string): { text: string; warning?: string } {
  if (text.length <= TEXT_CAP) return { text };
  return {
    text: textPrefix(text, TEXT_CAP),
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

  return extractPlain(bytes);
}

async function extractPlain(bytes: Buffer): Promise<ExtractionResult> {
  let raw = decodeText(bytes);
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const { text, warning } = truncate(raw);
  return { text, meta: { format: 'plain', ...(warning && { truncated: true }) }, ...(warning && { warning }) };
}

async function extractHtml(bytes: Buffer): Promise<ExtractionResult> {
  let raw = decodeText(bytes);
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const extracted = stripHtml(raw);
  const { text, warning } = truncate(extracted);
  return { text, meta: { format: 'html', ...(warning && { truncated: true }) }, ...(warning && { warning }) };
}

async function extractDocx(bytes: Buffer): Promise<ExtractionResult> {
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(bytes);
  assertArchiveBudget(zip);
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
      if (token.tag.name === 'w:tc' && token.tag.isEnd) text += '\t';
      if (token.tag.name === 'w:tr' && token.tag.isEnd) text += '\n';
    } else if (token.type === 'text' && inTextTag && token.text) {
      text += token.text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    }
  }

  const raw = text.replace(/[ \t]+/g, ' ').trim() || '[File appears empty or has no extractable text]';
  const { text: truncatedText, warning } = truncate(raw);
  return { text: truncatedText, meta: { format: 'docx', ...(warning && { truncated: true }) }, ...(warning && { warning }) };
}

async function extractOdt(bytes: Buffer): Promise<ExtractionResult> {
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(bytes);
  assertArchiveBudget(zip);
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
      text += token.text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    }
  }

  const raw = text.replace(/[ \t]+/g, ' ').trim() || '[File appears empty or has no extractable text]';
  const { text: truncatedText, warning } = truncate(raw);
  return { text: truncatedText, meta: { format: 'odt', ...(warning && { truncated: true }) }, ...(warning && { warning }) };
}

async function extractSpreadsheet(bytes: Buffer, mimeType: string): Promise<ExtractionResult> {
  const AdmZip = (await import('adm-zip')).default;

  if (mimeType === 'application/vnd.ms-excel') {
    // Legacy XLS binary format — not supported without a binary parser
    throw new Error('XLS must first be converted to XLSX');
  }

  const zip = new AdmZip(bytes);
  assertArchiveBudget(zip);
  const format = mimeType.includes('oasis') ? 'ods' : 'xlsx';

  if (format === 'ods') {
    const entry=zip.getEntry('content.xml');if(!entry)throw new Error('ODS has no content.xml');
    const xml=entry.getData().toString('utf8'),sheetNames:string[]=[],blocks:AttachmentBlock[]=[];
    const warnings: string[] = [];
    const attr=(tag:string,key:string)=>decodeEntities(tag.match(new RegExp(`${key}=["']([^"']*)["']`))?.[1] ?? '');
    for(const table of xml.matchAll(/<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g)){
      const name=attr(table[1],'table:name');sheetNames.push(name);const rows:string[]=[];
      let emptyRows = 0;
      for(const row of table[2].matchAll(/<table:table-row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-row>)/g)){
        const cells:string[]=[];
        for(const cell of (row[2] ?? '').matchAll(/<table:(?:table-cell|covered-table-cell)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g)){
          const value=decodeEntities((cell[2] ?? '').replace(/<\/text:p>/g,'\n').replace(/<[^>]+>/g,'').trim()) || attr(cell[1],'office:string-value') || attr(cell[1],'office:date-value') || attr(cell[1],'office:time-value') || attr(cell[1],'office:boolean-value') || attr(cell[1],'office:value');
          const repeat=Number(attr(cell[1],'table:number-columns-repeated') || '1');
          if(!Number.isSafeInteger(repeat) || repeat<1)throw new Error('Invalid repeated spreadsheet column');
          // Empty trailing repeated columns can span the full ODS grid without allocating it.
          if(!value && repeat>256)break;
          if(cells.length+repeat>256)throw new Error('Spreadsheet exceeds 256 columns');
          for(let i=0;i<repeat;i++)cells.push(/[,\n"]/.test(value)?`"${value.replace(/"/g,'""')}"`:value);
        }
        const repeat=Number(attr(row[1],'table:number-rows-repeated') || '1');
        if(!Number.isSafeInteger(repeat) || repeat<1)throw new Error('Invalid repeated spreadsheet row');
        if(!cells.some(Boolean)){ emptyRows += repeat; continue; }
        if(rows.length+emptyRows+repeat>10000)throw new Error('Spreadsheet exceeds 10,000 rows');
        while(emptyRows > 0){ rows.push(''); emptyRows--; }
        while(cells.at(-1)==='')cells.pop();
        for(let i=0;i<repeat;i++)rows.push(cells.join(','));
      }
      blocks.push({type:'text', text:rows.join('\n'), format:'csv', part:`Sheet: ${name}`});
      if(/table:formula=/.test(table[2]))warnings.push('Formula results are taken from stored values; formulas are not recalculated.');
    }
    return spreadsheetResult(blocks, sheetNames, 'ods', warnings);
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

  const stylesXml=zip.getEntry('xl/styles.xml')?.getData().toString('utf8') ?? '';
  const formats=new Map<number,string>();
  for(const token of parseXml(stylesXml))if(token.tag?.name==='numFmt' && !token.tag.isEnd)formats.set(Number(token.tag.attributes.numFmtId),decodeEntities(token.tag.attributes.formatCode ?? ''));
  const cellStyles=(stylesXml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1].match(/<xf\b[^>]*>/g) ?? []).map(tag=>Number(tag.match(/numFmtId=["'](\d+)["']/)?.[1] ?? 0));
  const date1904=/date1904=["'](?:1|true)["']/.test(workbookXml);
  const blocks: AttachmentBlock[] = [];
  let formulas = 0, missingFormulaValues = 0;
  for (const { name, rId } of sheetRels) {
    const target = relMap.get(rId);
    if (!target) { blocks.push({type:'text',text:'',part:`Sheet: ${name}`,notices:['Sheet relationship is missing.']}); continue; }
    const wsPath = target.startsWith('/') ? target.slice(1) : target.startsWith('xl/') ? target : `xl/${target}`;
    const wsEntry = zip.getEntry(wsPath);
    if (!wsEntry) { blocks.push({type:'text',text:'',part:`Sheet: ${name}`,notices:['Sheet data is missing.']}); continue; }
    const wsXml = wsEntry.getData().toString('utf-8');

    // Collect cell addresses and values to build a 2D grid
    const cellMap = new Map<string, string>();
    let maxRow = 0, maxCol = 0;

    const wsTokens = parseXml(wsXml);
    let currentCellRef = '';
    let currentCellType = '';
    let currentStyle=0;
    let hasFormula = false;
    let inV = false;
    let currentVal = '';

    const commitCell = () => {
      if (currentCellRef) {
        const match = currentCellRef.match(/^([A-Z]+)(\d+)$/);
        if (match) {
          const col = colIndex(match[1]);
          const row = parseInt(match[2], 10) - 1;
          if (row >= 10000 || col >= 256 || cellMap.size >= 100000) throw new Error('Spreadsheet exceeds 10,000 rows, 256 columns, or 100,000 cells');
          if (hasFormula) { formulas++; if (!currentVal) missingFormulaValues++; }
          let val = '';
          if (currentCellType === 's') {
            const idx = parseInt(currentVal, 10);
            val = decodeEntities(sharedStrings[idx] ?? '');
          } else {
            val = currentCellType==='b' ? (currentVal==='1'?'true':'false') : currentCellType==='inlineStr'?decodeEntities(currentVal):formatCell(currentVal,cellStyles[currentStyle] ?? 0,formats,date1904);
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
            currentStyle=Number(attributes.s ?? 0);
            hasFormula = false;
            currentVal = '';
            if (selfClosing) {
              commitCell();
            }
          } else {
            commitCell();
          }
        } else if (tagName === 'f' && !isEnd) {
          hasFormula = true;
        } else if (tagName === 'v' || (tagName === 't' && currentCellType === 'inlineStr')) {
          inV = !isEnd;
        }
      } else if (token.type === 'text' && inV && token.text) {
        currentVal += token.text;
      }
    }

    if ((maxRow + 1) * (maxCol + 1) > 250000) throw new Error('Spreadsheet used range exceeds 250,000 cells');
    const rows: string[] = [];
    for (let r = 0; r <= maxRow; r++) {
      const cells: string[] = [];
      for (let c = 0; c <= maxCol; c++) {
        const v = cellMap.get(`${r}:${c}`) ?? '';
        cells.push(/[,\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
      }
      if (cellMap.size) rows.push(cells.join(','));
    }
    blocks.push({type:'text',text:rows.join('\n'),format:'csv',part:`Sheet: ${name}`});
  }

  const warnings = formulas ? ['Formula results are taken from stored values; formulas are not recalculated.'] : [];
  if (missingFormulaValues) warnings.push(`${missingFormulaValues} formula cells have no cached result.`);
  return spreadsheetResult(blocks, sheetNames, 'xlsx', warnings);
}

function spreadsheetResult(blocks: AttachmentBlock[], names: string[], format: string, warnings: string[]): ExtractionResult {
  const limited = limitBlocks(blocks, TEXT_CAP);
  if (limited.truncated) warnings.push('Text truncated at 1,000,000 characters.');
  if (!blocks.some(block => block.type === 'text' && block.text)) warnings.push('Workbook has no readable cells.');
  const warning = [...new Set(warnings)].join('; ') || undefined;
  return {
    text: limited.blocks.map(block => block.type === 'text' ? block.text : '').join('\n\n'),
    blocks: limited.blocks,
    meta: {format, sheet_names:names, ...(limited.truncated && {truncated:true})},
    warning,
  };
}

function decodeEntities(value:string):string {
  return value.replace(/&(?:amp|lt|gt|quot|apos);|&#(?:x[0-9a-f]+|[0-9]+);/gi,entity=>{
    const predefined:Record<string,string>={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"};
    if(predefined[entity])return predefined[entity];
    const point=parseInt(entity.slice(entity[2]==='x'?3:2,-1),entity[2]==='x'?16:10);
    return point>0 && point<=0x10ffff?String.fromCodePoint(point):entity;
  });
}
function formatCell(value:string,id:number,formats:Map<number,string>,date1904:boolean):string {
  if(value==='' || !Number.isFinite(Number(value)))return value;
  const numeric=Number(value),format=formats.get(id) ?? '';
  const dateFormat=(id>=14 && id<=22)||(id>=27 && id<=36)||(id>=45 && id<=47)||/[ymdhis]/i.test(format.replace(/"[^"']*"|\[[^\]]*\]/g,''));
  if(dateFormat){
    if(!date1904 && numeric===60)return '1900-02-29';
    const epoch=date1904?Date.UTC(1904,0,1):Date.UTC(1899,11,numeric<60?31:30);
    const date=new Date(epoch+numeric*86400000);
    return Number.isFinite(date.getTime())?date.toISOString().replace('T',' ').replace(/(?: 00:00:00\.000Z|\.000Z)$/,''):value;
  }
  if(id===9 || id===10 || format.includes('%'))return `${(numeric*100).toFixed(id===9?0:2)}%`;
  return value;
}

function colIndex(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

async function extractEpub(bytes: Buffer): Promise<ExtractionResult> {
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(bytes);
  assertArchiveBudget(zip);

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
  const textParts: string[] = [], blocks: AttachmentBlock[] = [];
  const imageLocations: Record<string,string[]> = Object.create(null);
  let missingChapters = 0, externalImages = 0;
  for (const [index, idref] of spineIds.entries()) {
    const item = manifest.get(idref);
    if (!item) { missingChapters++; continue; }
    const entryPath = posix.normalize(opfBase + item.href);
    const entry = zip.getEntry(entryPath) ?? zip.getEntry(item.href);
    if (!entry) { missingChapters++; continue; }
    const html = entry.getData().toString('utf-8');
    const text = stripHtml(html);
    const part = `Chapter ${index + 1}`;
    if (text) textParts.push(text);
    blocks.push({type:'text',text,part});
    for (const token of parseXml(html)) {
      if (!token.tag || token.tag.isEnd || !['img','image'].includes(token.tag.name)) continue;
      const src = token.tag.attributes.src ?? token.tag.attributes.href ?? token.tag.attributes['xlink:href'];
      if (!src) continue;
      if (/^(?:[a-z]+:|\/)/i.test(src)) { externalImages++; continue; }
      const path = posix.normalize(posix.join(posix.dirname(entryPath),decodeEntities(src).split('#')[0]));
      if (!imageLocations[path]) imageLocations[path] = [];
      if (!imageLocations[path].includes(part)) imageLocations[path].push(part);
    }
  }

  const raw = textParts.join('\n\n').trim() || '[File appears empty or has no extractable text]';
  const { text, warning } = truncate(raw);
  const notices = [warning, missingChapters ? `${missingChapters} chapter sources are missing.` : '', externalImages ? `${externalImages} external or inline image references were omitted.` : ''].filter(Boolean).join('; ') || undefined;
  return { text, blocks, meta: { format: 'epub', epub_image_locations:imageLocations, ...(warning && { truncated: true }) }, warning:notices };
}

export async function renderPdfPages(bytes: Buffer): Promise<{ page_count: number; served: number; pages: string[]; page_texts: string[]; text: string; warning?: string }> {
  const mupdf = (await import('mupdf')).default;
  const doc = mupdf.Document.openDocument(new Uint8Array(bytes), 'application/pdf');
  const pages: string[] = [], text: string[] = [];
  let derivedBytes = 0;
  try {
    const page_count = doc.countPages();
    const served = Math.min(page_count, PDF_PAGE_CAP);
    for (let i = 0; i < served; i++) {
      const page = doc.loadPage(i);
      try {
        const [x0, y0, x1, y1] = page.getBounds();
        if (![x0,y0,x1,y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) throw new Error('Invalid PDF page dimensions');
        const scale = Math.min(150 / 72, 3000 / Math.max(x1-x0, y1-y0));
        if ((x1-x0)*scale*(y1-y0)*scale > 9000000) throw new Error('PDF page exceeds pixel limit');
        const structured = page.toStructuredText();
        try { text.push(structured.asText()); } finally { structured.destroy(); }
        const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false);
        try {
          const data = Buffer.from(pixmap.asJPEG(85));
          derivedBytes += data.length;
          if (derivedBytes > 24 * 1024 * 1024) throw new Error('Rendered document exceeds 24 MB derivative limit');
          pages.push(data.toString('base64'));
        } finally { pixmap.destroy(); }
        if (text.reduce((n,t) => n+t.length, 0) > TEXT_CAP) break;
      } finally { page.destroy(); }
    }
    const truncated = truncate(text.join('\n\n'));
    return { page_count, served: pages.length, pages, page_texts: text, text: truncated.text,
      warning: [pages.length < page_count ? `Showing first ${pages.length} of ${page_count} pages` : '', truncated.warning].filter(Boolean).join('; ') || undefined };
  } finally { doc.destroy(); }
}

export async function extractDocImages(
  bytes: Buffer,
  format: 'docx' | 'odt' | 'epub',
): Promise<{ count: number; served: number; images: { data: string; ext: string; path?: string }[]; warning?: string }> {
  const AdmZip = (await import('adm-zip')).default;
  const zip = new AdmZip(bytes);
  assertArchiveBudget(zip);

  let imageEntries: { data: Buffer; ext: string; path?: string }[];

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

    const imageEntriesList: { data: Buffer; ext: string; path?: string }[] = [];
    if (opfXml) {
      const opfTokens = parseXml(opfXml);
      for (const token of opfTokens) {
        if (token.type === 'tag' && token.tag && token.tag.name === 'item') {
          const href = token.tag.attributes['href'];
          const mediaType = token.tag.attributes['media-type'] || '';
          if (href && mediaType.startsWith('image/')) {
            const imagePath = posix.normalize(opfBase + href);
            const entry = zip.getEntry(imagePath) ?? zip.getEntry(href);
            if (entry) {
              const ext = extname(href) || '.bin';
              imageEntriesList.push({ data: entry.getData(), ext, path:imagePath });
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
  if (count === 0) return { count: 0, served: 0, images: [] };

  const served = Math.min(count, DOC_IMAGE_CAP);
  const images: { data: string; ext: string; path?: string }[] = [];
  for (let i = 0; i < served; i++) {
    const { data, ext, path } = imageEntries[i];
    images.push({ data: data.toString('base64'), ext, ...(path ? {path} : {}) });
  }

  return {
    count,
    served,
    images,
    warning: count > DOC_IMAGE_CAP ? `Showing first ${DOC_IMAGE_CAP} of ${count} embedded images` : undefined,
  };
}
