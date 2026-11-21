'use strict';
// Cited results (src/cited.js): "[12, Theorem 4.1]" previews Theorem 4.1 of
// reference 12. The page parts run in a real browser and are skipped where
// Playwright and a browser are not installed. Nothing reaches the network: the
// cited paper is a made-up document converted here, and lookups get canned answers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const katex = require('katex');
const TeXglass = require('../src/texglass.js');
const Cited = require('../src/cited.js');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const renderMath = (tex, displayMode, macros) => katex.renderToString(tex, { displayMode, macros, throwOnError: false, strict: 'ignore' });
const names = (pins) => pins.map((p) => p.name);

test('a citation note names the results it points at', () => {
  const n = (s) => names(Cited.pinpointsInNote(s));
  assert.deepEqual(n('Theorem 4.1'), ['Theorem 4.1']);
  assert.deepEqual(n('Thm. 4.1'), ['Theorem 4.1']);
  assert.deepEqual(n('Theorems 4.1 and 4.3'), ['Theorem 4.1', 'Theorem 4.3']);
  assert.deepEqual(n('Prop. 3.2 and Cor. 3.4'), ['Proposition 3.2', 'Corollary 3.4']);
  assert.deepEqual(n('Lemma 2.3(ii)'), ['Lemma 2.3']);
  assert.deepEqual(n('Lemma A.2'), ['Lemma A.2']);
  assert.deepEqual(n('Theorem A'), ['Theorem A']);
  assert.deepEqual(n('Chapter 2, Theorem 2.1'), ['Theorem 2.1']);
  assert.deepEqual(n('Theorem 1.2.3, p. 5'), ['Theorem 1.2.3']);
  assert.deepEqual(n('§3'), ['Section 3']);
  assert.deepEqual(n('Eq. (3.2)'), ['Equation (3.2)']);
  assert.deepEqual(n('(3.2)'), ['Equation (3.2)']);
  assert.deepEqual(n('p. 12'), []);
  assert.deepEqual(n('pp. 3-4'), []);
  assert.deepEqual(n('Theorems 1, 2, 3 and 4'), ['Theorem 1', 'Theorem 2', 'Theorem 3']); // at most three
});

test('words before a citation name a result only when they run up to "of" or "in"', () => {
  const b = (s) => names(Cited.pinpointsBefore(s));
  assert.deepEqual(b('by Theorem 4.1 of'), ['Theorem 4.1']);
  assert.deepEqual(b('Lemma 2 holds by Theorem 4.1 of'), ['Theorem 4.1']);
  assert.deepEqual(b('see Lemmas 2.1 and 2.3 in'), ['Lemma 2.1', 'Lemma 2.3']);
  assert.deepEqual(b('follows from Theorem 4.1(b) in the paper'), ['Theorem 4.1']);
  assert.deepEqual(b('Lemma 2.3 holds, see'), []);
  assert.deepEqual(b('Theorem 4.1 is proven in'), []);
  assert.deepEqual(b('as shown in'), []);
});

// A made-up cited paper: results numbered within sections, with a shared counter.
const CITED = String.raw`\documentclass{article}
\newtheorem{theorem}{Theorem}[section]
\newtheorem{proposition}[theorem]{Proposition}
\newtheorem{lemma}[theorem]{Lemma}
\numberwithin{equation}{section}
\begin{document}
\section{Setting}
\begin{lemma}\label{l:a} Every widget is blue. \end{lemma}
\begin{equation}\label{e:main} a^2 + b^2 = c^2 \end{equation}
\section{Results}
\begin{theorem}\label{t:main} Every gadget is a widget, by Lemma~\ref{l:a}. \end{theorem}
\begin{proposition} Gadgets are \emph{round}. \end{proposition}
\end{document}`;

// The citing document.
const CITING = String.raw`\documentclass{article}
\begin{document}
\section{Intro}
By \cite[Theorem 2.1]{gad}, all is well. Recall \cite[Eq.~(1.1)]{gad}.
Lemma 1.1 of \cite{gad} is also used, and so is \cite[Theorem 2.2]{gad}.
Nothing in \cite[Theorem 9.9]{gad}. Not on arXiv: \cite[Lemma 1]{book}.
\begin{thebibliography}{9}
\bibitem{gad} A. Writer, \emph{On gadgets and widgets}, arXiv:2301.00001.
\bibitem{book} B. Reader, \emph{A book nobody indexed}, Imaginary Press, 1901.
\end{thebibliography}
\end{document}`;

const RECORD = {
  data: {
    id: '10.48550/arxiv.2301.00001',
    attributes: {
      doi: '10.48550/arxiv.2301.00001',
      identifiers: [{ identifier: '2301.00001', identifierType: 'arXiv' }],
      creators: [{ name: 'Writer, A.', givenName: 'A.', familyName: 'Writer' }],
      titles: [{ title: 'On gadgets and widgets' }],
      publicationYear: 2023,
      descriptions: [{ descriptionType: 'Abstract', description: 'We study gadgets.' }],
    },
  },
};

