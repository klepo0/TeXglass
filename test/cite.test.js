'use strict';
// Citation previews (src/cite.js) and "What does this use?" (src/insight.js).
// The page parts run in a real browser and are skipped where Playwright and a
// browser are not installed. No test reaches the network: lookups get canned answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const katex = require('katex');
const TeXglass = require('../src/texglass.js');
const Cite = require('../src/cite.js');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const renderMath = (tex, displayMode, macros) => katex.renderToString(tex, { displayMode, macros, throwOnError: false, strict: 'ignore' });

test('arXiv ids and DOIs are read from entries and links', () => {
  assert.equal(Cite.arxivIdIn('A. Author, Paper, arXiv:2301.00001.'), '2301.00001');
  assert.equal(Cite.arxivIdIn('arXiv preprint arXiv:1303.5113v3, 2013'), '1303.5113');
  assert.equal(Cite.arxivIdIn('https://arxiv.org/abs/2301.12345v2'), '2301.12345');
  assert.equal(Cite.arxivIdIn('https://arxiv.org/pdf/math/0601001v1.pdf'), 'math/0601001');
  assert.equal(Cite.arxivIdIn('Preprint, arXiv: hep-th/9901001.'), 'hep-th/9901001');
  assert.equal(Cite.arxivIdIn('doi:10.48550/arXiv.2205.01234'), '2205.01234');
  assert.equal(Cite.arxivIdIn('Available on arXiv. Ann. Probab. 12 (1984).'), null);
  assert.equal(Cite.doiIn('Ann. Math. (2) 1 (2020). doi:10.4007/annals.2020.191.1.1.'), '10.4007/annals.2020.191.1.1');
  assert.equal(Cite.doiIn('(see https://doi.org/10.1002/(SICI)1097-0312(199901)52:1<1::AID>3.0.CO;2-X)'), '10.1002/(SICI)1097-0312(199901)52:1');
  assert.equal(Cite.doiIn('no identifier here'), null);
});

test('a title counts as found only when the entry contains it', () => {
  const entry = 'A. Writer and B. Reader, On the shape of {Brownian} paths, J. Imag. Math. 3 (2001), 1–20.';
  assert.ok(Cite.titleInEntry('On the Shape of Brownian Paths', entry));
  assert.ok(!Cite.titleInEntry('On the shape of Brownian loops', entry));
  assert.ok(!Cite.titleInEntry('Paths', entry)); // too short to trust
});

/** A getJson that answers from a table of URL prefixes, and records what was asked. */
function canned(table) {
  const asked = [];
  const getJson = async (url) => {
    asked.push(url);
    for (const [prefix, json] of table) {
      if (url.startsWith(prefix)) {
        if (json instanceof Error) throw json;
        return json;
      }
    }
    throw Object.assign(new Error('HTTP 404'), { status: 404 });
  };
  return { asked, getJson };
}

const ARXIV_RECORD = {
  data: {
    id: '10.48550/arxiv.2301.00001',
    attributes: {
      doi: '10.48550/arxiv.2301.00001',
      identifiers: [{ identifier: '2301.00001', identifierType: 'arXiv' }],
      creators: [{ name: 'Writer, Ada', givenName: 'Ada', familyName: 'Writer' }],
      titles: [{ title: 'On the shape of Brownian paths' }],
      publicationYear: 2023,
      descriptions: [{ descriptionType: 'Abstract', description: 'We study the shape of $B_t$.' }],
    },
  },
};

test('an entry with an arXiv id is looked up in one request', async () => {
  const { asked, getJson } = canned([['https://api.datacite.org/dois/10.48550', ARXIV_RECORD]]);
  const r = await Cite.lookup({ text: 'A. Writer, Brownian paths, arXiv:2301.00001.', arxiv: '2301.00001', doi: null, title: '' }, getJson);
  assert.equal(asked.length, 1);
  assert.equal(r.title, 'On the shape of Brownian paths');
  assert.equal(r.abstract, 'We study the shape of $B_t$.');
  assert.deepEqual(r.authors, ['Ada Writer']);
  assert.equal(r.arxiv, '2301.00001');
});

