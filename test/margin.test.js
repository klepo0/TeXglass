'use strict';
// The margin column (src/margin.js): anchoring the reader's notes to the text,
// and, in a real browser, lifting \marginpar and \todo into the margin and
// keeping highlights on their text while the document changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { describe, locate } = require('../src/margin.js');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');

test('an anchor is found again after text is added before it', () => {
  const text = 'Alpha beta gamma. The main difficulty is renormalisation. Delta.';
  const s = text.indexOf('main difficulty');
  const a = describe(text, s, s + 'main difficulty'.length);
  assert.equal(a.quote, 'main difficulty');
  const edited = 'A new first sentence. ' + text;
  const at = locate(edited, a, null);
  assert.equal(edited.slice(at.start, at.end), 'main difficulty');
  assert.equal(at.exact, true);
});

test('of several equal quotes, the one with the same surroundings wins', () => {
  const text = 'We prove the bound here. Later, the bound fails in dimension three. Finally the bound holds.';
  const s = text.indexOf('bound fails') ;
  const a = describe(text, s, s + 5); // the second "bound"
  const edited = 'Intro: the bound matters. ' + text;
  const at = locate(edited, a, null);
  assert.equal(at.start, edited.indexOf('bound fails'));
});

test('the source line decides between quotes with the same surroundings', () => {
  const text = 'x the end y. '.repeat(3);
  const a = { quote: 'end', prefix: 'x the ', suffix: ' y.' };
  const starts = [...text.matchAll(/end/g)].map((m) => m.index);
  assert.equal(locate(text, a, starts[2] - 5).start, starts[2]);
  assert.equal(locate(text, a, starts[0]).start, starts[0]);
});

test('an edited quote is found by its first and last words', () => {
  const text = 'Some text. The solution exists globally in time, as shown. More.';
  const s = text.indexOf('The solution');
  const a = describe(text, s, s + 'The solution exists globally in time'.length);
  const edited = text.replace('exists globally', 'exists for all times, globally');
  const at = locate(edited, a, null);
  assert.equal(at.exact, false);
  assert.equal(edited.slice(at.start, at.end), 'The solution exists for all times, globally in time');
});

test('a note on a point is found by the text around it; a lost quote falls back to it', () => {
  const text = 'First paragraph. Theorem 1 then follows by a fixed point argument.';
  const i = text.indexOf('by a fixed');
  const a = describe(text, i, i);
  assert.equal(a.quote, '');
  const edited = 'New text. ' + text;
  assert.equal(locate(edited, a, null).start, edited.indexOf('by a fixed'));
  // The quote is gone but its surroundings are still there: an empty match where it was.
  const gone = locate('Before it. After it.', { quote: 'removed words', prefix: 'Before it.', suffix: ' After it.' }, null);
  assert.deepEqual([gone.start, gone.end, gone.exact], [10, 10, false]);
  assert.equal(locate('Nothing alike.', { quote: 'removed words', prefix: 'zzzzzzzzzz', suffix: 'qqqqqqqqqq' }, null), null);
});

const DOC = (extra) => `
<div class="src-block" data-s="0" data-e="10"><h2 class="section">1 Introduction</h2></div>
${extra || ''}
<div class="src-block" data-s="10" data-e="20"><p>Let u solve the equation.<span class="mnote mnote-par"><span class="mnote-body">A marginal remark.</span></span> We work on the torus throughout.</p></div>
<div class="src-block" data-s="20" data-e="30"><p>The main difficulty is renormalisation.<span class="mnote mnote-todo" style="--note-c:green"><span class="mnote-body">Cite this.</span></span> In two dimensions one subtracts a constant.</p></div>
<div class="src-block" data-s="30" data-e="40"><p>Theorem 1 then follows by a fixed point argument.</p></div>`;

