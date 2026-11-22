'use strict';
// Share (src/share.js + app.js): a link that opens the paper in the public
// viewer, at the section being read; the clipboard on a computer, the share
// sheet on a phone; nothing to share for a file from this computer. arXiv is
// played by a fake. The browser parts are skipped where Playwright is not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Share = require('../src/share.js');
const { PRECACHE } = require('../sw.js');

let playwright = null;
try { playwright = require('playwright'); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

test('links open the paper in the public viewer, at a section', () => {
  assert.equal(Share.link({ arxiv: '2301.00001' }), 'https://texglass.js.org/?arxiv=2301.00001');
  assert.equal(Share.link({ arxiv: 'math/0601001v2', goto: '§2.3' }), 'https://texglass.js.org/?arxiv=math/0601001v2&goto=§2.3');
  assert.equal(Share.link({ arxiv: 'arXiv:2301.00001', goto: 'Section A' }), 'https://texglass.js.org/?arxiv=2301.00001&goto=Section+A');
  const gh = Share.link({ gh: 'https://github.com/a/b/blob/main/x y&z.tex' });
  assert.equal(new URL(gh).searchParams.get('gh'), 'https://github.com/a/b/blob/main/x y&z.tex');
  assert.equal(new URL(Share.link({ arxiv: '1', goto: '§2.3' })).searchParams.get('goto'), '§2.3');
  assert.equal(Share.link({ gh: 'https://evil.example/x' }), null);
  assert.equal(Share.link({}), null);
  assert.equal(Share.sectionName('2.3'), '§2.3');
  assert.equal(Share.sectionName('A'), 'Section A');
  assert.equal(Share.sectionName(''), '');
  assert.ok(PRECACHE.includes('src/share.js'));
});

function tar(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write('0000644\0', 100);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('0', 156);
    h.write('ustar\0' + '00', 257);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const filler = (s) => Array.from({ length: 30 }, (_, k) => `Filler ${s} paragraph ${k} with enough words to make the page scroll well past one screen.`).join('\n\n');
const TEX = `\\documentclass{article}\n\\title{Shared heat bounds}\n\\begin{document}\n\\maketitle\n\\section{Introduction}\n${filler('a')}\n\\section{Estimates}\\label{sec:est}\n${filler('b')}\n\\section{Main result}\n${filler('c')}\n\\end{document}\n`;
const TARBALL = zlib.gzipSync(tar({ 'main.tex': TEX }));

async function context(browser, options, init) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', ...options });
  await ctx.addInitScript(() => {
    if (!localStorage.getItem('texglass:last')) {
      localStorage.setItem('texglass:last', '\\documentclass{article}\\begin{document}\\section{Mine}A file of my own.\\end{document}');
      localStorage.setItem('texglass:last-name', 'mine.tex');
    }
  });
  if (init) await ctx.addInitScript(init);
  await ctx.route('http://texglass.test/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
    const file = path.join(ROOT, p);
    if (p === 'sw.js' || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(p)] || 'application/octet-stream' });
  });
  await ctx.route('https://arxiv.org/src/**', (route) => route.fulfill({ headers: { 'access-control-allow-origin': '*' }, contentType: 'application/gzip', body: TARBALL }));
  await ctx.route(/^https?:\/\/(?!texglass\.test|arxiv\.org\/src)/, (route) => route.fulfill({ status: 503, body: '' }));
  return ctx;
}

async function launch(t) {
  try {
    return await playwright.chromium.launch();
  } catch (e) {
    t.skip('no browser: ' + e.message.split('\n')[0]);
    return null;
  }
}

test('on a computer: Share copies a link that reopens the paper at the same section', { skip: !playwright && 'Playwright is not installed' }, async (t) => {
  const browser = await launch(t);
  if (!browser) return;
  try {
    const ctx = await context(browser, { viewport: { width: 1280, height: 800 } }, () => {
      window.__copied = [];
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (s) => { window.__copied.push(s); } } });
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    // a file of one's own: nothing to share
    await page.goto('http://texglass.test/index.html');
    await page.waitForSelector('#preview h2');
    assert.equal(await page.isVisible('#share'), true);
    assert.equal(await page.isDisabled('#share'), true);

    await page.goto('http://texglass.test/index.html?arxiv=2301.00001');
    await page.waitForFunction(() => /Shared heat bounds/.test(document.getElementById('preview').textContent));
    await page.waitForFunction(() => !document.getElementById('share').disabled);

    // at the top: just the paper
    await page.click('#share');
    await page.waitForFunction(() => window.__copied.length === 1);
    assert.equal((await page.evaluate(() => window.__copied))[0], 'https://texglass.js.org/?arxiv=2301.00001');
    assert.match(await page.textContent('#status'), /Link copied/);

    // read on into section 2: the link opens there
    await page.evaluate(() => {
      const pane = document.getElementById('preview-pane');
      const h = [...document.querySelectorAll('#preview h2')].find((x) => /Estimates/.test(x.textContent));
      pane.scrollTop += h.getBoundingClientRect().top - pane.getBoundingClientRect().top + 200;
    });
    await page.waitForTimeout(200);
    await page.click('#share');
    await page.waitForFunction(() => window.__copied.length === 2);
    const link = (await page.evaluate(() => window.__copied))[1];
    assert.equal(link, 'https://texglass.js.org/?arxiv=2301.00001&goto=§2');
    assert.match(await page.textContent('#status'), /opens at §2/);

    const other = await ctx.newPage();
    await other.goto(link.replace('https://texglass.js.org/', 'http://texglass.test/index.html'));
    await other.waitForFunction(() => /Shared heat bounds/.test(document.getElementById('preview').textContent));
    await other.waitForTimeout(1200);
    // Go to shows the heading in the middle of the window
    const seen = await other.evaluate(() => {
      const h = [...document.querySelectorAll('#preview h2')].find((x) => /Estimates/.test(x.textContent));
      const r = h.getBoundingClientRect();
      return r.top > 0 && r.bottom < innerHeight;
    });
    assert.equal(seen, true, 'section 2 is on screen');
    assert.deepEqual(errors, []);
    await ctx.close();
  } finally {
    await browser.close();
  }
});

test('on a phone: Share opens the share sheet, and the toolbar still fits', { skip: !playwright && 'Playwright is not installed' }, async (t) => {
  const browser = await launch(t);
  if (!browser) return;
  try {
    for (const name of ['iPhone 13', 'Pixel 5', 'iPhone SE']) {
      const ctx = await context(browser, playwright.devices[name], () => {
        window.__shared = [];
        navigator.share = async (d) => { window.__shared.push(d); };
      });
      const page = await ctx.newPage();
      await page.goto('http://texglass.test/index.html?arxiv=2301.00001');
      await page.waitForFunction(() => !document.getElementById('share').disabled);
      const bar = await page.evaluate(() => ({
        h: document.querySelector('.toolbar').offsetHeight,
        wide: document.documentElement.scrollWidth > innerWidth,
        share: document.getElementById('share').getBoundingClientRect(),
      }));
      assert.ok(bar.h < 70, `${name}: toolbar is one row (${bar.h}px)`);
      assert.equal(bar.wide, false, `${name}: nothing runs off the side`);
      assert.ok(bar.share.right <= (await page.evaluate(() => innerWidth)) && bar.share.height >= 44, `${name}: Share is on screen and large`);
      await page.tap('#share');
      await page.waitForFunction(() => window.__shared.length === 1);
      const d = (await page.evaluate(() => window.__shared))[0];
      assert.equal(d.url, 'https://texglass.js.org/?arxiv=2301.00001');
      assert.equal(d.title, 'Shared heat bounds');
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
});
