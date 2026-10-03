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
import { extractText, renderPdfPages, extractDocImages, assertArchiveBudget, stripHtml } from './extract.ts';
import type { ProcessedFile, DerivedImage } from './processing.ts';

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
  if (result.text && result.text.length > TEXT_CAP) {
    result.text = result.text.slice(0, TEXT_CAP) + '\n[Text truncated at 1,000,000 characters]';
    result.warning = [result.warning, 'Text truncated at 1,000,000 characters'].filter(Boolean).join('; ');
    result.meta.truncated = true;
  }
  const bytes = result.images.reduce((sum, image) => sum + Buffer.byteLength(image.data, 'base64'), 0);
  if (bytes > 24 * 1024 * 1024) throw new Error('Document images exceed the 24 MB derivative limit');
  result.meta = {
    ...result.meta,
    served_image_count: result.images.length,
    processing_status: 'ready',
    processing_version: 1,
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
          label: label ?? 'SVG image',
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
        label: label ? `${label}, frame ${i + 1}` : `Frame ${i + 1} of ${count}`,
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
function presentationNotes(bytes: Buffer): string {
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
      return body ? `=== Speaker notes, slide ${i + 1} ===\n${xmlText(body)}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
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
  const sections: string[] = [],
    images: DerivedImage[] = [];
  const coverage: Array<{ name: string; status: string; reason?: string }> = [];
  let served = 0,
    chars = 0;
  for (const entry of entries) {
    let recognized;
    try {
      recognized = recognizeFormat(entry.name);
    } catch {
      coverage.push({ name: entry.name, status: 'omitted', reason: 'Unsupported format' });
      continue;
    }
    if (recognized.kind === 'archive' || entry.name.toLowerCase().endsWith('.eml')) {
      coverage.push({ name: entry.name, status: 'omitted', reason: 'Nested containers are not expanded' });
      continue;
    }
    if (served >= 50 || chars >= TEXT_CAP || images.length >= IMAGE_CAP) {
      coverage.push({ name: entry.name, status: 'omitted', reason: 'Collection coverage limit reached' });
      continue;
    }
    try {
      const child = await processFile(entry.bytes, recognized.mime, entry.name);
      const text = child.text?.slice(0, TEXT_CAP - chars) ?? '';
      chars += text.length;
      sections.push(`=== Entry: ${entry.name} ===\n${text}`);
      const availableImages = IMAGE_CAP - images.length;
      images.push(
        ...child.images
          .slice(0, availableImages)
          .map((image) => ({ ...image, label: `${entry.name}: ${image.label ?? 'image'}` })),
      );
      const partial =
        !!child.warning || (child.text?.length ?? 0) > text.length || child.images.length > availableImages;
      coverage.push({
        name: entry.name,
        status: partial ? 'partial' : 'included',
        ...(partial ? { reason: child.warning ?? 'Content limit reached' } : {}),
      });
      served++;
    } catch (error) {
      coverage.push({ name: entry.name, status: 'failed', reason: (error as Error).message });
    }
  }
  if (!served && !allowEmpty) throw new Error('Container has no supported, readable entries');
  const omitted = coverage.filter((entry) => entry.status !== 'included');
  return {
    text: sections.join('\n\n'),
    images,
    meta: { format, entries: coverage, entry_count: entries.length, served_entries: served },
    warning: omitted.length
      ? `${omitted.length} of ${entries.length} entries were omitted, partial, or unreadable; see coverage details`
      : undefined,
  };
}
export async function processFile(bytes: Buffer, mime: string, filename: string): Promise<ProcessedFile> {
  const format = recognizeFormat(filename, mime);
  mime = format.mime;
  if (!format.extensions.includes(extname(filename).slice(1).toLowerCase())) filename += '.' + format.extensions[0];
  if (format.kind === 'archive') return capResult(await archive(bytes, format.mime, filename));
  if (format.kind === 'image') {
    const images = await rasterImage(bytes, format.mime);
    const multiFrame = format.mime === 'image/tiff' || format.mime === 'image/gif';
    return capResult({
      text: null,
      images,
      meta: { format: 'image', source_mime: format.mime, served_images: images.length },
      warning: multiFrame
        ? format.mime === 'image/gif'
          ? 'Only the first GIF frame is included'
          : 'TIFF includes up to the first 20 frames'
        : undefined,
    });
  }
  if (mime === 'message/rfc822') {
    const mail = await simpleParser(bytes, { skipHtmlToText: true, skipTextToHtml: true });
    const header = `From: ${mail.from?.text ?? ''}\nTo: ${Array.isArray(mail.to) ? mail.to.map((a) => a.text).join(', ') : (mail.to?.text ?? '')}\nSubject: ${mail.subject ?? ''}\nDate: ${mail.date?.toISOString() ?? ''}\n\n${mail.text ?? stripHtml(mail.html || '')}`;
    const result = mail.attachments.length
      ? await collection(
          mail.attachments.map((a) => ({ name: a.filename ?? 'attachment.txt', bytes: a.content })),
          'email',
          true,
        )
      : { text: '', images: [], meta: { format: 'email' } };
    result.text = `${header}\n\n${result.text ?? ''}`;
    return capResult(result);
  }
  if (mime === 'application/pdf') {
    if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('Invalid PDF signature');
    const pdf = await renderPdfPages(bytes);
    return capResult({
      text: pdf.text,
      meta: { format: 'pdf', page_count: pdf.page_count, served_pages: pdf.served },
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
    if (ext === '.pptx') pdf.text = `${pdf.text ?? ''}\n\n${presentationNotes(bytes)}`;
    return capResult(pdf);
  }
  if (ext === '.xls') {
    const converted = await convertOffice(bytes, filename, 'xlsx');
    return processFile(
      converted,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'converted.xlsx',
    );
  }
  if (mime === 'application/x-ndjson') {
    const raw = decodeText(bytes),
      lines: string[] = [];
    let used = 0,
      invalid = 0,
      total = 0;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      total++;
      if (used + line.length > TEXT_CAP || lines.length >= 50000) continue;
      try {
        JSON.parse(line);
      } catch {
        invalid++;
      }
      lines.push(`[Record ${total}] ${line}`);
      used += line.length;
    }
    const partial = total > lines.length;
    return capResult({
      text: lines.join('\n'),
      images: [],
      meta: {
        format: 'jsonl',
        row_count: total,
        served_rows: lines.length,
        invalid_records: invalid,
        truncated: partial,
      },
      warning:
        [
          partial ? `${lines.length} of ${total} records included` : '',
          invalid ? `${invalid} included records contain invalid JSON; retained as source text` : '',
        ]
          .filter(Boolean)
          .join('; ') || undefined,
    });
  }
  const result = await extractText(bytes, mime);
  const images: DerivedImage[] = [];
  let imageWarning: string | undefined;
  if (ext === '.epub') {
    const embedded = await extractDocImages(bytes, 'epub');
    for (const image of embedded.images) {
      try {
        images.push(
          ...(await rasterImage(
            Buffer.from(image.data, 'base64'),
            recognizeFormat(`embedded${image.ext}`).mime,
          )),
        );
      } catch {
        imageWarning = 'Some embedded images could not be converted';
      }
    }
    imageWarning = [embedded.warning, imageWarning].filter(Boolean).join('; ') || undefined;
  }
  return capResult({
    text: result.text,
    meta: { ...result.meta },
    images,
    warning: [result.warning, imageWarning].filter(Boolean).join('; ') || undefined,
  });
}
