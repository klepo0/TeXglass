'use strict';
// The hypothesis checker (src/hypotheses.js): a result cited in a proof previews
// as its hypotheses, with boxes to tick, and its conclusion. The splitting runs
// on plain strings; the page parts run in a real browser and are skipped where
// Playwright and a browser are not installed. The example paper is made up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const katex = require('katex');
const TeXglass = require('../src/texglass.js');
const Hyp = require('../src/hypotheses.js');
const NotesSync = require('../src/notes-sync.js');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const renderMath = (tex, displayMode, macros) => katex.renderToString(tex, { displayMode, macros, throwOnError: false, strict: 'ignore' });

/** Split a statement written with $…$ formulas; lists as [[label, text], …] for each . */
function parts(text, lists) {
  const f = (s) => s.replace(/\$([^$]*)\$/g, '$1');
  const flat = f(text);
  const ls = (lists || []).map((l) => l.map(([label, t]) => ({ label, text: f(t) })));
  const r = Hyp.split(flat, ls);
  const show = (p) => (p.list != null ? `${ls[p.list][p.item].label} ${Hyp.plain(ls[p.list][p.item].text)}` : Hyp.plain(flat.slice(p.from, p.to)));
  return { hyps: r.hyps.map(show), concl: r.concl.map(show) };
}

test('"Let", "Suppose" and "Then" sentences split into hypotheses and a conclusion', () => {
  assert.deepEqual(parts('Let $X$ be compact and let $f\\colon X\\to\\mathbb R$ be continuous. Suppose that $f>0$. Then $f$ attains its minimum.'), {
    hyps: ['Let $X$ be compact', 'let $f\\colon X\\to\\mathbb R$ be continuous', '$f>0$'],
    concl: ['$f$ attains its minimum'],
  });
  assert.deepEqual(parts('Suppose $u\\in L^p$ and $v\\in L^q$; assume moreover $1/p+1/q=1$. Then $uv\\in L^1$.'), {
    hyps: ['$u\\in L^p$', '$v\\in L^q$', '$1/p+1/q=1$'],
    concl: ['$uv\\in L^1$'],
  });
});

test('"and" splits two claims, not a list of names', () => {
  assert.deepEqual(parts('Let $X$ and $Y$ be Banach spaces and $T\\colon X\\to Y$ a bounded operator. Then $T^*$ is bounded.').hyps,
    ['Let $X$ and $Y$ be Banach spaces', '$T\\colon X\\to Y$ a bounded operator']);
});

test('"If … then …", "Under …" and "provided that"', () => {
  assert.deepEqual(parts('If $f$ is convex and $f(0)=0$, then $f(2x)\\ge 2f(x)$ for $x\\ge0$.'), {
    hyps: ['$f$ is convex', '$f(0)=0$'],
    concl: ['$f(2x)\\ge 2f(x)$ for $x\\ge0$'],
  });
  assert.deepEqual(parts('Let $G$ be a group. If $G$ is finite, then $|g|$ divides $|G|$ for all $g\\in G$.'), {
    hyps: ['Let $G$ be a group', '$G$ is finite'],
    concl: ['$|g|$ divides $|G|$ for all $g\\in G$'],
  });
  assert.deepEqual(parts('Under Assumption 2.1, the solution exists and is unique.'), { hyps: ['Assumption 2.1'], concl: ['the solution exists and is unique'] });
  assert.deepEqual(parts('Under these assumptions, the solution exists.'), { hyps: [], concl: ['the solution exists'] });
  assert.deepEqual(parts('The map $T$ is a contraction provided that $\\lambda<1$.'), { hyps: ['$\\lambda<1$'], concl: ['The map $T$ is a contraction'] });
});

test('itemised assumptions after "Assume the following:" are hypotheses; items after "Then" are the conclusion', () => {
  assert.deepEqual(parts('Assume the following:\nThen $u$ is bounded.', [[['(H1)', '$p\\ge 2$;'], ['(H2)', '$u\\in L^p$.']]]), {
    hyps: ['(H1) $p\\ge 2$;', '(H2) $u\\in L^p$.'],
    concl: ['$u$ is bounded'],
  });
  assert.deepEqual(parts('Let $p \\ge 1$. Then the following hold:', [[['(i)', '$a>0$'], ['(ii)', '$b>0$']]]), {
    hyps: ['Let $p \\ge 1$'],
    concl: ['(i) $a>0$', '(ii) $b>0$'],
  });
});