test('the margin in a browser: author notes, highlights and notes that follow their text', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    await page.setContent(`<style>${fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')}</style>` +
      `<main class="panes"><section class="pane" id="pane"><article id="preview" class="document">${DOC()}</article></section></main>`);
    await page.addScriptTag({ path: path.join(ROOT, 'src/margin.js') });
    await page.evaluate(() => {
      const doc = document.getElementById('preview');
      window.saved = [];
      window.margin = TeXglassMargin.attach({
        pane: document.getElementById('pane'),
        doc,
        study: true,
        files: () => ['paper.tex'],
        blocks: () => Array.from(doc.querySelectorAll('.src-block')).map((el, k) => ({ el, line: k * 3, file: 0 })),
        save: (list) => window.saved.push(list),
      });
      window.margin.refresh();
    });

    // \marginpar and \todo: two cards beside their lines, the text narrower.
    const cards = await page.evaluate(() => Array.from(document.querySelectorAll('.tg-mcard')).map((c) => {
      const r = c.getBoundingClientRect();
      return { text: c.textContent, cls: c.className, left: r.left, top: r.top };
    }));
    assert.deepEqual(cards.map((c) => c.text), ['A marginal remark.', 'Cite this.']);
    assert.match(cards[1].cls, /tg-mcard-todo/);
    const textRight = await page.evaluate(() => document.querySelector('#preview p').getBoundingClientRect().right);
    assert.ok(cards[0].left > textRight, 'the cards are right of the text');
    const lineTop = await page.evaluate(() => document.querySelectorAll('#preview p')[1].getBoundingClientRect().top);
    assert.ok(Math.abs(cards[1].top - lineTop) < 12, 'a card is level with its line');

    // Select "main difficulty" and highlight it from the bar.
    await page.evaluate(() => {
      const t = document.querySelectorAll('#preview p')[1].firstChild;
      const r = document.createRange();
      r.setStart(t, 4);
      r.setEnd(t, 19);
      getSelection().addRange(r);
      t.parentElement.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
    });
    await page.waitForFunction(() => !document.querySelector('.tg-hlbar').hidden);
    await page.click('.tg-swatch[data-color="green"]');
    const list = await page.evaluate(() => window.saved[window.saved.length - 1]);
    assert.equal(list.length, 1);
    assert.equal(list[0].color, 'green');
    assert.deepEqual([list[0].anchor.quote, list[0].anchor.file, list[0].anchor.line], ['main difficulty', 'paper.tex', 7]);

    // A note on a point, given as the host would load it.
    await page.evaluate((hl) => {
      const t = 'Theorem 1 then follows ';
      window.margin.setAnnotations([hl, { id: 'n1', note: 'Why?', anchor: { file: 'paper.tex', line: 10, quote: '', prefix: t, suffix: 'by a fixed point argument.' } }]);
    }, list[0]);
    assert.equal(await page.locator('.tg-mcard-user').count(), 1);

    // The document changes above them: both stay on their text.
    await page.evaluate((html) => {
      document.getElementById('preview').innerHTML = html;
      window.margin.refresh();
    }, DOC('<div class="src-block" data-s="0" data-e="1"><p>A new paragraph that mentions the main difficulty in passing.</p></div>'));
    // New blocks get their real height on the next frames (content-visibility); the margin follows.
    await page.waitForTimeout(200);
    const after = await page.evaluate(() => {
      const r = [...CSS.highlights.get('tg-hl-green')][0];
      const card = document.querySelector('.tg-mcard-user').getBoundingClientRect();
      const theorem = document.querySelectorAll('#preview p')[3].getBoundingClientRect();
      return { text: r.toString(), para: r.startContainer.parentElement.textContent.slice(0, 20), cardTop: card.top, lineTop: theorem.top };
    });
    assert.equal(after.text, 'main difficulty');
    assert.equal(after.para, 'The main difficulty ');
    assert.ok(Math.abs(after.cardTop - after.lineTop) < 12, 'the note is level with its line: ' + JSON.stringify(after));

    // Deleting the note from its card.
    await page.hover('.tg-mcard-user');
    await page.click('.tg-mcard-del');
    const last = await page.evaluate(() => window.saved[window.saved.length - 1]);
    assert.deepEqual(last.map((a) => a.id), [list[0].id]);

    // With the study tools off, highlights and notes are hidden; author notes stay.
    await page.evaluate(() => window.margin.setStudy(false));
    assert.equal(await page.evaluate(() => CSS.highlights.has('tg-hl-green')), false);
    assert.equal(await page.locator('.tg-mcard').count(), 2);
  } finally {
    await browser.close();
  }
});

