'use strict';
// The render dashboard (dashboard/): what it makes of a paper, what changed
// since the last run, and, in a real browser, that it notices maths, figures
// and diagrams the viewer could not show. The browser part is skipped where
// Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const report = require('../dashboard/report.js');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

test('KaTeX errors are grouped by the macro behind them', () => {
  assert.equal(report.mathErrorKey('KaTeX parse error: Undefined control sequence: \\foo at position 3: a+\\foo'), '\\foo');
  assert.equal(report.mathErrorKey("KaTeX parse error: No such environment: smallmatrix* at position 1"), '{smallmatrix*}');
  assert.equal(report.mathErrorKey("KaTeX parse error: Expected '}', got 'EOF' at end of input: x"), "Expected '}', got 'EOF'");
  assert.equal(report.mathErrorKey("ParseError: KaTeX parse error: Can't use function '$' in math mode at position 91: …"), "Can't use function '$' in math mode");
});

test('figures that did not show are counted by file type', () => {
  assert.equal(report.figureKind('figs/plot.PDF'), '.pdf figures');
  assert.equal(report.figureKind('fig1'), 'figures named without extension');
  assert.equal(report.figureKind('(image did not load)'), '(image did not load)');
});

test('papers are grouped by year, read from the corpus or the arXiv id', () => {
  assert.equal(report.yearOf({ id: '2609.02755' }), 2026);
  assert.equal(report.yearOf({ id: 'math/0403047' }), 2004);
  assert.equal(report.yearOf({ id: 'hep-th/9711200' }), 1997);
  assert.equal(report.yearOf({ id: 'x', year: 2011 }), 2011);
  assert.equal(report.yearBucket(2004), 'before 2008');
  assert.equal(report.yearBucket(2026), '2024 on');
});

test('a paper is OK, has issues, is broken, or has no source', () => {
  assert.equal(report.classify({ id: 'a', kind: 'tex', blocks: 5, ms: 1000 }).status, 'ok');
  const p = report.classify({ id: 'b', kind: 'tex', blocks: 5, ms: 25000, mathErrors: ['Undefined control sequence: \\foo', 'Undefined control sequence: \\foo'], placeholders: ['[image: fig1]', '[axis diagram]'], warnings: ['Unknown command \\frob.', 'Undefined reference "x".'] });
  assert.equal(p.status, 'issues');
  assert.equal(p.slow, true);
  assert.deepEqual(p.problems, { math: { '\\foo': 2 }, figure: { fig1: 1 }, diagram: { axis: 1 }, command: { '\\frob': 1 } });
  assert.equal(report.classify({ id: 'c', kind: 'tex', timeout: true }).status, 'broken');
  assert.equal(report.classify({ id: 'd', kind: 'tex', error: 'No .tex file found' }).status, 'broken');
  assert.equal(report.classify({ id: 'e', kind: 'pdf' }).status, 'nosource');
  // unknown text commands alone do not make a paper fail
  assert.equal(report.classify({ id: 'f', kind: 'tex', blocks: 1, warnings: ['Unknown command \\frob.'] }).status, 'ok');
});

