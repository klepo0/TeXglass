'use strict';
// Live parameters: texglass.sty's \tgparam and \tgvalue (latex/texglass.sty),
// read by the converter (src/texglass.js) and moved with sliders (src/params.js).
// The example is made up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const katex = require('katex');
const TeXglass = require('../src/texglass.js');
const Params = require('../src/params.js');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
const renderMath = (tex, displayMode, macros) => katex.renderToString(tex, { displayMode, macros, throwOnError: false, strict: 'ignore' });

const DOC = String.raw`\documentclass{article}
\usepackage{amsmath,tikz}
\usepackage{texglass}
\tgparam[2]{p}{1}{4}
\tgparam[start=1.25, step=0.25, label={$\rho$}]{rad}{0.5}{3}
\tgparam{q}{3}{9}
\newcommand\norm[1]{\|#1\|_{L^{\p}}}
\begin{document}
\section{Bounds}
For $p=\p$ we have $\norm{f} \le 1$, and \tgvalue{p} in words; q is \q.
\begin{equation}\label{e:main} \int |f|^{\tgvalue{p}} \le C \end{equation}
Nothing here: $x^2$.
\begin{tikzpicture}
\pgfmathsetmacro{\b}{2*\rad}
\draw (0,0) circle (\rad) -- (\b,1);
\end{tikzpicture}
\end{document}`;

/** The pieces a page's .tg-live marks hold, as src/params.js sends them. */
function pieces(html) {
  const un = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return Array.from(html.matchAll(/<span class="tg-live" hidden ([^>]*)><\/span>/g)).map((m) => {
    const get = (k) => { const r = new RegExp(`data-tg-${k}="([^"]*)"`).exec(m[1]); return r ? un(r[1]) : ''; };
    return { params: get('params'), piece: { tex: get('tex'), defs: get('defs'), display: /data-tg-display/.test(m[1]), picture: /data-tg-picture/.test(m[1]) } };
  });
}

test('the converter marks what uses a parameter, and lists the parameters', () => {
  const r = TeXglass.render(DOC, { renderMath });
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.unknownCommands, []);
  const h = r.html;
  // values in running text: \tgvalue{p} and \q (defined by \tgparam as its start, the minimum here)
  assert.match(h, /<span class="tg-value" data-tg-param="p">2<\/span> in words; q is <span class="tg-value" data-tg-param="q">3<\/span>\./);
  // formulas and the picture that use one, but not x^2
  const ps = pieces(h);
  assert.deepEqual(ps.map((p) => p.params), ['p', 'p', 'p', 'rad']);
  assert.equal(ps[1].piece.defs, String.raw`\renewcommand{\norm}[1]{\|#1\|_{L^{\p}}}`); // the macro that reaches \p
  assert.equal(ps[2].piece.display, true);
  assert.match(ps[2].piece.tex, /\\tgvalue\{p\}\} \\le C \\tag\{1\}/); // keeps its number
  assert.equal(ps[3].piece.picture, true);
  assert.match(ps[3].piece.tex, /circle \(\\rad\)/);
  // the marks for the sliders: start value, step and label
  const marks = Array.from(h.matchAll(/<span class="tg-param" data-name="(\w+)" data-min="([^"]*)" data-max="([^"]*)" data-value="([^"]*)" data-step="([^"]*)"/g)).map((m) => m.slice(1));
  assert.deepEqual(marks, [['p', '1', '4', '2', '0.02'], ['rad', '0.5', '3', '1.25', '0.25'], ['q', '3', '9', '3', '0.05']]);
  assert.match(h, /data-name="rad"[^>]*data-label="[^"]*ρ/);
  // the start value is what the page shows
  assert.match(h, /<mn>2<\/mn><\/mrow><annotation encoding="application\/x-tex">p=\\p<\/annotation>/);
  // the picture draws a circle of radius 1.25 and a line to (2.5, 1)
  assert.match(h, /\[&quot;L&quot;,\[2\.5,1\]\]/);
});