test('the margin\'s divider drags to resize it, and a double-click goes back to the automatic width', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    await page.setContent(`<style>${fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')}</style>` +
      `<main class="panes"><section class="pane" id="pane"><article id="preview" class="document">${DOC()}</article></section></main>`);
    await page.addScriptTag({ path: path.join(ROOT, 'src/margin.js') });
    await page.evaluate(() => {
      window.widths = [];
      window.margin = TeXglassMargin.attach({
        pane: document.getElementById('pane'),
        doc: document.getElementById('preview'),
        width: 200,
        onWidth: (w) => window.widths.push(w),
      });
      window.margin.refresh();
    });
    const width = () => page.evaluate(() => Math.round(document.querySelector('.tg-margin').getBoundingClientRect().width));
    assert.equal(await width(), 200, 'the remembered width is used');
    const box = await page.locator('.tg-margin-grip').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 80, box.y + 40, { steps: 5 });
    await page.mouse.up();
    assert.equal(await width(), 280, 'dragging left widens the margin');
    assert.deepEqual(await page.evaluate(() => window.widths), [280]);
    const cardLeft = await page.evaluate(() => document.querySelector('.tg-mcard').getBoundingClientRect().left);
    const textRight = await page.evaluate(() => document.querySelector('#preview p').getBoundingClientRect().right);
    assert.ok(cardLeft > textRight, 'the text makes room for the wider margin');
    await page.focus('.tg-margin-grip');
    await page.keyboard.press('ArrowRight');
    assert.equal(await width(), 260);
    await page.dblclick('.tg-margin-grip');
    assert.equal(await page.evaluate(() => window.widths[window.widths.length - 1]), null);
  } finally {
    await browser.close();
  }
});

test('the margin folds away with its button or by dragging its divider, and opens again', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    await page.setContent(`<style>${fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')}</style>` +
      `<main class="panes"><section class="pane" id="pane"><article id="preview" class="document">${DOC()}</article></section></main>`);
    await page.addScriptTag({ path: path.join(ROOT, 'src/margin.js') });
    await page.evaluate(() => {
      window.folds = [];
      window.widths = [];
      window.margin = TeXglassMargin.attach({
        pane: document.getElementById('pane'),
        doc: document.getElementById('preview'),
        width: 200,
        onWidth: (w) => window.widths.push(w),
        onCollapse: (on) => window.folds.push(on),
      });
      window.margin.refresh();
    });
    const state = () => page.evaluate(() => ({
      folded: window.margin.collapsed(),
      cards: Array.from(document.querySelectorAll('.tg-mcard')).filter((c) => c.getClientRects().length).length,
      textRight: Math.round(document.querySelector('#preview p').getBoundingClientRect().right),
      width: Math.round(document.querySelector('.tg-margin').getBoundingClientRect().width),
    }));
    const open = await state();
    assert.deepEqual([open.folded, open.cards, open.width], [false, 2, 200]);

    // The button folds it: no cards, and the text takes the room back.
    await page.click('.tg-margin-toggle');
    const shut = await state();
    assert.deepEqual([shut.folded, shut.cards], [true, 0]);
    assert.ok(shut.textRight > open.textRight + 80, 'the text widens: ' + JSON.stringify([open, shut]));
    assert.match(await page.getAttribute('.tg-margin-toggle', 'title'), /2 margin notes/);
    assert.deepEqual(await page.evaluate(() => window.folds), [true]);

    // Clicking a note's dot in the text opens it again.
    await page.evaluate(() => document.querySelector('.mnote-todo').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    assert.equal((await state()).folded, false);

    // Dragging the divider all the way right folds it; the width is kept for later.
    let box = await page.locator('.tg-margin-grip').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 180, box.y + 40, { steps: 6 });
    await page.mouse.up();
    assert.equal((await state()).folded, true);
    assert.deepEqual(await page.evaluate(() => window.folds), [true, false, true]);
    assert.deepEqual(await page.evaluate(() => window.widths), []);

    // Dragging the folded button left pulls the margin out to that width.
    box = await page.locator('.tg-margin-toggle').boundingBox();
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 4 - 240, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    const pulled = await state();
    assert.equal(pulled.folded, false);
    assert.ok(Math.abs(pulled.width - 240) <= 2, 'pulled out to ' + pulled.width);
    assert.equal(pulled.cards, 2);
    assert.deepEqual(await page.evaluate(() => window.folds), [true, false, true, false]);

    // The host can fold it (a remembered state) without being told back.
    await page.evaluate(() => window.margin.setCollapsed(true));
    assert.equal((await state()).folded, true);
    assert.equal(await page.evaluate(() => window.folds.length), 4);
  } finally {
    await browser.close();
  }
});