test('an entry with neither id is matched by Crossref, then found on arXiv by its title', async () => {
  const text = 'A. Writer, On the shape of Brownian paths, J. Imag. Math. 3 (2001), 1–20.';
  const { asked, getJson } = canned([
    ['https://api.crossref.org/works?', { message: { items: [
      { DOI: '10.1/other', title: ['Something else entirely'] },
      { DOI: '10.1/jim.3', title: ['On the shape of Brownian paths'], author: [{ given: 'A.', family: 'Writer' }], issued: { 'date-parts': [[2001]] } },
    ] } }],
    ['https://api.datacite.org/dois?', { data: [ARXIV_RECORD.data] }],
    ['https://api.datacite.org/dois/', ARXIV_RECORD],
  ]);
  const r = await Cite.lookup({ text, arxiv: null, doi: null, title: '' }, getJson);
  assert.equal(r.doi, '10.1/jim.3');
  assert.equal(r.arxiv, '2301.00001');
  assert.equal(r.abstract, 'We study the shape of $B_t$.');
  assert.equal(asked.length, 2); // the title search already brings the abstract
});

test('a title found nowhere gives found: false; no network at all rejects', async () => {
  const { getJson } = canned([['https://api.datacite.org/dois?', { data: [] }]]);
  const r = await Cite.lookup({ text: 'X, “A book nobody indexed”, 1901.', arxiv: null, doi: null, title: 'A book nobody indexed' }, getJson);
  assert.equal(r.found, false);
  const offline = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(Cite.lookup({ text: 'X, “A book nobody indexed”, 1901.', arxiv: null, doi: null, title: 'A book nobody indexed' }, offline));
});

const DOC = String.raw`\documentclass{article}
\newtheorem{theorem}{Theorem}[section]
\newtheorem{lemma}[theorem]{Lemma}
\begin{document}
\section{Setting}
Some words before.
\begin{lemma}\label{l:one}
A bound,
\begin{equation}\label{e:bound} a \le b. \end{equation}
\end{lemma}
\begin{lemma}\label{l:two}
Another bound, see \cite{writer} and \cite{old}.
\end{lemma}
\begin{proof} Combine Lemma~\ref{l:one} with \eqref{e:bound}. \end{proof}
\begin{lemma}\label{l:three}
Unrelated.
\end{lemma}
\section{Main}
A paragraph of text.
\begin{theorem}\label{t:main}
Solutions exist.
\end{theorem}
\begin{proof} By Lemma~\ref{l:two}. \end{proof}
\begin{thebibliography}{9}
\bibitem{writer} A. Writer, \emph{On the shape of Brownian paths}, arXiv:2301.00001.
\bibitem{old} B. Reader, \emph{A book nobody indexed}, Imaginary Press, 1901.
\end{thebibliography}
\end{document}`;

async function page(browser, r) {
  const p = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await p.setContent(
    `<style>${fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')}</style>` +
    `<section class="pane" id="pane" style="height:100vh;overflow:auto"><article id="preview" class="document">${r.blocks.join('\n')}</article></section>`
  );
  await p.addScriptTag({ path: path.join(ROOT, 'src/insight.js') });
  await p.addScriptTag({ path: path.join(ROOT, 'src/cite.js') });
  return p;
}

