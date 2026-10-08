import test from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { gzipSync } from 'node:zlib';
import { recognizeFormat, decodeText } from '../src/formats.ts';
import { processFile, safeArchivePath, tarEntries, validateOfficeInput } from '../src/file-processing.ts';
import { extractText, extractEpubImages } from '../src/extract.ts';

function zipped(files: Record<string, string | Buffer>): Buffer {
  const zip = new AdmZip();
  for (const [name, value] of Object.entries(files)) zip.addFile(name, Buffer.from(value));
  return zip.toBuffer();
}
function tar(name: string, body: Buffer, type = '0'): Buffer {
  const header = Buffer.alloc(512);
  header.write(name);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
  header.fill(32, 148, 156);
  header.write(type, 156);
  header.write('ustar\0', 257);
  const sum = header.reduce((n, byte) => n + byte, 0);
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return Buffer.concat([header, body, Buffer.alloc((512 - (body.length % 512)) % 512), Buffer.alloc(1024)]);
}
test('format recognition covers requested tiers and aliases without accepting arbitrary binaries', () => {
  for (const name of [
    'deck.pptx',
    'legacy.doc',
    'legacy.ppt',
    'deck.odp',
    'mail.eml',
    'camera.heic',
    'scan.tiff',
    'drawing.svg',
    'readme.markdown',
    'app.tsx',
    'Dockerfile',
    'Makefile',
    '.env',
    'records.ndjson',
    'server.log',
    'changes.patch',
    'bundle.tar.gz',
  ])
    assert.ok(recognizeFormat(name));
  assert.equal(recognizeFormat('code.py', 'application/octet-stream').kind, 'text');
  assert.equal(recognizeFormat('image', 'image/heif').mime, 'image/heic');
  assert.throws(() => recognizeFormat('program.exe', 'application/octet-stream'));
});
test('text encodings preserve BOM-marked UTF16 and reject binary text', () => {
  assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0x48, 0, 0x69, 0])), 'Hi');
  assert.equal(decodeText(Buffer.from([0xfe, 0xff, 0, 0x48, 0, 0x69])), 'Hi');
  assert.throws(() => decodeText(Buffer.from([0, 1, 2])));
});

