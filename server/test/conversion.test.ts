import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import AdmZip from 'adm-zip';
import { processFile } from '../src/file-processing.ts';
import { recognizeFormat } from '../src/formats.ts';

const exec = promisify(execFile);
const enabled = process.env.FILE_CONVERSION_TESTS === '1';
function odf(kind: 'text' | 'presentation' | 'spreadsheet', body: string): Buffer {
  const zip = new AdmZip();
  const mime = `application/vnd.oasis.opendocument.${kind}`;
  zip.addFile('mimetype', Buffer.from(mime));
  zip.addFile(
    'META-INF/manifest.xml',
    Buffer.from(
      `<?xml version="1.0"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.2"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`,
    ),
  );
  zip.addFile(
    'content.xml',
    Buffer.from(
      `<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" office:version="1.2"><office:body><office:${kind}>${body}</office:${kind}></office:body></office:document-content>`,
    ),
  );
  return zip.toBuffer();
}

test(
  'Office converters retain text, pages, legacy spreadsheets, and PPTX speaker notes',
  { skip: !enabled, timeout: 120000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-conversion-test-'));
    try {
      const inputs = {
        'document.odt': odf('text', '<text:p>Office fixture text</text:p>'),
        'deck.odp': odf(
          'presentation',
          '<draw:page draw:name="Slide 1"><draw:frame svg:x="1cm" svg:y="1cm" svg:width="20cm" svg:height="3cm"><draw:text-box><text:p>Slide fixture text</text:p></draw:text-box></draw:frame></draw:page>',
        ),
        'workbook.ods': odf(
          'spreadsheet',
          '<table:table table:name="Data"><table:table-row><table:table-cell office:value-type="string"><text:p>Legacy workbook content</text:p></table:table-cell></table:table-row></table:table>',
        ),
      };
      async function exportAs(source: string, format: string, extension: string) {
        await exec(
          'soffice',
          [
            `-env:UserInstallation=${pathToFileURL(join(dir, 'export-profile')).href}`,
            '--headless',
            '--convert-to',
            format,
            '--outdir',
            dir,
            join(dir, source),
          ],
          { timeout: 45000 },
        );
        return readFile(join(dir, source.replace(/\.[^.]+$/, '.' + extension)));
      }
      for (const [name, bytes] of Object.entries(inputs)) await writeFile(join(dir, name), bytes);
      const docx = await exportAs('document.odt', 'docx', 'docx');
      const doc = await exportAs('document.odt', 'doc:MS Word 97', 'doc');
      const pptx = await exportAs('deck.odp', 'pptx', 'pptx');
      const ppt = await exportAs('deck.odp', 'ppt:MS PowerPoint 97', 'ppt');
      const xls = await exportAs('workbook.ods', 'xls:MS Excel 97', 'xls');
      for (const [name, bytes] of Object.entries({
        ...inputs,
        'document.docx': docx,
        'document.doc': doc,
        'document.rtf': Buffer.from('{\\rtf1\\ansi Office fixture text}'),
        'deck.pptx': pptx,
        'deck.ppt': ppt,
      })) {
        const result = await processFile(bytes, recognizeFormat(name).mime, name);
        if (name !== 'workbook.ods') assert.ok(result.images.length > 0, name);
        assert.match(result.text!, /fixture text|Legacy workbook content/, name);
      }
      const sheet = await processFile(xls, recognizeFormat('workbook.xls').mime, 'workbook.xls');
      assert.match(sheet.text!, /Legacy workbook content/);
      const zip = new AdmZip(pptx);
      zip.addFile(
        'ppt/notesSlides/notesSlide1.xml',
        Buffer.from('<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Speaker note fixture</a:t></a:r></a:p></p:notes>'),
      );
      const relPath = 'ppt/slides/_rels/slide1.xml.rels';
      const rels = zip
        .getEntry(relPath)!
        .getData()
        .toString()
        .replace(
          '</Relationships>',
          '<Relationship Id="notesFixture" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>',
        );
      zip.updateFile(relPath, Buffer.from(rels));
      const notes = await processFile(zip.toBuffer(), recognizeFormat('notes.pptx').mime, 'notes.pptx');
      assert.match(notes.text!, /Speaker notes, slide 1/);
      assert.match(notes.text!, /Speaker note fixture/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  'raster converters normalize BMP, TIFF, HEIC and safe SVG into PNG',
  { skip: !enabled, timeout: 60000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'llm-image-test-'));
    try {
      for (const ext of ['bmp', 'tiff', 'heic']) {
        const path = join(dir, `image.${ext}`);
        await exec('convert', ['-size', '32x24', 'xc:red', path]);
        const result = await processFile(await readFile(path), recognizeFormat(path).mime, path);
        assert.equal(result.images[0].ext, '.png');
        assert.equal(Buffer.from(result.images[0].data, 'base64').subarray(1, 4).toString(), 'PNG');
      }
      const result = await processFile(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="red"/></svg>',
        ),
        'image/svg+xml',
        'image.svg',
      );
      assert.equal(result.images[0].ext, '.png');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