test('hovering "[1, Theorem 2.1]" shows that theorem from the cited paper, kept for next time', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const citing = TeXglass.render(CITING, { renderMath, sourceMap: true });
    const cited = TeXglass.render(CITED, { renderMath }).html;
    const p = await browser.newPage();
    await p.setContent(
      `<style>${fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')}</style>` +
      `<article id="preview" class="document">${citing.blocks.join('\n')}</article>`
    );
    for (const f of ['src/find.js', 'src/cited.js', 'src/cite.js']) await p.addScriptTag({ path: path.join(ROOT, f) });
    const out = await p.evaluate(async ({ record, cited }) => {
      const loads = [];
      const store = new Map();
      const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
      let isOnline = true;
      const opened = [];
      const make = () => TeXglassCite.create({
        getJson: async (url) => {
          if (url.includes('/dois/10.48550')) return record;
          if (url.includes('api.datacite.org/dois?')) return { data: [] };
          throw Object.assign(new Error('HTTP 404'), { status: 404 });
        },
        online: () => isOnline,
        openArxiv: (id, goto) => opened.push([id, goto]),
        loadPaper: async (id) => { loads.push(id); return cited; },
        storage,
      });
      let cites = make();
      const links = Array.from(document.querySelectorAll('.cite a'));
      const wait = (el) => new Promise((res) => {
        const done = () => !el.querySelector('.cite-wait');
        if (done()) return res();
        new MutationObserver((_, o) => { if (done()) { o.disconnect(); res(); } }).observe(el, { childList: true, subtree: true });
      });
      const hover = async (k) => {
        const a = links[k];
        const note = cites.noteFor(document.getElementById(a.getAttribute('href').slice(1)), { link: a });
        document.body.appendChild(note);
        await wait(note);
        return note;
      };
      const res = {};
      const thm = await hover(0);
      res.thm = thm.textContent;
      res.thmHasBody = !!thm.querySelector('.cited-body .theorem');
      res.refsPlain = !thm.querySelector('.cited-body a[href^="#"]') && !thm.querySelector('.cited-body [id]');
      res.abstractTucked = !!thm.querySelector('details.cite-more');
      thm.querySelector('.cited-open').click();
      res.eq = (await hover(1)).textContent;
      res.eqDisplay = !!(await hover(1)).querySelector('.cited-body .katex');
      res.before = (await hover(2)).textContent;
      res.other = (await hover(3)).textContent;
      res.missing = (await hover(4)).textContent;
      res.book = (await hover(5)).textContent;
      res.loads = loads.slice();
      // a new visit, offline: the statement comes back from storage
      cites = make();
      isOnline = false;
      res.offline = (await hover(0)).textContent;
      res.opened = opened;
      return res;
    }, { record: RECORD, cited });
    assert.match(out.thm, /Theorem 2\.1 in arXiv:2301\.00001/);
    assert.match(out.thm, /Every gadget is a widget/);
    assert.ok(out.thmHasBody);
    assert.ok(out.refsPlain, 'links into the cited paper become plain text');
    assert.ok(out.abstractTucked, 'the abstract waits behind a click');
    assert.deepEqual(out.opened, [['2301.00001', 'Theorem 2.1']]);
    assert.match(out.eq, /Equation \(1\.1\) in arXiv/);
    assert.ok(out.eqDisplay);
    assert.match(out.before, /Lemma 1\.1 in arXiv/);
    assert.match(out.before, /Every widget is blue/);
    assert.match(out.other, /numbered Proposition 2\.2 there/);
    assert.match(out.other, /Gadgets are/);
    assert.match(out.missing, /has no Theorem 9\.9/);
    assert.match(out.missing, /We study gadgets/, 'the abstract still shows when the result is not found');
    assert.match(out.book, /Lemma 1: the paper was not found on arXiv/);
    assert.deepEqual(out.loads, ['2301.00001'], 'the cited paper is fetched and converted once');
    assert.match(out.offline, /Every gadget is a widget/);
    assert.match(out.offline, /Offline/);
  } finally {
    await browser.close();
  }
});

test('the viewer, the extension and the offline cache all carry src/cited.js', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(html.indexOf('src/cited.js') > 0 && html.indexOf('src/cited.js') < html.indexOf('src/cite.js'));
  assert.ok(require('../sw.js').PRECACHE.includes('src/cited.js'));
  assert.match(fs.readFileSync(path.join(ROOT, 'vscode/scripts/copy-shared.js'), 'utf8'), /src\/cited\.js/);
  assert.match(fs.readFileSync(path.join(ROOT, 'vscode/extension.js'), 'utf8'), /'shared', 'cited\.js'/);
});