test('renderLive draws a piece again with the sliders\' values', () => {
  const ps = pieces(TeXglass.render(DOC, { renderMath }).html);
  const live = (k, values) => TeXglass.renderLive(DOC, ps[k].piece, values, { renderMath });
  assert.match(live(0, { p: '3.5' }), /<mn>3.5<\/mn>/);
  assert.match(live(1, { p: '3.5' }), /<mn>3.5<\/mn>/); // through \norm
  const eq = live(2, { p: '1.5' });
  assert.match(eq, /<mn>1.5<\/mn>/);
  assert.match(eq, /\(1\)/); // the number stays
  assert.doesNotMatch(eq, /tg-live/); // no mark: the page keeps its own
  const pic = live(3, { rad: '2' });
  assert.match(pic, /\[&quot;L&quot;,\[4,1\]\]/); // \pgfmathsetmacro{\b}{2*\rad} follows the slider
  assert.match(pic, /^<span class="tg-diagram tg-tikz">/);
  // a value that is no number is ignored
  assert.match(live(0, { p: 'oops' }), /<mn>2<\/mn>/);
});

test('renderLive keeps diagrams.sty arrows when their labels use a parameter', () => {
  const doc = String.raw`\documentclass{article}
\usepackage{diagrams}
\usepackage{texglass}
\tgparam[2]{p}{1}{4}
\begin{document}
$A\rTo^{\p}B$
\end{document}`;
  const { html } = TeXglass.render(doc, { renderMath });
  assert.match(html, /<mo[^>]*>→<\/mo>/);
  assert.match(html, /<mn>2<\/mn>/);
  const [{ piece }] = pieces(html);
  const live = TeXglass.renderLive(doc, piece, { p: '3.5' }, { renderMath });
  assert.match(live, /<mo[^>]*>→<\/mo>/);
  assert.match(live, /<mn>3.5<\/mn>/);
});

test('a definition of the parameter in the paper or the picture counts, as in LaTeX', () => {
  const doc = String.raw`\documentclass{article}\usepackage{texglass}
\tgparam{a}{0}{4}\tgparam{alpha}{0}{1}\def\a{1.5}
\begin{document}
$\a$ and $\alpha$ and $\tgvalue{alpha}$.
\begin{tikzpicture}\def\a{3}\draw (0,0) -- (\a,0);\end{tikzpicture}
\end{document}`;
  const r = TeXglass.render(doc, { renderMath });
  // \alpha stays the Greek letter (LaTeX has it); \tgvalue{alpha} is the parameter
  assert.deepEqual(pieces(r.html).map((p) => p.params), ['a', 'alpha', 'a']);
  // the slider starts where the picture's own \def puts it
  assert.match(r.html, /data-name="a" data-min="0" data-max="4" data-value="3"/);
  // with a slider value, the picture's own \def gives way
  const pic = pieces(r.html)[2].piece;
  assert.match(TeXglass.renderLive(doc, pic, { a: '2' }, { renderMath }), /\[&quot;L&quot;,\[2,0\]\]/);
  // nothing of this when the paper declares no parameter
  assert.doesNotMatch(TeXglass.render('\\begin{document}$x$\\end{document}', { renderMath }).html, /tg-live|tg-params/);
});

test('values are written to the step', () => {
  assert.equal(Params.format('2.0400001', '0.02'), '2.04');
  assert.equal(Params.format('3', '0.5'), '3');
  assert.equal(Params.decimals('1e-3'), 3);
});

let tex = null;
try { execFileSync('pdflatex', ['--version'], { stdio: 'ignore' }); tex = 'pdflatex'; } catch (e) { /* no TeX here */ }
let pdftotext = false;
try { execFileSync('pdftotext', ['-v'], { stdio: 'ignore' }); pdftotext = true; } catch (e) { /* not installed */ }