test('a citation\'s note shows the abstract, an Open in TeXglass button, and only the entry offline', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const r = TeXglass.render(DOC, { renderMath, sourceMap: true });
    const p = await page(browser, r);
    const out = await p.evaluate(async (record) => {
      window.asked = [];
      window.opened = null;
      let isOnline = true;
      const cites = TeXglassCite.create({
        getJson: async (url) => {
          window.asked.push(url);
          if (url.includes('/dois/10.48550')) return record;
          if (url.includes('api.datacite.org/dois?')) return { data: [] };
          throw Object.assign(new Error('HTTP 404'), { status: 404 });
        },
        online: () => isOnline,
        openArxiv: (id) => { window.opened = id; },
      });
      const items = document.querySelectorAll('.bibliography li');
      const wait = (el) => new Promise((res) => {
        if (!el.querySelector('.cite-wait')) return res();
        new MutationObserver((_, o) => { if (!el.querySelector('.cite-wait')) { o.disconnect(); res(); } }).observe(el, { childList: true, subtree: true });
      });
      const a = cites.noteFor(items[0]);
      document.body.appendChild(a);
      const waiting = !!a.querySelector('.cite-wait');
      await wait(a);
      a.querySelector('.cite-open').click();
      const b = cites.noteFor(items[1]);
      document.body.appendChild(b);
      await wait(b);
      const askedBefore = window.asked.length;
      cites.noteFor(items[0]); // a second hover asks nothing again
      isOnline = false;
      const c = cites.noteFor(items[1]);
      return {
        waiting, a: a.textContent, opened: window.opened, b: b.textContent, c: c.textContent,
        again: window.asked.length - askedBefore, notBib: cites.noteFor(document.querySelector('.theorem')),
      };
    }, ARXIV_RECORD);
    assert.ok(out.waiting);
    assert.match(out.a, /We study the shape of/);
    assert.match(out.a, /Open in TeXglass/);
    assert.equal(out.opened, '2301.00001');
    assert.match(out.b, /Not found on arXiv or Crossref/);
    assert.match(out.c, /Offline: showing the entry/);
    assert.equal(out.again, 0);
    assert.equal(out.notBib, null);
  } finally {
    await browser.close();
  }
});

test('bibliography entries on arXiv get an Open in TeXglass button; others are looked up only on a rest', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const doc = DOC.replace('\\end{thebibliography}',
      '\\bibitem{journal} C. Someone, \\emph{Paths in random media revisited}, Ann. Probab. 12 (2020). doi:10.1214/99-AOP123.\n\\end{thebibliography}');
    const r = TeXglass.render(doc, { renderMath, sourceMap: true });
    const p = await page(browser, r);
    const out = await p.evaluate(async () => {
      window.asked = [];
      window.opened = [];
      let clicksSeen = 0;
      document.getElementById('preview').addEventListener('click', () => { clicksSeen++; });
      const cites = TeXglassCite.create({
        getJson: async (url) => {
          window.asked.push(url);
          if (url.includes('api.crossref.org/works/10.1214')) {
            return { message: { title: ['Paths in random media revisited'], DOI: '10.1214/99-AOP123', relation: {} } };
          }
          if (url.includes('api.datacite.org/dois?')) {
            return { data: [{ id: '10.48550/arxiv.2402.05555', attributes: { doi: '10.48550/arXiv.2402.05555', titles: [{ title: 'Paths in random media revisited' }], identifiers: [], publicationYear: 2024 } }] };
          }
          if (url.includes('/dois/10.48550')) return { data: { attributes: { titles: [{ title: 'x' }], descriptions: [] } } };
          throw Object.assign(new Error('HTTP 404'), { status: 404 });
        },
        online: () => true,
        openArxiv: (id) => { window.opened.push(id); },
      });
      const preview = document.getElementById('preview');
      const n = cites.decorate(preview);
      const again = cites.decorate(preview); // idempotent
      const items = [...document.querySelectorAll('.bibliography li')];
      const buttons = items.map((li) => li.querySelectorAll('.bib-open').length);
      const bodyText = items[0].querySelector('.bib-body').textContent;
      const label = getComputedStyle(items[0].querySelector('.bib-open'), '::after').content;
      items[0].querySelector('.bib-open').click();
      const askedBeforeRest = window.asked.length;
      // a quick pass over the third entry asks nothing; resting on it looks it up
      items[2].dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      items[2].dispatchEvent(new PointerEvent('pointerleave'));
      await new Promise((res) => setTimeout(res, 600));
      const askedAfterPass = window.asked.length;
      items[2].dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      await new Promise((res) => setTimeout(res, 900));
      const found = items[2].querySelector('.bib-open');
      return {
        n, again, buttons, bodyText, label, opened: window.opened, clicksSeen, askedBeforeRest, askedAfterPass,
        found: found && found.dataset.arxiv, asked: window.asked.length,
      };
    });
    assert.equal(out.n, 1);
    assert.equal(out.again, 1);
    assert.deepEqual(out.buttons, [1, 0, 0]);
    assert.doesNotMatch(out.bodyText, /Open in TeXglass/); // copying the entry does not pick up the label
    assert.equal(out.label, '"Open in TeXglass"');
    assert.deepEqual(out.opened, ['2301.00001']);
    assert.equal(out.clicksSeen, 0); // the host's click handlers never see it
    assert.equal(out.askedBeforeRest, 0); // nothing is asked while decorating
    assert.equal(out.askedAfterPass, 0);
    assert.equal(out.found, '2402.05555');
  } finally {
    await browser.close();
  }
});