test('a run lists what got worse, what got better, and the macros behind the most papers', () => {
  const corpus = [{ id: 'a', field: 'maths' }, { id: 'b', field: 'cs' }, { id: 'c', field: 'physics' }];
  const night1 = report.build([
    { id: 'a', kind: 'tex', blocks: 3, ms: 1000, packages: ['amsmath', 'tikz'] },
    { id: 'b', kind: 'tex', blocks: 3, ms: 1000, mathErrors: ['Undefined control sequence: \\foo'], packages: ['amsmath'] },
    { id: 'c', kind: 'tex', blocks: 3, ms: 1000, packages: ['amsmath'] },
  ], corpus, null, { date: '2026-11-20T02:00:00Z' });
  assert.equal(night1.summary.ok, 2);
  assert.equal(night1.summary.issues, 1);
  assert.equal(night1.summary.medianMs, 1000);
  assert.equal(night1.summary.clean, 2 / 3);
  assert.equal(night1.summary.byType.math, 1);
  assert.deepEqual(night1.changes, []);
  assert.equal(night1.history.length, 1);

  const night2 = report.build([
    { id: 'a', kind: 'tex', blocks: 3, ms: 1000, mathErrors: ['Undefined control sequence: \\foo', 'Undefined control sequence: \\bar'], packages: ['amsmath', 'tikz'] },
    { id: 'b', kind: 'tex', blocks: 3, ms: 1000, packages: ['amsmath'] },
    { id: 'c', kind: 'tex', timeout: true, ms: 120000, packages: ['amsmath'] },
  ], corpus, night1, { date: '2026-11-21T02:00:00Z' });
  const by = Object.fromEntries(night2.changes.map((c) => [c.id, c]));
  assert.equal(by.a.change, 'worse');
  assert.deepEqual(by.a.fresh.sort(), ['\\bar', '\\foo']);
  assert.equal(by.b.change, 'better');
  assert.equal(by.c.change, 'worse');
  assert.equal(by.c.to, 'broken');
  assert.equal(night2.changes[night2.changes.length - 1].id, 'b', 'worse news first');
  assert.equal(night2.papers.find((p) => p.id === 'a').since, '2026-11-21T02:00:00Z');
  assert.equal(night2.history.length, 2);
  assert.equal(night2.history[1].worse, 2);
  assert.equal(night2.history[1].better, 1);
  assert.equal(night2.summary.byType.timeout, 1);
  assert.equal(night2.slowest[0].id, 'c');
  assert.deepEqual(night2.groups.field.map((g) => [g.key, g.papers, g.broken]).sort(), [['cs', 1, 0], ['maths', 1, 0], ['physics', 1, 1]]);
  assert.deepEqual(night2.top.math.map((e) => [e.key, e.papers.length]).sort(), [['\\bar', 1], ['\\foo', 1]]);
  assert.equal(night2.top.packages[0].key, 'amsmath');
  assert.equal(night2.top.packages[0].used, 3);
  assert.equal(night2.papers.sort((x, y) => y.badness - x.badness)[0].id, 'c', 'broken papers come first');
});

// A paper's source as arXiv sends it: a gzipped tar of main.tex.
function tarGz(files) {
  const blocks = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(body.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

test('a run in the browser notices maths, figures and diagrams the viewer could not show', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-'));
  try {
    const file = path.join(dir, 'paper.src');
    fs.writeFileSync(file, tarGz({
      'main.tex': [
        '\\documentclass{article}\\usepackage{amsmath}\\usepackage{pgfplots}',
        '\\begin{document}\\section{One}',
        'Fine: $x^2$. Not fine: $\\nosuchmacro{x}$ and \\frobnicate.',
        '\\includegraphics{missing-figure}',
        '\\begin{axis}\\addplot{x};\\end{axis}',
        '\\end{document}',
      ].join('\n'),
    }));
    const { renderOne, packagesOf } = require('../dashboard/run.js');
    const src = { kind: 'tex', type: 'application/gzip', file };
    const raw = await renderOne(browser, { id: '2401.00001' }, src, 30000);
    assert.equal(raw.timeout, undefined, 'finished');
    raw.packages = await packagesOf('2401.00001', src);
    const p = report.classify(raw);
    assert.equal(p.status, 'issues', JSON.stringify(raw));
    assert.deepEqual(p.problems.math, { '\\nosuchmacro': 1 });
    assert.deepEqual(p.problems.figure, { 'missing-figure': 1 });
    assert.deepEqual(p.problems.diagram, { axis: 1 });
    assert.deepEqual(p.problems.command, { '\\frobnicate': 1 });
    assert.deepEqual(p.packages, ['amsmath', 'pgfplots']);
    assert.ok(p.ms > 0 && p.ms < 30000);
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