test('LaTeX prints the start values TeXglass starts at', { skip: !(tex && pdftotext) && 'pdflatex or pdftotext is not installed' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'texglass-params-'));
  try {
    fs.copyFileSync(path.join(ROOT, 'latex/texglass.sty'), path.join(dir, 'texglass.sty'));
    fs.writeFileSync(path.join(dir, 'paper.tex'), DOC);
    execFileSync(tex, ['-interaction=nonstopmode', '-halt-on-error', 'paper.tex'], { cwd: dir, stdio: 'ignore' });
    const text = execFileSync('pdftotext', ['paper.pdf', '-'], { cwd: dir }).toString();
    assert.match(text, /2 in words; q is 3\./);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sliders change the values and draw the formulas and the picture again', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const r = TeXglass.render(DOC, { renderMath });
    const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.setContent(
      `<style>${fs.readFileSync(path.join(ROOT, 'vendor/katex/katex.min.css'), 'utf8')}${fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')}</style>` +
      `<article id="preview" class="document">${r.html}</article>`
    );
    await page.addScriptTag({ path: path.join(ROOT, 'vendor/katex/katex.min.js') });
    await page.addScriptTag({ path: path.join(ROOT, 'src/tikz.js') });
    await page.addScriptTag({ path: path.join(ROOT, 'src/texglass.js') });
    await page.addScriptTag({ path: path.join(ROOT, 'src/params.js') });
    await page.evaluate((doc) => {
      window.calls = 0;
      window.params = TeXglassParams.attach({
        root: document.getElementById('preview'),
        render: (piece, values) => { window.calls++; return Promise.resolve(TeXglass.renderLive(doc, piece, values)); },
      });
    }, DOC);

    // a row by the paragraph (p and q), the equation (p) and the picture (rad)
    const rows = await page.$$eval('.tg-sliders', (rs) => rs.map((r) => Array.from(r.querySelectorAll('input')).map((i) => i.dataset.param + '=' + i.value)));
    assert.deepEqual(rows, [['p=2', 'q=3'], ['p=2'], ['rad=1.25']]);
    assert.equal(await page.locator('.tg-sliders-reset:visible').count(), 0);

    // move p: every slider of p, the words and the formulas follow
    await page.locator('.math-display + .tg-sliders input').fill('3.5');
    await page.waitForFunction(() => document.querySelector('.math-display .katex-mathml').textContent.includes('3.5'));
    assert.deepEqual(await page.$$eval('input[data-param="p"]', (is) => is.map((i) => i.value)), ['3.5', '3.5']);
    assert.equal(await page.textContent('.tg-value[data-tg-param="p"]'), '3.5');
    await page.waitForFunction(() => Array.from(document.querySelectorAll('p .math-inline .katex-mathml')).filter((m) => m.textContent.includes('3.5')).length === 2);
    assert.match(await page.textContent('.math-display'), /\(1\)/); // still numbered
    assert.equal(await page.locator('.math-display .tg-live').count(), 1); // the mark stays for the next move
    assert.equal(await page.locator('.tg-sliders-reset:visible').count(), 2);
    assert.deepEqual(await page.evaluate(() => window.params.values()), { p: '3.5', rad: '1.25', q: '3' });

    // move the radius: the picture is drawn again (its model holds the new line)
    await page.locator('input[data-param="rad"]').fill('2');
    await page.waitForFunction(() => /\[2\.5,1\]|\[4,1\]/.test(document.querySelector('.tg-tikz .tikz-wrap').dataset.tikz) && document.querySelector('.tg-tikz .tikz-wrap').dataset.tikz.includes('[4,1]'));
    assert.equal(await page.locator('.tg-tikz .tg-live').count(), 1);

    // Reset puts the paper's values back
    await page.locator('.math-display + .tg-sliders .tg-sliders-reset').click();
    await page.waitForFunction(() => document.querySelector('.math-display .katex-mathml').textContent.includes('2'));
    assert.equal(await page.textContent('.tg-value[data-tg-param="p"]'), '2');

    // after the page is rendered again, moved values carry over
    await page.evaluate(() => window.params.refresh());
    assert.deepEqual(await page.$$eval('input[data-param="rad"]', (is) => is.map((i) => i.value)), ['2']);
    assert.equal(await page.locator('.tg-sliders').count(), 3);
  } finally {
    await browser.close();
  }
});
