'use strict';
// Back and forward after a jump (src/scroll.js history): the Back button over
// the preview, Alt+Left and Alt+Right, and the way back to the very spot left,
// even though blocks off screen only have estimated heights. Runs in a real
// browser and is skipped where Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const TeXglass = require('../src/texglass.js');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const paras = Array.from({ length: 400 }, (_, i) => `Paragraph ${i}: some words to take up room on the page, and a few more so it wraps onto a second line now and then.`);
const DOC = String.raw`\documentclass{article}
\begin{document}
${paras.slice(0, 300).join('\n\n')}

\begin{theorem}\label{thm:far}A far result.\end{theorem}

${paras.slice(300).join('\n\n')}
\end{document}`;

test('Back returns to the spot before a jump, Forward redoes it, and near jumps or typing do not count', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const r = TeXglass.render(DOC, { sourceMap: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.setContent(`<style>${fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')}</style>` +
      `<main class="panes"><section class="pane" id="preview-pane" style="height:700px;overflow:auto"><article id="preview" class="document">${r.blocks.join('\n')}</article></section></main>` +
      '<textarea id="box"></textarea>');
    await page.addScriptTag({ path: path.join(ROOT, 'src/scroll.js') });
    await page.evaluate(() => {
      window.pane = document.getElementById('preview-pane');
      window.h = TeXglassScroll.history(pane, { keys: window });
    });
    const bar = page.locator('.tg-history');
    assert.equal(await bar.isHidden(), true, 'no button before any jump');

    // A jump to something already on screen is not remembered.
    await page.evaluate(() => TeXglassScroll.to(pane, document.querySelectorAll('#preview > .src-block')[3], { smooth: false }));
    await page.waitForTimeout(300);
    assert.equal(await bar.isHidden(), true, 'a near jump shows no button');

    // Read a little way in, at a spot partway into a paragraph.
    await page.evaluate(() => { pane.scrollTop = 1234; });
    await page.waitForTimeout(100);
    const firstLine = () => page.evaluate(() => {
      const top = pane.getBoundingClientRect().top;
      const b = [...document.querySelectorAll('#preview > .src-block')].find((x) => x.getBoundingClientRect().bottom > top);
      return { text: b.textContent.slice(0, 14), off: Math.round(b.getBoundingClientRect().top - top) };
    });
    const before = await firstLine();

    await page.evaluate(() => TeXglassScroll.to(pane, document.querySelector('.theorem, [id="thm:far"]') || document.getElementById('thm:far'), { align: 'center' }));
    await page.waitForTimeout(900);
    assert.equal(await bar.isVisible(), true, 'Back shows after a far jump');
    assert.equal(await page.locator('.tg-history-fwd').isHidden(), true, 'no Forward yet');
    const there = await firstLine();
    assert.notEqual(there.text, before.text);

    // Alt+Left in a text box is the text box's.
    await page.focus('#box');
    await page.keyboard.press('Alt+ArrowLeft');
    await page.waitForTimeout(300);
    assert.deepEqual(await firstLine(), there, 'Alt+Left while typing does nothing');
    await page.evaluate(() => document.activeElement.blur());

    await page.keyboard.press('Alt+ArrowLeft');
    await page.waitForTimeout(900);
    assert.deepEqual(await firstLine(), before, 'Back to the same spot');
    assert.equal(await page.locator('.tg-history-fwd').isVisible(), true, 'Forward shows after going back');
    assert.equal(await page.locator('.tg-history-back').isDisabled(), true, 'nothing further back');

    await page.locator('.tg-history-fwd').click();
    await page.waitForTimeout(900);
    assert.equal((await firstLine()).text, there.text, 'Forward to the jump again');

    await page.locator('.tg-history-back').click();
    await page.waitForTimeout(900);
    assert.deepEqual(await firstLine(), before, 'the Back button works too');

    await page.evaluate(() => h.clear());
    assert.equal(await bar.isHidden(), true, 'cleared for a new document');
  } finally {
    await browser.close();
  }
});