test('a statement with no hypotheses is all conclusion; abbreviations do not end a sentence', () => {
  assert.deepEqual(parts('Every compact metric space is complete.'), { hyps: [], concl: ['Every compact metric space is complete'] });
  assert.deepEqual(parts('Let $p\\ge 1$, i.e. $p$ is finite. Then $L^p$ is complete.').hyps, ['Let $p\\ge 1$, i.e. $p$ is finite']);
});

test('a sentence may run across a displayed formula', () => {
  assert.deepEqual(parts('Let $u$ solve\n$-\\Delta u = f$\nand suppose $f\\in L^2$. Then $u \\in H^2$.'), {
    hyps: ['Let $u$ solve $-\\Delta u = f$', '$f\\in L^2$'],
    concl: ['$u \\in H^2$'],
  });
});

test('a hypothesis is "not mentioned" only when none of its words, formulas or label are near', () => {
  assert.equal(Hyp.mentioned('Let $X$ be compact', 'Since $K$ is compact, Lemma † gives'), true);
  assert.equal(Hyp.mentioned('$f$ is continuous', 'By continuity of $g$ and Lemma †'), true);
  assert.equal(Hyp.mentioned('$f$ is convex', 'Applying Lemma † to $g$ we get'), false);
  assert.equal(Hyp.mentioned('$p\\ge 2$', 'Applying Lemma † we get'), null); // formulas only: cannot tell
  assert.equal(Hyp.mentioned('$u\\in L^p$', 'Since $u\\in L^p$, Lemma † applies'), true);
  assert.equal(Hyp.mentioned('$f$ is convex', 'All hypotheses of Lemma † are satisfied'), null);
  assert.equal(Hyp.mentioned('$p\\ge 2$', 'By (H1) and Lemma †', '(H1)'), true);
});

test('ticks are notes of their own kind: kept when the margin saves, merged and deleted like notes', () => {
  const t0 = new Date('2026-11-21T08:00:00Z');
  const t1 = new Date('2026-11-21T09:00:00Z');
  const note = { id: 'n1', anchor: { quote: 'compact' }, note: 'hm', created: t0.toISOString() };
  let r = NotesSync.track(NotesSync.empty('arxiv:1'), [note], t0);
  r = NotesSync.setCheck(r, 'chk-1', true, { result: 'Lemma 1.1', text: 'X is compact', at: 'Proof of Theorem 2.1#0' }, t0);
  assert.deepEqual(Array.from(NotesSync.checks(r)), ['chk-1']);
  // the margin saves its own notes only: the tick stays
  r = NotesSync.track(r, [note], t1);
  assert.ok(NotesSync.checks(r).has('chk-1'));
  assert.ok(!r.deleted['chk-1']);
  // unticking on another device wins over the older tick
  const other = NotesSync.setCheck(r, 'chk-1', false, null, t1);
  assert.ok(!NotesSync.checks(NotesSync.merge(r, other)).has('chk-1'));
  // and the file keeps it
  const back = Object.values(NotesSync.parseFile(NotesSync.toFile(r)))[0];
  assert.ok(NotesSync.checks(back).has('chk-1'));
  // the same hypothesis at the same citation has the same id everywhere
  assert.equal(Hyp.checkId('Lemma 1.1', 'X  is compact', 'a#0'), Hyp.checkId('Lemma 1.1', 'X is compact', 'a#0'));
  assert.notEqual(Hyp.checkId('Lemma 1.1', 'X is compact', 'a#0'), Hyp.checkId('Lemma 1.1', 'X is compact', 'a#1'));
});

const DOC = String.raw`\documentclass{article}
\usepackage{amsthm}
\newtheorem{theorem}{Theorem}[section]
\newtheorem{lemma}[theorem]{Lemma}
\theoremstyle{definition}
\newtheorem{assumption}{Assumption}
\begin{document}
\section{Setting}
Throughout this section, $\Omega$ is a bounded domain.
\begin{assumption}\label{a:v} The potential $V$ is bounded below.\end{assumption}
\begin{lemma}\label{l:min} Let $K$ be compact and let $f\colon K\to\mathbb R$ be continuous. Suppose that $f$ is convex. Then $f$ attains its minimum.\end{lemma}
\begin{theorem}\label{t:main} Assume the following:
\begin{enumerate}
\item[(H1)] $p\ge 2$;
\item[(H2)] $u\in L^p(\Omega)$.
\end{enumerate}
Then $u$ is bounded.\end{theorem}
\section{Proofs}
\begin{theorem}\label{t:two} Under Assumption~\ref{a:v}, the energy is finite.\end{theorem}
\begin{proof} Since $X$ is compact and $g$ is continuous, Lemma~\ref{l:min} gives a minimiser. By (H1) and Theorem~\ref{t:main}, done. \end{proof}
\end{document}`;

