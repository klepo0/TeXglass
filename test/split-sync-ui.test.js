'use strict';
// In Split mode the panes stay aligned through a long offscreen block and when
// switching which pane drives the scroll. Requires Playwright and a browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };

const paras = (name, n) => Array.from({ length: n }, (_, i) =>
  `${name} paragraph ${i}. This sentence is here to make the paragraph wrap over a few lines in both panes.\n\n`).join('');
const DOC = `\\documentclass{article}\n\\newenvironment{wrapped}{\\begingroup}{\\par\\endgroup}\n\\begin{document}\n\\section{Start}\n` +
  paras('Opening', 40) + `\\begin{wrapped}\n${paras('Wrapped', 120)}\\end{wrapped}\n\n` + paras('Closing', 20) + '\\end{document}\n';

test('Split mode keeps the preview with the source inside one long block', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
    await page.route('http://texglass.test/**', (route) => {
      const p = new URL(route.request().url()).pathname.replace(/^\//, '') || 'index.html';
      const file = path.join(ROOT, p);
      if (p === 'sw.js' || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      route.fulfill({ body: fs.readFileSync(file), contentType: TYPES[path.extname(p)] || 'application/octet-stream' });
    });
    await page.goto('http://texglass.test/index.html');
    await page.waitForSelector('#preview h1, #preview h2, #preview .section');
    await page.click('#mode-split');
    await page.fill('#source', DOC);
    await page.waitForFunction(() => document.getElementById('preview').textContent.includes('Closing paragraph 19'));
    // Enter Split with the long block outside the viewport.
    await page.click('#mode-preview');
    await page.locator('#preview-pane').evaluate((pane) => {
      pane.dispatchEvent(new WheelEvent('wheel'));
      pane.scrollTop = 0;
    });
    await page.waitForTimeout(200);
    await page.click('#mode-split');
    await page.waitForFunction(() => document.getElementById('source').scrollTop === 0 &&
      document.getElementById('preview-pane').scrollTop === 0);
    await page.waitForTimeout(300);
    const previewHeight = () => page.locator('#preview-pane').evaluate((pane) => pane.scrollHeight);
    const initialHeight = await previewHeight();

    // Which numbered paragraph is at the top of each pane.
    const tops = () => page.evaluate(() => {
      const first = (root, top) => {
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n; (n = walk.nextNode());) {
          const re = /(Opening|Wrapped|Closing) paragraph (\d+)/g;
          for (let m; (m = re.exec(n.data));) {
            const range = document.createRange();
            range.setStart(n, m.index);
            range.setEnd(n, m.index + m[0].length);
            const r = range.getBoundingClientRect();
            if (r.height && r.top >= top) return m[1] + ' ' + m[2];
          }
        }
        return null;
      };
      const layer = document.querySelector('.source-pane .hl-layer');
      const pane = document.getElementById('preview-pane');
      return { src: first(layer, layer.getBoundingClientRect().top), pre: first(document.getElementById('preview'), pane.getBoundingClientRect().top) };
    });

    // Scroll the source by small steps, as a mouse wheel would.
    const target = await page.evaluate(() => {
      const s = document.getElementById('source');
      return Math.round((s.scrollHeight - s.clientHeight) * 0.5);
    });
    await page.hover('#source');
    for (let y = 0; y < target; y += 150) {
      await page.mouse.wheel(0, 150);
      await page.waitForTimeout(25);
    }
    await page.waitForTimeout(500);
    assert.equal(await previewHeight(), initialHeight, 'offscreen blocks have their final height before scrolling');
    const at = await tops();
    assert.match(at.src, /^Wrapped /, `the source is inside the long block (${at.src})`);
    assert.match(at.pre, /^Wrapped /, `the preview is inside the long block too (${at.pre})`);
    const n = (s) => Number(s.split(' ')[1]);
    assert.ok(Math.abs(n(at.src) - n(at.pre)) <= 4, `both panes show the same place: source at ${at.src}, preview at ${at.pre}`);

    const end = await page.evaluate(async () => {
      const source = document.getElementById('source');
      const preview = document.getElementById('preview-pane');
      const frame = () => new Promise(requestAnimationFrame);
      const maxScroll = (pane) => pane.scrollHeight - pane.clientHeight;
      source.dispatchEvent(new WheelEvent('wheel'));
      source.scrollTop = maxScroll(source) / 3;
      await frame();
      const fromSource = preview.scrollTop;
      // Switch direction in the next frame, while the previous scroll is still settling.
      preview.dispatchEvent(new WheelEvent('wheel'));
      preview.scrollTop = maxScroll(preview);
      await frame();
      const sourceGap = maxScroll(source) - source.scrollTop;
      source.dispatchEvent(new WheelEvent('wheel'));
      source.scrollTop = 0;
      await frame();
      const previewAtTop = preview.scrollTop;
      source.scrollTop = maxScroll(source);
      await frame();
      return { fromSource, sourceGap, previewAtTop, previewGap: maxScroll(preview) - preview.scrollTop };
    });
    assert.ok(end.fromSource > 0 && end.fromSource < initialHeight, 'source scrolls the preview before switching panes');
    assert.equal(end.sourceGap, 0, 'switching to the preview and scrolling to the bottom also lands the source at the bottom');
    assert.equal(end.previewAtTop, 0, 'switching back to source and scrolling to the top also lands the preview at the top');
    assert.equal(end.previewGap, 0, 'scrolling to the source bottom also lands the preview at the bottom');

    await page.click('#mode-preview');
    const laterBlock = page.locator('#preview > .src-block').filter({ hasText: 'Closing paragraph 2.' });
    const blockOffset = () => laterBlock.evaluate((block) =>
      Math.round(block.getBoundingClientRect().top - document.getElementById('preview-pane').getBoundingClientRect().top));
    await page.locator('#preview-pane').dispatchEvent('wheel');
    await laterBlock.evaluate((block) => block.scrollIntoView({ block: 'start' }));
    await laterBlock.evaluate((block) => block.scrollIntoView({ block: 'start' }));
    const offsetBeforeSplit = await blockOffset();
    await page.click('#mode-split');
    await page.waitForFunction(() => document.getElementById('source').scrollTop > 0);
    assert.ok(Math.abs(await blockOffset() - offsetBeforeSplit) <= 1, 'opening Split keeps the current preview block in place');
    await page.click('#mode-preview');
    await page.waitForFunction((offset) => {
      const pane = document.getElementById('preview-pane');
      const block = [...pane.querySelectorAll('.src-block')].find((el) => el.textContent.startsWith('Closing paragraph 2.'));
      return Math.abs(block.getBoundingClientRect().top - pane.getBoundingClientRect().top - offset) <= 1;
    }, offsetBeforeSplit);
  } finally {
    await browser.close();
  }
});