test('EPUB image extraction follows the manifest and retains its coverage limit', async () => {
  const files: Record<string, string | Buffer> = {
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="OPS/book.opf"/></rootfiles></container>',
    'OPS/book.opf': `<package><manifest>${Array.from({ length: 21 }, (_, index) => `<item id="image${index}" href="images/image${index}.png" media-type="image/png"/>`).join('')}<item id="missing" href="missing.png" media-type="image/png"/><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest></package>`,
    'OPS/chapter.xhtml': '<p>Chapter</p>',
    'word/media/unused.png': 'not an EPUB image',
  };
  for (let index = 0; index < 21; index++) files[`OPS/images/image${index}.png`] = `image ${index}`;
  const result = await extractEpubImages(zipped(files));
  assert.equal(result.count, 21);
  assert.equal(result.served, 20);
  assert.equal(result.images.length, 20);
  assert.deepEqual(result.images[0], { data: Buffer.from('image 0').toString('base64'), ext: '.png', path: 'OPS/images/image0.png' });
  assert.match(result.warning!, /first 20 of 21/);
  assert.deepEqual(await extractEpubImages(zipped({ 'META-INF/container.xml': '<container/>' })), { count: 0, served: 0, images: [] });
});
test('ZIP, TAR, TAR.GZ, and GZ include supported entries with explicit omissions', async () => {
  const result = await processFile(
    zipped({
      'src/app.py': 'print("hello")',
      'data.bin': Buffer.from([1, 0, 2]),
      'nested.zip': zipped({ 'a.txt': 'nested' }),
    }),
    'application/zip',
    'bundle.zip',
  );
  assert.match(result.text!, /src\/app.py/);
  assert.match(result.text!, /hello/);
  assert.match(result.warning!, /2 of 3/);
  assert.ok(result.blocks?.some(block => block.entry === 'src/app.py' && block.type === 'text' && block.text.includes('hello')));
  assert.ok(result.blocks?.some(block => block.entry === 'nested.zip' && block.notices?.includes('Nested containers are not expanded')));
  const tarFile = tar('notes.txt', Buffer.from('tar content'));
  assert.match((await processFile(tarFile, 'application/x-tar', 'bundle.tar')).text!, /tar content/);
  assert.match(
    (await processFile(gzipSync(tarFile), 'application/gzip', 'bundle.tar.gz')).text!,
    /tar content/,
  );
  assert.match(
    (await processFile(gzipSync(Buffer.from('compressed log')), 'application/gzip', 'server.log.gz')).text!,
    /compressed log/,
  );
});
test('archives reject traversal, links, and corrupt headers', () => {
  for (const path of ['../secret', '/etc/passwd', 'C:/secret', 'a\\b', 'a/../../b'])
    assert.equal(safeArchivePath(path), false);
  assert.throws(() => tarEntries(tar('../secret', Buffer.from('secret'))), /unsafe/);
  assert.throws(() => tarEntries(tar('link', Buffer.alloc(0), '2')), /links/);
  const invalid = tar('file.txt', Buffer.from('text'));
  invalid[0] = 0;
  assert.throws(() => tarEntries(invalid), /checksum/);
});
test('XLSX includes inline/shared strings, dates, booleans, and proper CSV quoting', async () => {
  const bytes = zipped({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Data" r:id="r1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/styles.xml': '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
    'xl/sharedStrings.xml': '<sst><si><t>Tom &amp; Jerry</t></si></sst>',
    'xl/worksheets/sheet1.xml':
      '<worksheet><sheetData><row><c r="A1" t="inlineStr"><is><t>Hello, "world"</t></is></c><c r="B1" t="s"><v>0</v></c><c r="C1" s="1"><v>45292</v></c><c r="D1" t="b"><v>1</v></c></row></sheetData></worksheet>',
  });
  const result = await extractText(
    bytes,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  assert.match(result.text!, /"Hello, ""world"""/);
  assert.match(result.text!, /Tom & Jerry/);
  assert.match(result.text!, /2024-01-01/);
  assert.match(result.text!, /true/);
});
test('sparse XLSX cannot allocate a huge grid', async () => {
  const bytes = zipped({
    'xl/workbook.xml': '<sheet name="Data" r:id="r1"/>',
    'xl/_rels/workbook.xml.rels': '<Relationship Id="r1" Target="worksheets/sheet1.xml"/>',
    'xl/worksheets/sheet1.xml': '<c r="XFD1048576"><v>1</v></c>',
  });
  await assert.rejects(
    extractText(bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    /exceeds/,
  );
});
test('ODS handles repeated cells/rows, numeric values, and empty grid tails', async () => {
  const bytes = zipped({
    'content.xml':
      '<table:table table:name="Data"><table:table-row table:number-rows-repeated="2"><table:table-cell office:value="42"/><table:table-cell table:number-columns-repeated="2"><text:p>Hello</text:p></table:table-cell><table:table-cell table:number-columns-repeated="10000"/></table:table-row></table:table>',
  });
  const result = await extractText(bytes, 'application/vnd.oasis.opendocument.spreadsheet');
  assert.match(result.text!, /42,Hello,Hello\n42,Hello,Hello/);
});
test('EML decodes MIME text and text attachments with useful headers', async () => {
  const eml =
    'From: Alice <alice@example.test>\r\nTo: Bob <bob@example.test>\r\nSubject: Hello\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=x\r\n\r\n--x\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nMail body\r\n--x\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename=notes.txt\r\nContent-Transfer-Encoding: base64\r\n\r\nYXR0YWNoZWQgdGV4dA==\r\n--x--';
  const result = await processFile(Buffer.from(eml), 'message/rfc822', 'mail.eml');
  assert.ok(result.blocks?.some(block => block.type === 'text' && block.part === 'Email headers'));
  assert.ok(result.blocks?.some(block => block.type === 'text' && block.part === 'Email body' && block.text.includes('Mail body')));
  assert.ok(result.blocks?.some(block => block.type === 'text' && block.entry === 'notes.txt' && block.text === 'attached text'));
  assert.match(result.text!, /Subject: Hello/);
  assert.match(result.text!, /Mail body/);
  assert.match(result.text!, /attached text/);
});
test('SVG rejects active and remote content before a conversion subprocess', async () => {
  await assert.rejects(
    processFile(Buffer.from('<svg><script>alert(1)</script></svg>'), 'image/svg+xml', 'bad.svg'),
    /active or external/,
  );
  await assert.rejects(
    processFile(
      Buffer.from('<svg><image href="https://example.test/image.png"/></svg>'),
      'image/svg+xml',
      'remote.svg',
    ),
    /active or external/,
  );
});

test('TAR supports PAX and GNU long names while rejecting path overrides that escape', () => {
  function pax(value: string) {
    let record = ` path=${value}\n`;
    let length = record.length + 1;
    while (length !== record.length + String(length).length) length = record.length + String(length).length;
    return Buffer.from(`${length}${record}`);
  }
  const path = 'nested/' + 'long-name-'.repeat(15) + '.txt';
  const headers = tar('PaxHeader', pax(path), 'x').subarray(0, 1024);
  assert.equal(tarEntries(Buffer.concat([headers, tar('short.txt', Buffer.from('content'))]))[0].name, path);
  const gnu = tar('LongLink', Buffer.from(path + '\0'), 'L').subarray(0, 1024);
  assert.equal(tarEntries(Buffer.concat([gnu, tar('short.txt', Buffer.from('content'))]))[0].name, path);
  const unsafe = tar('PaxHeader', pax('../secret'), 'x').subarray(0, 1024);
  assert.throws(() => tarEntries(Buffer.concat([unsafe, tar('safe.txt', Buffer.from('content'))])), /unsafe/);
});

test('JSONL preserves source records and blank lines, exposing invalid source locations', async () => {
  const result = await processFile(
    Buffer.from('{"ok":1}\nnot-json\n\n{"ok":2}'),
    'application/x-ndjson',
    'events.jsonl',
  );
  assert.equal(result.text, '{"ok":1}\nnot-json\n\n{"ok":2}');
  assert.match(result.warning!, /source lines 2/);
  assert.equal(result.meta.invalid_records, 1);
  assert.equal(result.meta.served_rows, 3);
  assert.match(result.warning!, /invalid JSON/);
});
test('Office formats verify signatures and package contents before invoking conversion', async () => {
  for (const extension of ['.docx', '.pptx', '.odt', '.odp', '.doc', '.ppt', '.xls', '.rtf'])
    assert.throws(() => validateOfficeInput(Buffer.from('not an Office file'), extension), /signature/);
  assert.throws(() => validateOfficeInput(zipped({ 'wrong.xml': '<xml/>' }), '.docx'), /missing/);
  assert.doesNotThrow(() => validateOfficeInput(Buffer.from('{\\rtf1\\ansi text}'), '.rtf'));
  await assert.rejects(processFile(
    Buffer.from('not an Office file'),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'document.bin',
  ), /signature/);
});

test('workbook sections retain empty row positions and disclose missing formula results', async () => {
  const bytes = zipped({
    'xl/workbook.xml': '<workbook><sheets><sheet name="Data" r:id="r1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c r="A1"><v>1</v></c></row><row><c r="A3"><v>3</v></c><c r="B3"><f>A1+1</f></c></row></sheetData></worksheet>',
  });
  const result = await processFile(bytes, recognizeFormat('data.xlsx').mime, 'data.xlsx');
  const sheet = result.blocks?.find(block => block.type === 'text' && block.part === 'Sheet: Data');
  assert.equal(sheet?.type === 'text' && sheet.text, '1,\n,\n3,');
  assert.match(result.warning!, /1 formula cells have no cached result/);
});

test('duplicate TAR entry names retain separate contents and occurrence labels', async () => {
  const bytes = Buffer.concat([
    tar('same.txt', Buffer.from('first')).subarray(0, 1024),
    tar('same.txt', Buffer.from('second')),
  ]);
  const result = await processFile(bytes, 'application/x-tar', 'duplicate.tar');
  assert.deepEqual(result.blocks?.filter(block => block.type === 'text').map(block => [block.entry,block.type === 'text' && block.text]), [
    ['same.txt','first'], ['same.txt (occurrence 2)','second'],
  ]);
});

test('plain text truncation preserves Unicode and does not insert notices into the payload', async () => {
  const source = 'x'.repeat(999999) + '😀';
  const result = await processFile(Buffer.from(source), 'text/plain', 'large.txt');
  assert.equal(result.text, 'x'.repeat(999999));
  assert.equal(result.blocks?.[0].type === 'text' && result.blocks[0].text, result.text);
  assert.match(result.warning!, /truncated/);
});
