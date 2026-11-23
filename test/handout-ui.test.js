'use strict';
// Show only these: under each pinned result, what it rests on (the definitions it
// refers to and the notation its formulas use), folded; and the view as a
// handout to print or download as an EPUB: the pins in the reading order with
// their notes, then the definitions and notation used (src/pick.js handout,
// src/insight.js contextOf). Skipped where Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };

const DOC = '\\documentclass{article}\n\\title{Handouts}\n\\newtheorem{lemma}{Lemma}[section]\n\\newtheorem{theorem}[lemma]{Theorem}\n' +
  '\\theoremstyle{definition}\\newtheorem{definition}[lemma]{Definition}\n\\newcommand{\\R}{\\mathbb{R}}\n\\begin{document}\n\\maketitle\n\\section{Setting}\n' +
  'Let $\\mu$ be a probability measure on $\\R$.\n' +
  '\\begin{definition}\\label{def:tame} A function $f$ is tame if $|f| \\le 1$.\\end{definition}\n' +
  '\\begin{definition}\\label{def:calm} A function is calm if it is tame in the sense of Definition~\\ref{def:tame} and constant.\\end{definition}\n' +
  '\\section{Results}\n' +
  '\\begin{lemma}\\label{first} Every constant is tame.\\end{lemma}\\begin{proof} Clear.\\end{proof}\n' +
  '\\begin{theorem}\\label{main} If $g$ is calm in the sense of Definition~\\ref{def:calm}, then $\\int g \\, d\\mu \\le 1$.\\end{theorem}\\begin{proof} By Lemma~\\ref{first}.\\end{proof}\n\\end{document}';

async function serve(page) {
  await page.route('http://texglass.test/**', (route) => {
    const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
    const file = path.join(ROOT, p);
    if (p === 'sw.js' || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(p)] || 'application/octet-stream' });
  });
}

/** The files of a zip (stored or deflated), by name, as text. */
function unzip(buf) {
  const out = {};
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const size = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extra = buf.readUInt16LE(i + 28);
    const name = buf.slice(i + 30, i + 30 + nameLen).toString();
    const data = buf.slice(i + 30 + nameLen + extra, i + 30 + nameLen + extra + size);
    out[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString();
    i += 30 + nameLen + extra + size;
  }
  return out;
}