test('the preview of a cited result splits it, ticks are kept, and unmentioned hypotheses are hinted', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const r = TeXglass.render(DOC, { renderMath });
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.setContent(
      `<style>${fs.readFileSync(path.join(ROOT, 'vendor/katex/katex.min.css'), 'utf8')}${fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')}</style>` +
      `<article id="preview" class="document">${r.html}</article><div id="out" class="ref-popover-body"></div>`
    );
    await page.addScriptTag({ path: path.join(ROOT, 'src/hypotheses.js') });
    const got = await page.evaluate(() => {
      window.ticks = new Map();
      window.prefs = new Map();
      const checker = TeXglassHypotheses.attach({
        root: document.getElementById('preview'),
        isChecked: (id) => !!window.ticks.get(id),
        setChecked: (id, on, info) => window.ticks.set(id, on && info),
        prefs: { get: (k) => window.prefs.get(k) || null, set: (k, v) => window.prefs.set(k, v) },
      });
      window.checker = checker;
      const proof = document.querySelector('#preview .proof');
      const links = proof.querySelectorAll('a.ref');
      const target = (a) => document.getElementById(a.getAttribute('href').slice(1));
      const read = (view) => ({
        hyps: Array.from(view.querySelectorAll('.hyp-check > .hyp-list .hyp-text')).map((el) => el.textContent.replace(/\s+/g, ' ').trim()),
        hints: view.querySelectorAll('.hyp-check > .hyp-list .hyp-hint').length,
        concl: view.querySelector('.hyp-concl') ? view.querySelector('.hyp-concl').textContent.replace(/\s+/g, ' ').trim() : '',
        standing: Array.from(view.querySelectorAll('.hyp-standing .hyp-text')).map((el) => el.textContent.replace(/\s+/g, ' ').trim()),
        katex: view.querySelectorAll('.hyp-check .katex').length,
      });
      const v1 = checker.viewFor(target(links[0]), links[0], target(links[0]).cloneNode(true));
      document.getElementById('out').appendChild(v1);
      v1.querySelector('.hyp-box').click();
      const v2 = checker.viewFor(target(links[1]), links[1], null);
      // a reference outside proofs and statements is shown as usual
      const p = document.querySelector('#preview p');
      const a = document.createElement('a');
      a.className = 'ref';
      a.href = '#' + target(links[0]).id;
      p.appendChild(a);
      const plainRef = checker.viewFor(target(links[0]), a, null);
      // again: the tick is still there
      const again = checker.viewFor(target(links[0]), links[0], null);
      return {
        lemma: read(v1), theorem: read(v2), plainRef,
        tick: Array.from(window.ticks.values())[0],
        againChecked: again.querySelector('.hyp-box').checked,
        count: again.querySelector('.hyp-count').textContent,
      };
    });
    assert.deepEqual(got.lemma.hyps.map((h) => h.replace(/not mentioned.*$/, '').replace(/[^\w ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 30)).length, 3);
    assert.match(got.lemma.hyps[0], /^Let K.*be compact/);
    assert.match(got.lemma.hyps[2], /f.*is convex/);
    assert.equal(got.lemma.hints, 1); // "convex" is nowhere near the citation; compact and continuous are
    assert.match(got.lemma.hyps[2], /not mentioned near this citation/);
    assert.match(got.lemma.concl, /attains its minimum/);
    assert.ok(got.lemma.katex > 0, 'formulas are drawn as on the page');
    assert.match(got.lemma.standing.join(' | '), /Throughout this section, .*Ω.* is a bounded domain/);
    assert.match(got.lemma.standing.join(' | '), /Assumption 1: .*potential/);
    assert.equal(got.theorem.hyps.length, 2);
    assert.match(got.theorem.hyps[0], /^\(H1\)/);
    assert.equal(got.theorem.hints, 0); // (H1) is named; (H2) has formulas only
    assert.match(got.theorem.concl, /u.*is bounded/);
    assert.equal(got.plainRef, null);
    assert.equal(got.tick.result, 'Lemma 1.1');
    assert.equal(got.tick.at, 'Proof of Theorem 2.1#0');
    assert.ok(got.againChecked);
    assert.match(got.count, /1 of 5 checked here/);

    // "As written" shows the statement as it is, and is remembered
    const written = await page.evaluate(() => {
      const v = document.querySelector('#out .hyp-view');
      v.querySelector('.hyp-switch').click();
      return { split: v.querySelector('.hyp-check').hidden, written: v.querySelector('.hyp-written').hidden, pref: window.prefs.get('texglass:hypotheses') };
    });
    assert.deepEqual(written, { split: true, written: false, pref: 'written' });

    // An Assumption a statement refers to is offered, open, with the statement
    const under = await page.evaluate(() => {
      window.prefs.clear();
      const thm = document.querySelectorAll('#preview .theorem')[3];
      const link = document.createElement('a');
      link.className = 'ref';
      link.href = '#' + thm.id;
      document.querySelector('#preview .proof p').appendChild(link);
      const v = window.checker.viewFor(thm, link, null);
      return { hyps: v.querySelectorAll('.hyp-check > .hyp-list .hyp-item').length, open: v.querySelector('.hyp-standing').open, first: v.querySelector('.hyp-standing .hyp-text').textContent };
    });
    assert.equal(under.hyps, 1);
    assert.ok(under.open);
    assert.match(under.first, /^Assumption 1: .*potential/);
  } finally {
    await browser.close();
  }
});

