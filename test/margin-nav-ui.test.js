'use strict';
// Jumping from margin note to margin note (src/margin.js): the arrows under the
// margin's fold button, N and Shift+N, and the menu that narrows the jumps to
// one kind of note. Runs in a real browser and is skipped where Playwright and
// a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const TeXglass = require('../src/texglass.js');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const filler = (n) => Array.from({ length: n }, (_, i) => `Filler paragraph ${i} with some words to take up room on the page.`).join('\n\n');

// In the order of the text: a margin note, a todo, (the reader's note), a todo, a margin note.
const DOC = String.raw`\documentclass{article}
\usepackage{todonotes}
\begin{document}
First words.\marginpar{Note one.}

${filler(30)}

Second place.\todo{Todo two.}

${filler(30)}

Here is the reader target sentence.

${filler(30)}

Third place.\todo{Todo three.}

${filler(30)}

Last place.\marginpar{Note four.}
\end{document}`;

test('N, Shift+N and the arrows jump between notes in order, and the menu narrows them to one kind', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const r = TeXglass.render(DOC, { sourceMap: true });
    const page = await browser.newPage({ viewport: { width: 1100, height: 600 } });
    await page.setContent(`<style>${fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')}</style>` +
      `<main class="panes"><section class="pane" id="pane" style="height:600px;overflow:auto"><article id="preview" class="document">${r.blocks.join('\n')}</article></section></main>`);
    await page.addScriptTag({ path: path.join(ROOT, 'src/scroll.js') });
    await page.addScriptTag({ path: path.join(ROOT, 'src/margin.js') });
    await page.evaluate(() => {
      const doc = document.getElementById('preview');
      window.filters = [];
      window.margin = TeXglassMargin.attach({
        pane: document.getElementById('pane'),
        doc,
        study: true,
        files: () => ['paper.tex'],
        blocks: () => [],
        onFilter: (k) => window.filters.push(k),
      });
      const text = 'reader target sentence';
      window.margin.setAnnotations([{ id: 'mine1', note: 'My own note.', anchor: { quote: text, prefix: 'Here is the ', suffix: '.' } }]);
    });
    assert.equal(await page.locator('.tg-mcard').count(), 5);

    // Which card lit up, and is its line in the middle of the pane?
    const landed = async () => {
      await page.waitForFunction(() => document.querySelector('.tg-mcard-pulse'));
      await page.waitForTimeout(700);
      return page.evaluate(() => {
        const c = document.querySelector('.tg-mcard-pulse');
        const p = document.getElementById('pane');
        const box = p.getBoundingClientRect();
        const r = c.getBoundingClientRect();
        return { text: c.textContent.trim(), centred: Math.abs(r.top + 8 - (box.top + p.clientHeight / 2)) < 60 || p.scrollTop + p.clientHeight >= p.scrollHeight - 2 };
      });
    };
    const press = async (key) => {
      await page.evaluate(() => document.querySelectorAll('.tg-mcard-pulse').forEach((c) => c.classList.remove('tg-mcard-pulse')));
      await page.keyboard.press(key);
      return landed();
    };

    await page.locator('body').click({ position: { x: 5, y: 5 } });
    // The first note is at the top, above the middle: N goes to the second.
    let at = await press('n');
    assert.equal(at.text, 'Todo two.');
    assert.ok(at.centred, 'the note is brought to the middle of the pane');
    assert.match((await press('n')).text, /My own note/);
    assert.equal((await press('n')).text, 'Todo three.');
    assert.equal((await press('n')).text, 'Note four.');
    assert.equal((await press('n')).text, 'Note one.', 'past the last note, back to the first');
    assert.equal((await press('Shift+N')).text, 'Note four.', 'and back the other way');
    assert.equal((await press('Shift+N')).text, 'Todo three.');

    // The arrows do the same.
    await page.evaluate(() => document.querySelectorAll('.tg-mcard-pulse').forEach((c) => c.classList.remove('tg-mcard-pulse')));
    await page.locator('.tg-mnav-prev').click();
    assert.match((await landed()).text, /My own note/);

    // Only todo notes: the others fade, and N skips them.
    await page.locator('.tg-mnav-filter').click();
    const items = await page.locator('.tg-mnav-menu [data-kind]').allTextContents();
    assert.deepEqual(items, ['All notes5', 'Margin notes2', 'Todo notes2', 'My notes and highlights1']);
    await page.locator('.tg-mnav-menu [data-kind="todo"]').click();
    assert.equal(await page.locator('.tg-mnav-menu').isHidden(), true);
    assert.deepEqual(await page.evaluate(() => window.filters), ['todo']);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.tg-mcard-par')).opacity), '0.35');
    assert.equal((await press('n')).text, 'Todo three.');
    assert.equal((await press('n')).text, 'Todo two.');
    assert.match(await page.locator('.tg-mnav-next').getAttribute('title'), /Next todo note \(N\)/);

    // N in a text field is typing, not a jump.
    await page.evaluate(() => { const i = document.createElement('input'); i.id = 'box'; document.body.appendChild(i); });
    await page.locator('#box').focus();
    const before = await page.evaluate(() => document.getElementById('pane').scrollTop);
    await page.keyboard.press('n');
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => document.getElementById('pane').scrollTop), before);
    assert.equal(await page.locator('#box').inputValue(), 'n');

    // Folded, the arrows still work: the note is a dot in the text.
    await page.evaluate(() => { window.margin.setCollapsed(true); window.margin.setFilter('all'); document.getElementById('box').blur(); });
    assert.equal(await page.locator('.tg-margin-nav').isVisible(), true);
    await page.locator('.tg-mnav-next').click(); // the reader's note, after Todo two
    await page.waitForTimeout(400);
    await page.locator('.tg-mnav-next').click();
    await page.waitForFunction(() => document.querySelector('.tg-mnote-pulse'));
    assert.match(await page.evaluate(() => document.querySelector('.tg-mnote-pulse').textContent), /Todo three/);
  } finally {
    await browser.close();
  }
});