test('Show only these: what a pin rests on, folded; a handout to print or read as an e-book', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, acceptDownloads: true });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await serve(page);
    await page.goto('http://texglass.test/index.html');
    await page.waitForSelector('#preview h1, #preview h2, #preview .section');
    await page.setInputFiles('#file-input', { name: 'notes.tex', mimeType: 'text/x-tex', buffer: Buffer.from(DOC) });
    await page.waitForFunction(() => document.querySelectorAll('#preview .theorem').length >= 4);
    const pinThm = async (label) => {
      await page.hover(`#preview .theorem[data-label="${label}"]`);
      await page.waitForSelector(`#preview .theorem[data-label="${label}"] .tg-pin-btn`, { state: 'attached' });
      await page.evaluate((l) => document.querySelector(`#preview .theorem[data-label="${l}"] .tg-pin-btn`).click(), label);
    };
    await pinThm('main');
    await pinThm('first');

    // a reading order (the theorem first) and a note on the theorem
    await page.click('#pins');
    await page.click('[data-pins-view="order"]');
    const rows = () => page.$$eval('.tg-pins-menu .tg-pins-row', (rs) => rs.map((r) => r.dataset.key));
    // (a move makes the order the reader's own)
    await page.focus('[data-pins-drag="label:first"]');
    await page.keyboard.press((await rows())[0] === 'label:first' ? 'ArrowDown' : 'ArrowUp');
    if ((await rows())[0] !== 'label:main') {
      await page.focus('[data-pins-drag="label:main"]');
      await page.keyboard.press('ArrowUp');
    }
    assert.deepEqual(await rows(), ['label:main', 'label:first']);
    await page.click('[data-pins-memo="label:main"].tg-pins-pen');
    await page.fill('[data-pins-memo-in="label:main"]', 'the point of it all');
    await page.keyboard.press('Enter');
    await page.click('[data-pins-act="show"]');
    await page.waitForSelector('#preview.pick-view');

    // under the theorem: what it rests on, folded; both definitions (the second refers to the first), and μ
    const ctx = page.locator('#preview .theorem[data-label="main"] + .pick-context');
    await ctx.waitFor();
    assert.equal(await ctx.evaluate((d) => d.open), false);
    const summary = await ctx.locator('summary').innerText();
    assert.match(summary, /Rests on/);
    assert.match(summary, /Definition 1\.2/);
    assert.match(summary, /Definition 1\.1/);
    assert.match(summary, /notation/);
    await ctx.locator('summary').click();
    assert.equal(await ctx.evaluate((d) => d.open), true);
    assert.equal(await ctx.locator('.pick-ctx-def .theorem').count(), 2);
    assert.equal(await ctx.locator('.pick-ctx-def [id]').count(), 0, 'copies carry no ids');
    assert.match(await ctx.locator('.pick-ctx-syms').innerText(), /probability measure/);
    // the lemma rests on nothing: no fold under it
    assert.equal(await page.locator('#preview .theorem[data-label="first"] + .pick-context').count(), 0);

    // Print: the handout goes into the page alone, then leaves after printing.
    // It has the reading order with the note, the theorem before the lemma, then what they rest on
    await page.evaluate(() => {
      window.__printed = null;
      window.print = () => {
        const box = document.querySelector('#preview > .pick-handout');
        window.__printed = !box ? false : {
          printing: document.querySelector('#preview').classList.contains('pick-printing'),
          order: Array.from(box.querySelectorAll('.pick-handout-order li')).map((li) => li.textContent.replace(/\s+/g, ' ').trim()),
          items: Array.from(box.querySelectorAll(':scope > .pick-handout-item > .theorem .thm-name')).map((x) => x.textContent.trim()),
          ctx: Array.from(box.querySelectorAll('.pick-handout-context .theorem .thm-name')).map((x) => x.textContent.trim()),
          syms: (box.querySelector('.pick-handout-context .pick-ctx-syms') || {}).textContent || '',
          title: (box.querySelector('.title-block') || {}).textContent || '',
          from: (box.querySelector('.pick-handout-from') || {}).textContent || '',
          ids: box.querySelectorAll('[id]').length,
          buttons: box.querySelectorAll('button, .pick-box, .tg-pin-btn').length,
        };
      };
    });
    await page.click('.pick-bar [data-act="print"]');
    await page.waitForFunction(() => window.__printed !== null);
    const h = await page.evaluate(() => window.__printed);
    assert.ok(h, 'the handout is in the page while printing');
    assert.equal(h.printing, true);
    assert.match(h.title, /Handouts/);
    assert.deepEqual(h.order, ['Theorem 2.2 the point of it all', 'Lemma 2.1']);
    assert.equal(h.from, 'From §2 Results');
    assert.deepEqual(h.items, ['Theorem 2.2', 'Lemma 2.1']);
    assert.deepEqual(h.ctx, ['Definition 1.1', 'Definition 1.2']);
    assert.match(h.syms, /probability measure/);
    assert.equal(h.ids, 0);
    assert.equal(h.buttons, 0);
    // on paper only the handout shows
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.locator('#preview > .pick-handout').isVisible(), true);
    assert.equal(await page.locator('#preview > :not(.pick-handout) .theorem[data-label="main"]').first().isVisible(), false);
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    assert.equal(await page.locator('#preview > .pick-handout').count(), 0);

    // EPUB downloads the handout as a short e-book
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.pick-bar [data-act="epub"]')]);
    assert.match(dl.suggestedFilename(), /^notes-handout\.epub$/);
    const files = unzip(fs.readFileSync(await dl.path()));
    const text = Object.entries(files).filter(([n]) => /\.xhtml$/.test(n) && !/nav/.test(n)).map(([, v]) => v).join('\n');
    assert.match(files['OEBPS/content.opf'], /<dc:title>Handouts \(handout\)<\/dc:title>/);
    assert.match(text, /Reading order/);
    assert.match(text, /the point of it all/);
    assert.match(text, /Definitions and notation used/);
    assert.ok(text.indexOf('Theorem 2.2') < text.indexOf('Lemma 2.1'));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
