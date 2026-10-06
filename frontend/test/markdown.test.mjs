import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const previousWindow = globalThis.window;
globalThis.window = dom.window;
const { default: createDOMPurify } = await import('dompurify');
const { renderMarkdown } = await import('../src/lib/markdown.ts');

test.after(() => {
  dom.window.close();
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
});

function renderedFragment(markdown) {
  const template = dom.window.document.createElement('template');
  template.innerHTML = renderMarkdown(markdown);
  return template.content;
}

function assertNoEventHandlers(root) {
  for (const element of root.querySelectorAll('*')) {
    for (const attribute of element.attributes) {
      assert.equal(attribute.name.startsWith('on'), false, `${element.tagName} retains ${attribute.name}`);
    }
  }
}

test('markdown strips executable elements and event handlers before HTML insertion', () => {
  const fragment = renderedFragment([
    '<script>ATTACKER()</script>',
    '<svg onload="ATTACKER()"><circle></circle></svg>',
    '<iframe srcdoc="<script>ATTACKER()</script>"></iframe>',
    '<object data="javascript:ATTACKER()"></object>',
    '<img src="missing.png" onerror="ATTACKER()" onload="ATTACKER()">',
    '<div onclick="ATTACKER()" onmouseover="ATTACKER()" style="color:red" data-attack="yes">Safe text</div>',
  ].join('\n'));

  assert.equal(fragment.querySelector('script, svg, iframe, object, style'), null);
  assert.equal(fragment.querySelector('img').getAttribute('src'), 'missing.png');
  assert.equal(fragment.querySelector('[style], [data-attack]'), null);
  assert.match(fragment.textContent, /Safe text/);
  assertNoEventHandlers(fragment);
});

test('markdown strips dangerous link and image protocols', () => {
  const fragment = renderedFragment([
    '<a href="javascript:ATTACKER()">JavaScript</a>',
    '<a href="jav&#x61;script:ATTACKER()">Encoded JavaScript</a>',
    '<a href="data:text/html,<script>ATTACKER()</script>">Data</a>',
    '<a href="vbscript:ATTACKER()">VBScript</a>',
    '<img src="javascript:ATTACKER()">',
  ].join('\n'));

  assert.equal(fragment.querySelectorAll('a').length, 4);
  for (const link of fragment.querySelectorAll('a')) assert.equal(link.hasAttribute('href'), false);
  assert.equal(fragment.querySelector('img').hasAttribute('src'), false);
});

test('rawtext payloads remain inert after sanitized HTML is reparsed', () => {
  for (const tag of ['style', 'script', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']) {
    const fragment = renderedFragment(`<${tag}><!--</${tag}><img src="missing.png" onerror="ATTACKER()">`);
    assert.equal(fragment.querySelector(tag), null);
    assertNoEventHandlers(fragment);
  }
});

test('markdown preserves headings, emphasis, lists, tables, and safe links', () => {
  const fragment = renderedFragment([
    '# Heading',
    '',
    '**Bold** and *italic* with [documentation](https://example.com/docs).',
    '',
    '- First',
    '- Second',
    '',
    '| Name | Value |',
    '| --- | --- |',
    '| Safe | 42 |',
    '',
    '<details open><summary>More</summary>Details</details>',
  ].join('\n'));

  assert.equal(fragment.querySelector('h1').textContent, 'Heading');
  assert.equal(fragment.querySelector('strong').textContent, 'Bold');
  assert.equal(fragment.querySelector('em').textContent, 'italic');
  assert.equal(fragment.querySelectorAll('li').length, 2);
  assert.equal(fragment.querySelector('table td').textContent, 'Safe');
  assert.equal(fragment.querySelector('a').getAttribute('href'), 'https://example.com/docs');
  assert.equal(fragment.querySelector('details').hasAttribute('open'), true);
  assert.equal(fragment.querySelector('summary').textContent, 'More');
});

test('highlighted code remains escaped and retains the copy button', () => {
  const code = '<img src=x onerror="ATTACKER()">';
  const fragment = renderedFragment(`\`\`\`html\n${code}\n\`\`\``);

  assert.equal(fragment.querySelector('pre code').textContent, code);
  assert.equal(fragment.querySelector('pre code').classList.contains('language-html'), true);
  assert.ok(fragment.querySelector('code .hljs-tag'));
  assert.equal(fragment.querySelector('button.copy-btn').getAttribute('aria-label'), 'Copy code');
  assert.equal(fragment.querySelector('.code-lang').textContent, 'html');
  assert.equal(fragment.querySelector('img'), null);
  assertNoEventHandlers(fragment);
});

for (const hook of ['afterSanitizeElements', 'afterSanitizeAttributes']) {
  test(`${hook} removals neutralize detached descendant event handlers (GHSA-p98j-92pf-mc4p)`, () => {
    const purify = createDOMPurify(dom.window);
    const root = dom.window.document.createElement('div');
    root.innerHTML = '<section id="wrap"><img src="missing.png" onerror="ATTACKER()"></section>';
    dom.window.document.body.appendChild(root);
    const image = root.querySelector('img');
    purify.addHook(hook, node => { if (node.id === 'wrap') node.remove(); });

    try {
      purify.sanitize(root, { IN_PLACE: true });
      assert.equal(root.querySelector('#wrap'), null);
      assert.equal(image.hasAttribute('onerror'), false);
    } finally {
      purify.removeAllHooks();
      root.remove();
    }
  });
}

test('force-removed rawtext roots cannot be returned for HTML reparsing (GHSA-6688-9rhm-gjv2)', () => {
  const purify = createDOMPurify(dom.window);
  const parent = dom.window.document.createElement('div');
  const root = dom.window.document.createElement('style');
  root.setAttribute('onclick', 'ATTACKER()');
  root.textContent = '</style><img src=x onerror="ATTACKER()">';
  parent.appendChild(root);

  assert.throws(() => purify.sanitize(root, { IN_PLACE: true }), {
    name: 'TypeError',
    message: /refusing to sanitize in place/,
  });
});