test('item marks drawn as formulas ($\bullet$) are not shown as TeX; labels and notes keep their formulas', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const src = String.raw`\documentclass{article}
\newtheorem{lemma}{Lemma}
\begin{document}
\begin{lemma}[$L^p$ bound]\label{marks}
Assume the following:
\begin{itemize}
\item[$\bullet$] $X$ is compact;
\item[$\circ$] $f$ is continuous;
\item[$(\mathrm{H}_3)$] $f$ is positive.
\end{itemize}
Then $f$ attains its minimum.
\end{lemma}
\begin{proof}
Since $X$ is compact, Lemma~\ref{marks} applies.
\end{proof}
\end{document}`;
    const r = TeXglass.render(src, { renderMath });
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.setContent(
      `<style>${fs.readFileSync(path.join(ROOT, 'vendor/katex/katex.min.css'), 'utf8')}${fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')}</style>` +
      `<article id="preview" class="document">${r.html}</article><div id="out" class="ref-popover-body"></div>`
    );
    await page.addScriptTag({ path: path.join(ROOT, 'src/hypotheses.js') });
    const got = await page.evaluate(() => {
      const checker = TeXglassHypotheses.attach({ root: document.getElementById('preview'), isChecked: () => false, setChecked: () => {} });
      const a = document.querySelector('#preview .proof a.ref');
      const v = checker.viewFor(document.getElementById(a.getAttribute('href').slice(1)), a, null);
      document.getElementById('out').appendChild(v);
      return {
        seen: v.querySelector('.hyp-check').innerText,
        labels: Array.from(v.querySelectorAll('.hyp-check > .hyp-list .hyp-label')).map((l) => {
          const c = l.cloneNode(true);
          c.querySelectorAll('.katex-mathml').forEach((m) => m.remove());
          return c.textContent.replace(/[\s\u200b]+/g, '');
        }),
        labelMath: v.querySelectorAll('.hyp-check > .hyp-list .hyp-label .katex').length,
        aria: Array.from(v.querySelectorAll('.hyp-box')).map((b) => b.getAttribute('aria-label')),
        note: v.querySelector('.hyp-note') ? v.querySelector('.hyp-note').querySelectorAll('.katex').length : -1,
      };
    });
    assert.doesNotMatch(got.seen, /\\(?:bullet|circ|mathrm)/, 'no TeX source on show');
    assert.deepEqual(got.labels, ['(H3)']); // the bare marks are dropped next to the tick boxes
    assert.equal(got.labelMath, 1, 'the (H3) label is drawn as on the page');
    for (const l of got.aria) assert.doesNotMatch(l, /\\/);
    assert.equal(got.note, 1, 'the note [$L^p$ bound] keeps its formula');
  } finally {
    await browser.close();
  }
});

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json' };

test('in the viewer, hovering a result cited in a proof shows its hypotheses and what the section assumes', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
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
    await page.waitForSelector('#preview .proof a.ref');
    await page.click('#mode-preview');
    await page.hover('#preview .proof a.ref >> nth=0');
    await page.waitForSelector('#ref-popover:not([hidden]) .hyp-check');
    await page.hover('#ref-popover .hyp-box >> nth=0');
    await page.click('#ref-popover .hyp-box >> nth=0');
    const got = await page.evaluate(() => ({
      hyps: document.querySelectorAll('#ref-popover .hyp-check > .hyp-list .hyp-item').length,
      standing: Array.from(document.querySelectorAll('#ref-popover .hyp-standing .hyp-text')).map((el) => el.textContent),
      count: document.querySelector('#ref-popover .hyp-count').textContent,
    }));
    assert.equal(got.hyps, 3);
    assert.equal(got.standing.length, 2); // the source blocks the viewer wraps the page in are looked into
    assert.match(got.count, /1 of 5 checked here/);
  } finally {
    await browser.close();
  }
});