test('"What does this use?" lights up what a result rests on and fades the rest', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const r = TeXglass.render(DOC, { renderMath, sourceMap: true });
    const p = await page(browser, r);
    await p.evaluate(() => {
      window.jumped = [];
      window.insight = TeXglassInsight.attach({ root: document.getElementById('preview'), jump: (el) => window.jumped.push(el.id) });
    });
    // No button until the pointer comes near a result; then one by its heading.
    assert.equal(await p.locator('.uses-btn').count(), 0);
    const main = p.locator('#preview .theorem').nth(3);
    await main.hover();
    const btn = main.locator('.uses-btn');
    assert.equal(await btn.count(), 1);
    assert.equal(await main.locator('.thm-name').textContent(), 'Theorem 2.1'); // the heading is left as it was
    await btn.click();
    const state = () => p.evaluate(() => {
      // the element's own mark, or a faded block around it
      const cls = (el) => ['uses-sel', 'uses-on', 'uses-ref', 'uses-fade'].find((c) => el.classList.contains(c)) || (el.closest('.uses-fade') ? 'uses-fade' : '');
      return {
        thms: Array.from(document.querySelectorAll('#preview .theorem')).map(cls),
        proofs: Array.from(document.querySelectorAll('#preview .proof')).map(cls),
        eq: cls(document.querySelector('#preview .math-display')),
        paras: Array.from(document.querySelectorAll('#preview > p, #preview section > p')).map(cls),
        bar: document.querySelector('.uses-bar:not([hidden])') && document.querySelector('.uses-bar').textContent,
        focus: document.getElementById('preview').classList.contains('uses-focus'),
      };
    });
    let s = await state();
    // Theorem 2.1 uses Lemma 1.2, which uses Lemma 1.1; Lemma 1.3 has nothing to do with it.
    assert.deepEqual(s.thms, ['uses-on', 'uses-on', 'uses-fade', 'uses-sel']);
    assert.deepEqual(s.proofs, ['uses-fade', 'uses-sel']); // its own proof is lit, Lemma 1.2's is not
    assert.ok(s.paras.every((c) => c === 'uses-fade'));
    assert.match(s.bar, /Theorem 2\.1 uses 2 results/);
    // "Hide the rest" folds away what is faded, and keeps the setting for the next result.
    const shown = () => p.evaluate(() => Array.from(document.querySelectorAll('#preview .theorem, #preview > p, #preview section > p')).filter((el) => el.offsetParent).length);
    const before = await shown();
    await p.click('.uses-bar [data-act="collapse"]');
    assert.equal(await p.getAttribute('.uses-bar [data-act="collapse"]', 'aria-pressed'), 'true');
    assert.equal(await shown(), 3); // Lemmas 1.1, 1.2 and Theorem 2.1; no paragraph, no Lemma 1.3
    assert.ok(before > 3);
    assert.ok(await p.evaluate(() => document.querySelector('#preview h2, #preview h1').offsetParent)); // headings stay
    await p.click('.uses-bar [data-act="collapse"]');
    assert.equal(await shown(), before);
    assert.deepEqual(await p.evaluate(() => window.jumped.splice(0)), [await p.evaluate(() => document.querySelectorAll('#preview .theorem')[3].id), await p.evaluate(() => document.querySelectorAll('#preview .theorem')[3].id)]); // it stays with the result
    // Step through them.
    await p.click('.uses-bar [data-act="next"]');
    const firstId = await p.evaluate(() => document.querySelector('#preview .theorem').id);
    assert.deepEqual(await p.evaluate(() => window.jumped), [firstId]); // Lemma 1.1 comes after Theorem 2.1 itself
    // What uses Lemma 1.1, directly or not.
    const first = p.locator('#preview .theorem').first();
    await first.hover();
    await first.locator('.uses-btn').click();
    s = await state();
    assert.deepEqual(s.thms, ['uses-sel', 'uses-fade', 'uses-fade', 'uses-fade']);
    assert.match(s.bar, /Lemma 1\.1 uses no other numbered result/);
    await p.click('.uses-bar [data-dir="usedBy"]');
    s = await state();
    assert.deepEqual(s.thms, ['uses-sel', 'uses-on', 'uses-fade', 'uses-on']);
    // Lemma 1.2's proof refers to equation (1.1), which sits inside Lemma 1.1 (lit already).
    // Esc, or the button again, ends it.
    await p.keyboard.press('Escape');
    s = await state();
    assert.equal(s.focus, false);
    assert.deepEqual(s.thms, ['', '', '', '']);
    assert.equal(s.bar, null);
    // From the map: "Show what it uses".
    await p.evaluate(() => window.insight.open('deps'));
    await p.click('.dep-node[data-n="1"]');
    await p.click('.dep-focus');
    s = await state();
    assert.deepEqual(s.thms, ['uses-on', 'uses-sel', 'uses-fade', 'uses-fade']);
    // A new render of the same page keeps it lit.
    await p.evaluate((html) => { document.getElementById('preview').innerHTML = html; window.insight.invalidate(); }, r.blocks.join('\n'));
    s = await state();
    assert.deepEqual(s.thms, ['uses-on', 'uses-sel', 'uses-fade', 'uses-fade']);

    // The map, when shown, lights up the same: Lemma 1.2 and what it uses, not what uses it.
    const map = () => p.evaluate(() => ({
      sel: Array.from(document.querySelectorAll('.dep-node[data-n].dep-sel')).map((g) => g.textContent),
      up: Array.from(document.querySelectorAll('.dep-node[data-n].dep-up')).map((g) => g.textContent),
      down: Array.from(document.querySelectorAll('.dep-node[data-n].dep-down')).map((g) => g.textContent),
      picked: !!document.querySelector('.dep-map.dep-picked'),
      detail: document.querySelector('.dep-detail').textContent,
    }));
    await p.evaluate(() => window.insight.open('deps'));
    let m = await map();
    assert.deepEqual(m.sel, ['Lemma 1.2']);
    assert.deepEqual(m.up, ['Lemma 1.1']);
    assert.deepEqual(m.down, []); // Theorem 2.1 uses it, but the text shows "uses" only
    assert.match(m.detail, /lit up in the text/);
    // Switching to "Used in" moves the map along.
    await p.evaluate(() => window.insight.focus(document.getElementById('preview').querySelectorAll('.theorem')[1], 'usedBy'));
    m = await map();
    assert.deepEqual(m.up, []);
    assert.deepEqual(m.down, ['Theorem 2.1']);
    // Picking another result on the map moves the light in the text to it, same direction.
    await p.click('.dep-node:has-text("Lemma 1.1")');
    s = await state();
    assert.deepEqual(s.thms, ['uses-sel', 'uses-on', 'uses-fade', 'uses-on']);
    assert.match(s.bar, /Lemma 1\.1 is used in 2 results/);
    m = await map();
    assert.deepEqual(m.sel, ['Lemma 1.1']);
    assert.deepEqual(m.down.sort(), ['Lemma 1.2', 'Theorem 2.1']);
    assert.equal(await p.evaluate(() => document.querySelector('.insight-dialog').open), true); // the map stays open
    // A result not on the map says so; ending it from the map clears both.
    await p.evaluate(() => window.insight.focus(document.getElementById('preview').querySelectorAll('.theorem')[2], 'uses'));
    m = await map();
    assert.equal(m.picked, false);
    assert.match(m.detail, /Lemma 1\.3 is lit up in the text, but it is not on the map/);
    await p.click('.dep-node:has-text("Theorem 2.1")');
    await p.click('.dep-unfocus');
    s = await state();
    assert.equal(s.focus, false);
    m = await map();
    assert.equal(m.picked, false);
    assert.match(m.detail, /No result picked/);
    // With nothing lit in the text, picking on the map only lights the map.
    await p.click('.dep-node:has-text("Lemma 1.2")');
    m = await map();
    assert.deepEqual(m.down, ['Theorem 2.1']); // both sides, as before
    assert.equal((await state()).focus, false);
  } finally {
    await browser.close();
  }
});
