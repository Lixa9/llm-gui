import { Resvg } from '@resvg/resvg-js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import AdmZip from 'adm-zip';
import { simpleParser } from 'mailparser';
import { FILE_FORMATS, recognizeFormat, decodeText } from './formats.ts';
import { extractText, renderPdfPages, extractEpubImages, assertArchiveBudget, stripHtml } from './extract.ts';
import type { ProcessedFile, DerivedImage, AttachmentBlock } from './processing.ts';
import { limitBlocks, textPrefix } from './content-blocks.ts';

const exec = promisify(execFile);
const MAX_EXPANDED = 64 * 1024 * 1024;
const TEXT_CAP = 1_000_000;
const IMAGE_CAP = 20;
export function safeArchivePath(path: string): boolean {
  return (
    !!path &&
    !path.startsWith('/') &&
    !/^[a-z]:/i.test(path) &&
    !path.includes('\\') &&
    !path.includes('\0') &&
    !path.split('/').includes('..')
  );
}
function capResult(result: ProcessedFile): ProcessedFile {
  const blocks = result.blocks ?? [
    ...(result.text !== null ? [{type:'text' as const,text:result.text}] : []),
    ...result.images.map((image, image_index) => ({type:'image' as const,image_index,part:image.label})),
  ];
  const limited = limitBlocks(blocks, TEXT_CAP);
  if (limited.truncated && !result.images.length && !limited.blocks.some(block => block.type === 'text' && block.text))
    throw new Error('The document text limit excludes all usable content. Reduce the file size.');
  result.blocks = limited.blocks;
  if (limited.truncated || (result.text?.length ?? 0) > TEXT_CAP) {
    result.warning = [result.warning, 'Text truncated at 1,000,000 characters'].filter(Boolean).join('; ');
    result.meta.truncated = true;
  }
  if (result.text && result.text.length > TEXT_CAP) result.text = textPrefix(result.text, TEXT_CAP);
  const bytes = result.images.reduce((sum, image) => sum + Buffer.byteLength(image.data, 'base64'), 0);
  if (bytes > 24 * 1024 * 1024) throw new Error('Document images exceed the 24 MB derivative limit');
  result.meta = {
    ...result.meta,
    served_image_count: result.images.length,
    processing_status: 'ready',
    processing_version: 2,
    content_blocks: result.blocks,
    warning: result.warning ?? null,
  };
  return result;
}
async function withWorkspace<T>(task: (path: string) => Promise<T>): Promise<T> {
  const path = await mkdtemp(join(tmpdir(), 'llm-file-'));
  try {
    return await task(path);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
async function command(
  binary: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<string> {
  try {
    const { stdout } = await exec(
      'prlimit',
      ['--cpu=35', '--as=1610612736', '--fsize=134217728', '--', binary, ...args],
      {
        cwd,
        timeout: 45_000,
        maxBuffer: 1024 * 1024,
        env: { PATH: process.env.PATH, LANG: 'C.UTF-8', ...env },
      },
    );
    return stdout;
  } catch (error) {
    if ((error as {code?:string|number}).code === 'ENOENT' || (error as {code?:string|number}).code === 127)
      throw new Error(
        `${binary} and prlimit are required for this file format. Use the supplied Docker image or install the conversion tools.`,
      );
    throw new Error(`${binary} could not convert this document within the processing limits`);
  }
}
export async function rasterImage(bytes: Buffer, mime: string, label?: string): Promise<DerivedImage[]> {
  return withWorkspace(async (dir) => {
    const extension = FILE_FORMATS.find((f) => f.mime === mime)?.extensions[0];
    if (!extension) throw new Error('Unsupported embedded image format');
    if (mime === 'image/svg+xml') {
      const svg = decodeText(bytes);
      const references = [...svg.matchAll(/(?:href|src)\s*=\s*["']([^"']*)["']|url\s*\(\s*([^)]+)\)/gi)].map(
        (match) => (match[1] ?? match[2]).trim().replace(/^["']|["']$/g, ''),
      );
      if (
        /<!DOCTYPE|<!ENTITY|<script|<foreignObject|\son[a-z]+\s*=|@import/i.test(svg) ||
        references.some((value) => !value.startsWith('#'))
      )
        throw new Error('SVG contains active or external content');
      const font = { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' };
      const document = new Resvg(svg, { font });
      if (
        !Number.isFinite(document.width) ||
        !Number.isFinite(document.height) ||
        document.width <= 0 ||
        document.height <= 0 ||
        document.width > 12000 ||
        document.height > 12000 ||
        document.width * document.height > 16000000
      )
        throw new Error('SVG exceeds its dimension/pixel limits');
      const renderer = new Resvg(svg, {
        font,
        fitTo: { mode: 'zoom', value: Math.min(1, 3000 / Math.max(document.width, document.height)) },
      });
      return [
        {
          data: Buffer.from(renderer.render().asPng()).toString('base64'),
          ext: '.png',
          ...(label ? {label} : {}),
        },
      ];
    }
    const input = join(dir, `input.${extension}`);
    await writeFile(input, bytes);
    // A private policy disables delegates, remote coders, and indirect file reads.
    await writeFile(
      join(dir, 'policy.xml'),
      `<policymap>
      <policy domain="resource" name="memory" value="64MiB"/><policy domain="resource" name="map" value="128MiB"/>
      <policy domain="resource" name="disk" value="128MiB"/><policy domain="resource" name="width" value="12KP"/>
      <policy domain="resource" name="height" value="12KP"/><policy domain="resource" name="area" value="16MP"/>
      <policy domain="resource" name="list-length" value="100"/><policy domain="resource" name="time" value="30"/>
      <policy domain="delegate" rights="none" pattern="*"/><policy domain="path" rights="none" pattern="@*"/>
      <policy domain="coder" rights="none" pattern="*"/>
      <policy domain="coder" rights="read|write" pattern="{JPEG,PNG,WEBP,GIF,HEIC,TIFF,BMP,SVG,MSVG}"/>
    </policymap>`,
    );
    const binary = process.env.IMAGEMAGICK_BINARY ?? 'convert';
    const env = { MAGICK_CONFIGURE_PATH: dir, MAGICK_TEMPORARY_PATH: dir };
    const count = Number(
      (await command('identify', ['-ping', '-format', '%n\n', input], dir, env)).trim().split('\n')[0],
    );
    if (!Number.isFinite(count) || count < 1) throw new Error('Image has no readable frames');
    const served = mime === 'image/tiff' ? Math.min(count, IMAGE_CAP) : 1;
    await command(
      binary,
      [
        '-limit',
        'thread',
        '1',
        `${mime === 'image/svg+xml' ? 'MSVG:' : ''}${input}[0-${served - 1}]`,
        '-auto-orient',
        '-resize',
        '3000x3000>',
        '-strip',
        join(dir, 'page-%03d.png'),
      ],
      dir,
      env,
    );
    const files = (await readdir(dir)).filter((name) => /^page-\d+\.png$/.test(name)).sort();
    const images: DerivedImage[] = [];
    for (const [i, file] of files.entries()) {
      const data = await readBounded(join(dir, file));
      images.push({
        data: data.toString('base64'),
        ext: '.png',
        ...(count > 1 ? {label: label ? `${label}, frame ${i + 1}` : `Frame ${i + 1}`} : label ? {label} : {}),
        frame_count: count,
      });
    }
    return images;
  });
}
async function readBounded(path: string): Promise<Buffer> {
  if ((await stat(path)).size > MAX_EXPANDED) throw new Error('Conversion output exceeds 64 MB');
  return readFile(path);
}
export function validateOfficeInput(bytes: Buffer, extension: string): void {
  const packagePart: Record<string, string> = {
    '.docx': 'word/document.xml',
    '.pptx': 'ppt/presentation.xml',
    '.odt': 'content.xml',
    '.odp': 'content.xml',
  };
  if (packagePart[extension]) {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new Error('Invalid Office package signature');
    const zip = new AdmZip(bytes);
    assertArchiveBudget(zip);
    if (!zip.getEntry(packagePart[extension]))
      throw new Error('Office package is missing its document content');
    if (extension === '.odt' || extension === '.odp') {
      const expected = extension === '.odt'
        ? 'application/vnd.oasis.opendocument.text'
        : 'application/vnd.oasis.opendocument.presentation';
      if (zip.getEntry('mimetype')?.getData().toString().trim() !== expected)
        throw new Error('Invalid OpenDocument package type');
    }
    return;
  }
  const rtf = bytes.subarray(0, 64).toString('ascii').trimStart().startsWith('{\\rtf');
  if (extension === '.rtf' || (extension === '.doc' && rtf)) {
    if (!rtf) throw new Error('Invalid RTF signature');
    return;
  }
  if (!bytes.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex')))
    throw new Error('Invalid legacy Office signature');
}
async function convertOffice(bytes: Buffer, filename: string, output: 'pdf' | 'xlsx'): Promise<Buffer> {
  validateOfficeInput(bytes, extname(filename).toLowerCase());
  return withWorkspace(async (dir) => {
    const profile = join(dir, 'profile');
    await mkdir(join(profile, 'user'), { recursive: true });
    // Never run document macros or update external links.
    await writeFile(
      join(profile, 'user', 'registrymodifications.xcu'),
      `<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry">
      <item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
      <item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
      <item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
      <item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
    </oor:items>`,
    );
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      const zip = new AdmZip(bytes);
      assertArchiveBudget(zip);
      for (const entry of zip.getEntries()) {
        if (entry.entryName.endsWith('.rels')) {
          const xml = entry
            .getData()
            .toString('utf8')
            .replace(/<Relationship\b[^>]*TargetMode\s*=\s*["']External["'][^>]*\/?\s*>/g, '');
          zip.updateFile(entry.entryName, Buffer.from(xml));
        }
      }
      bytes = zip.toBuffer();
    }
    const input = join(dir, `input${extname(filename).toLowerCase()}`);
    await writeFile(input, bytes);
    await command(
      'soffice',
      [
        `-env:UserInstallation=${pathToFileURL(profile).href}`,
        '--headless',
        '--nologo',
        '--nodefault',
        '--norestore',
        '--convert-to',
        output,
        '--outdir',
        dir,
        input,
      ],
      dir,
    );
    try {
      return await readBounded(join(dir, `input.${output}`));
    } catch {
      throw new Error('Office file could not be converted (it may be corrupt or password protected)');
    }
  });
}
function xmlText(xml: string): string {
  return xml
    .replace(/<\/(?:[\w-]+:)?(?:p|tr)>/g, '\n')
    .replace(/<\/(?:[\w-]+:)?tc>/g, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
function presentationNotes(bytes: Buffer): AttachmentBlock[] {
  const zip = new AdmZip(bytes);
  assertArchiveBudget(zip);
  const presentation = zip.getEntry('ppt/presentation.xml')?.getData().toString('utf8');
  const rels = zip.getEntry('ppt/_rels/presentation.xml.rels')?.getData().toString('utf8');
  if (!presentation || !rels) throw new Error('Invalid PPTX presentation');
  const attributes = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}=["']([^"']+)["']`))?.[1];
  const relationships = new Map(
    (rels.match(/<Relationship\b[^>]+/g) ?? []).map((tag) => [
      attributes(tag, 'Id'),
      attributes(tag, 'Target'),
    ]),
  );
  return (presentation.match(/<p:sldId\b[^>]+/g) ?? [])
    .slice(0, 100)
    .map((tag, i) => {
      const target = relationships.get(attributes(tag, 'r:id'));
      const number = target?.match(/slide(\d+)\.xml/)?.[1];
      const rel = zip.getEntry(`ppt/slides/_rels/slide${number}.xml.rels`)?.getData().toString('utf8') ?? '';
      const noteTarget = (rel.match(/<Relationship\b[^>]+/g) ?? []).find((t) => /\/notesSlide["']/.test(t));
      const note = noteTarget && attributes(noteTarget, 'Target')?.match(/notesSlide\d+\.xml/)?.[0];
      const body = note ? zip.getEntry(`ppt/notesSlides/${note}`)?.getData().toString('utf8') : '';
      return {type:'text' as const,part:`Slide ${i + 1} — speaker notes`,text:body ? xmlText(body) : ''};
    })
    .filter(block => !!block.text);
}
interface ArchiveEntry {
  name: string;
  bytes: Buffer;
}
export function tarEntries(bytes: Buffer): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let offset = 0,
    count = 0,
    expanded = 0;
  let nextName: string | undefined,
    pax: Record<string, string> = {};
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    const expected = parseInt(field(148, 8).trim(), 8);
    const checksum = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (checksum !== expected) throw new Error('Invalid TAR header checksum');
    const size = parseInt(field(124, 12).trim() || '0', 8),
      type = field(156, 1);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > bytes.length)
      throw new Error('Invalid TAR entry size');
    const body = bytes.subarray(offset + 512, offset + 512 + size);
    expanded += size;
    if (++count > 2000 || expanded > MAX_EXPANDED) throw new Error('Archive exceeds expansion limits');
    if (type === 'x' || type === 'g') {
      if (size > 65536) throw new Error('TAR metadata exceeds its limit');
      const properties: Record<string, string> = {};
      let position = 0;
      while (position < body.length) {
        const space = body.indexOf(32, position),
          length = Number(body.subarray(position, space).toString());
        if (
          space < position ||
          !Number.isSafeInteger(length) ||
          length <= space - position + 1 ||
          position + length > body.length
        )
          throw new Error('Invalid TAR PAX metadata');
        const record = body.subarray(space + 1, position + length - 1).toString('utf8'),
          equals = record.indexOf('=');
        if (equals < 1) throw new Error('Invalid TAR PAX property');
        const key = record.slice(0, equals),
          value = record.slice(equals + 1);
        if (key.startsWith('GNU.sparse') || key === 'linkpath' || key === 'size')
          throw new Error('TAR sparse/link/size overrides are unsupported');
        properties[key] = value;
        position += length;
      }
      if (type === 'g' && properties.path) throw new Error('Global TAR path overrides are unsupported');
      if (type === 'x') pax = properties;
    } else if (type === 'L') {
      if (size > 4096) throw new Error('TAR long filename exceeds its limit');
      nextName = body.toString('utf8').replace(/\0.*$/s, '').replace(/\n$/, '');
    } else {
      const name = pax.path ?? nextName ?? [field(345, 155), field(0, 100)].filter(Boolean).join('/');
      pax = {};
      nextName = undefined;
      if (!safeArchivePath(name)) throw new Error('Archive contains an unsafe entry path');
      if (type === '' || type === '0') entries.push({ name, bytes: body });
      else if (type !== '5') throw new Error('TAR links and special files are unsupported');
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!count) throw new Error('Archive contains no entries');
  return entries;
}

async function archive(bytes: Buffer, mime: string, filename: string): Promise<ProcessedFile> {
  let entries: ArchiveEntry[];
  if (mime === 'application/gzip') {
    const expanded = gunzipSync(bytes, { maxOutputLength: MAX_EXPANDED });
    if (/\.(?:tar\.gz|tgz)$/i.test(filename)) entries = tarEntries(expanded);
    else {
      let name = filename.replace(/\.gz$/i, '');
      try {
        recognizeFormat(name);
      } catch {
        decodeText(expanded);
        name += '.txt';
      }
      entries = [{ name, bytes: expanded }];
    }
  } else if (mime === 'application/x-tar') entries = tarEntries(bytes);
  else {
    const zip = new AdmZip(bytes);
    assertArchiveBudget(zip);
    let expanded = 0;
    entries = zip.getEntries().flatMap((entry) => {
      if (!safeArchivePath(entry.entryName)) throw new Error('Archive contains an unsafe entry path');
      const type = (entry.header.attr >>> 16) & 0xf000;
      if (type && type !== 0x8000 && type !== 0x4000)
        throw new Error('Archive links and special files are unsupported');
      if (entry.isDirectory) return [];
      const data = entry.getData();
      expanded += data.length;
      if (expanded > MAX_EXPANDED) throw new Error('Archive exceeds 64 MB expanded limit');
      return [{ name: entry.entryName, bytes: data }];
    });
  }
  return collection(entries, 'archive');
}
async function collection(
  entries: ArchiveEntry[],
  format: string,
  allowEmpty = false,
): Promise<ProcessedFile> {
  const sections: string[] = [], images: DerivedImage[] = [], blocks: AttachmentBlock[] = [];
  const coverage: Array<{ name: string; status: string; reason?: string }> = [];
  const occurrences = new Map<string, number>();
  let served = 0, chars = 0;
  function omit(name: string, entry: string, reason: string, status = 'omitted') {
    coverage.push({name,status,reason});
    blocks.push({type:'text',text:'',entry,notices:[reason]});
  }
  for (const entry of entries) {
    const occurrence = (occurrences.get(entry.name) ?? 0) + 1;
    occurrences.set(entry.name, occurrence);
    const entryLabel = occurrence === 1 ? entry.name : `${entry.name} (occurrence ${occurrence})`;
    let recognized;
    try { recognized = recognizeFormat(entry.name); }
    catch { omit(entry.name,entryLabel,'Unsupported format'); continue; }
    if (recognized.kind === 'archive' || entry.name.toLowerCase().endsWith('.eml')) {
      omit(entry.name,entryLabel,'Nested containers are not expanded'); continue;
    }
    if (served >= 50 || chars >= TEXT_CAP || images.length >= IMAGE_CAP) {
      omit(entry.name,entryLabel,'Collection coverage limit reached'); continue;
    }
    try {
      const child = await processFile(entry.bytes, recognized.mime, entry.name);
      const offset = images.length;
      const availableImages = IMAGE_CAP - offset;
      const selectedImages = child.images.slice(0,availableImages);
      const childBlocks = limitBlocks(child.blocks ?? [], TEXT_CAP - chars);
      chars += childBlocks.blocks.reduce((sum,block) => sum + (block.type === 'text' ? block.text.length : 0),0);
      const notices = [child.warning,childBlocks.truncated ? 'Collection text limit reached' : '',child.images.length > availableImages ? 'Collection image limit reached' : ''].filter((notice): notice is string => !!notice);
      for (const block of childBlocks.blocks) {
        if (block.type === 'image' && block.image_index >= selectedImages.length) continue;
        blocks.push({...block,entry:entryLabel,notices:[...new Set([...(block.notices ?? []),...notices])],
          ...(block.type === 'image' ? {image_index:block.image_index + offset} : {})});
      }
      sections.push(`=== Entry: ${entryLabel} ===\n${childBlocks.blocks.filter(block => block.type === 'text').map(block => block.text).join('\n\n')}`);
      images.push(...selectedImages);
      coverage.push({name:entry.name,status:notices.length ? 'partial':'included',...(notices.length ? {reason:notices.join('; ')} : {})});
      served++;
    } catch (error) {
      omit(entry.name,entryLabel,(error as Error).message,'failed');
    }
  }
  if (!served && !allowEmpty) throw new Error('Container has no supported, readable entries');
  const omitted = coverage.filter(entry => entry.status !== 'included');
  return {
    text:sections.join('\n\n'),images,blocks,
    meta:{format,entries:coverage,entry_count:entries.length,served_entries:served},
    warning:omitted.length ? `${omitted.length} of ${entries.length} entries were omitted, partial, or unreadable.` : undefined,
  };
}

export async function processFile(bytes: Buffer, mime: string, filename: string): Promise<ProcessedFile> {
  const format = recognizeFormat(filename, mime);
  mime = format.mime;
  if (!format.extensions.includes(extname(filename).slice(1).toLowerCase())) filename += '.' + format.extensions[0];
  if (format.kind === 'archive') return capResult(await archive(bytes, format.mime, filename));
  if (format.kind === 'image') {
    const images = await rasterImage(bytes, format.mime);
    const count = images[0]?.frame_count ?? images.length;
    return capResult({
      text:null, images,
      meta:{format:'image',source_mime:format.mime,served_images:images.length},
      warning:count > images.length ? `Only the first ${images.length} of ${count} frames are included.` : undefined,
    });
  }
  if (mime === 'message/rfc822') {
    const mail = await simpleParser(bytes, { skipHtmlToText: true, skipTextToHtml: true });
    const header = `From: ${mail.from?.text ?? ''}\nTo: ${Array.isArray(mail.to) ? mail.to.map(a => a.text).join(', ') : (mail.to?.text ?? '')}\nSubject: ${mail.subject ?? ''}\nDate: ${mail.date?.toISOString() ?? ''}`;
    const body = mail.text ?? stripHtml(mail.html || '');
    const result = mail.attachments.length
      ? await collection(
          mail.attachments.map((a) => ({ name: a.filename ?? 'attachment.txt', bytes: a.content })),
          'email',
          true,
        )
      : { text: '', images: [], meta: { format: 'email' } };
    result.blocks = [{type:'text',part:'Email headers',text:header},{type:'text',part:'Email body',text:body},...(result.blocks ?? [])];
    result.text = `${header}\n\n${body}\n\n${result.text ?? ''}`;
    return capResult(result);
  }
  if (mime === 'application/pdf') {
    if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('Invalid PDF signature');
    const pdf = await renderPdfPages(bytes);
    if (!pdf.served) throw new Error('PDF has no readable pages');
    return capResult({
      text: pdf.text,
      meta: { format: 'pdf', page_count: pdf.page_count, served_pages: pdf.served },
      blocks: pdf.pages.flatMap((_,i) => [{type:'text' as const,part:`Page ${i + 1}`,text:pdf.page_texts[i] ?? ''},{type:'image' as const,part:`Page ${i + 1}`,image_index:i}]),
      images: pdf.pages.map((data, i) => ({
        data,
        ext: '.jpg',
        label: `Page ${i + 1} of ${pdf.page_count}`,
      })),
      warning: pdf.warning,
    });
  }
  const ext = extname(filename).toLowerCase();
  if (['.doc', '.docx', '.odt', '.rtf', '.ppt', '.pptx', '.odp'].includes(ext)) {
    const pdf = await processFile(
      await convertOffice(bytes, filename, 'pdf'),
      'application/pdf',
      'converted.pdf',
    );
    pdf.meta = { ...pdf.meta, format: ext.slice(1), conversion: 'PDF', visual_layout: true };
    const presentation = ['.ppt','.pptx','.odp'].includes(ext);
    pdf.blocks = pdf.blocks?.map(block => ({...block,part:block.part?.replace(/^Page /,presentation ? 'Slide ' : 'Converted page ')}));
    if (ext === '.pptx') {
      const notes = presentationNotes(bytes);
      const ordered: AttachmentBlock[] = [];
      for (const block of pdf.blocks ?? []) {
        ordered.push(block);
        if (block.type === 'image') ordered.push(...notes.filter(note => note.part === `${block.part} — speaker notes`));
      }
      const unpaired = notes.filter(note => !ordered.includes(note));
      pdf.blocks = [...ordered,...unpaired];
      pdf.text = `${pdf.text ?? ''}\n\n${notes.map(note => note.type === 'text' ? `=== ${note.part} ===\n${note.text}` : '').join('\n\n')}`;
      if (unpaired.length) pdf.warning = [pdf.warning,'Some speaker notes refer to slides omitted from the rendered content.'].filter(Boolean).join('; ');
    }
    if (ext === '.ppt' || ext === '.odp') pdf.warning = [pdf.warning,'Speaker notes are not extracted for this presentation format.'].filter(Boolean).join('; ');
    return capResult(pdf);
  }
  if (ext === '.xls') {
    const converted = await convertOffice(bytes, filename, 'xlsx');
    const result = await processFile(converted,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','converted.xlsx');
    result.meta = {...result.meta,format:'xls',conversion:'XLSX'};
    return result;
  }
  if (mime === 'application/x-ndjson') {
    const raw = decodeText(bytes),
      lines: string[] = [];
    let used = 0,
      invalid = 0,
      total = 0;
    const invalidLines: number[] = [];
    let sourceLine = 0, servedRecords = 0, limitReached = false;
    for (const line of raw.split(/(?<=\n)/)) {
      sourceLine++;
      if (!line.trim()) { if(!limitReached && used + line.length <= TEXT_CAP) { lines.push(line); used += line.length; } else { limitReached = true; } continue; }
      total++;
      if (limitReached || used + line.length > TEXT_CAP || servedRecords >= 50000) { limitReached = true; continue; }
      try {
        JSON.parse(line);
      } catch {
        invalid++;
        if (invalidLines.length < 20) invalidLines.push(sourceLine);
      }
      lines.push(line);
      used += line.length;
      servedRecords++;
    }
    const partial = total > servedRecords || limitReached;
    if (total && !servedRecords) throw new Error('The document text limit excludes every JSONL record. Reduce the record size.');
    return capResult({
      text: lines.join(''),
      blocks:[{type:'text',text:lines.join(''),format:'jsonl'}],
      images: [],
      meta: {
        format: 'jsonl',
        row_count: total,
        served_rows: servedRecords,
        invalid_records: invalid,
        truncated: partial,
      },
      warning:
        [
          partial ? total > servedRecords ? `${servedRecords} of ${total} records included` : 'Source text exceeded the document text limit.' : '',
          invalid ? `${invalid} included records contain invalid JSON at source lines ${invalidLines.join(', ')}${invalid > invalidLines.length ? ', …' : ''}; retained as source text` : '',
        ]
          .filter(Boolean)
          .join('; ') || undefined,
    });
  }
  if (mime === 'text/csv' || mime === 'text/tab-separated-values') {
    const text = decodeText(bytes);
    return capResult({text,images:[],meta:{format:mime === 'text/csv' ? 'csv' : 'tsv'},blocks:[{type:'text',text,format:'csv'}]});
  }
  const result = await extractText(bytes, mime);
  const images: DerivedImage[] = [], imageBlocks: AttachmentBlock[] = [];
  let imageWarning: string | undefined;
  if (ext === '.epub') {
    const embedded = await extractEpubImages(bytes);
    for (const image of embedded.images) {
      try {
        const converted = await rasterImage(Buffer.from(image.data,'base64'),recognizeFormat(`embedded${image.ext}`).mime);
        const locations = image.path ? result.meta.epub_image_locations?.[image.path] : undefined;
        for (const convertedImage of converted) {
          const image_index = images.length;
          images.push(convertedImage);
          for (const chapter of locations?.length ? locations : ['']) {
            imageBlocks.push({type:'image',image_index,part:chapter ? `${chapter} — image ${image_index + 1}` : `Embedded image ${image_index + 1}`});
          }
        }
      } catch { imageWarning = 'Some embedded images could not be converted'; }
    }
    const unavailableImages = Object.keys(result.meta.epub_image_locations ?? {}).some(path => !embedded.images.some(image=>image.path===path));
    imageWarning = [embedded.warning,imageWarning,unavailableImages ? 'Some referenced images are missing or outside the supported image coverage.' : ''].filter(Boolean).join('; ') || undefined;
  }
  const blocks: AttachmentBlock[] = [];
  for (const block of result.blocks ?? [{type:'text' as const,text:result.text ?? ''}]) {
    blocks.push(block);
    blocks.push(...imageBlocks.filter(image=>image.part?.startsWith(`${block.part} — image `)));
  }
  blocks.push(...imageBlocks.filter(image=>!blocks.includes(image)));

  return capResult({
    text: result.text,
    meta: { ...result.meta },
    blocks,
    images,
    warning: [result.warning, imageWarning].filter(Boolean).join('; ') || undefined,
  });
}
