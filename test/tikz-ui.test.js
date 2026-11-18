'use strict';
// TikZ pictures drawn in a real browser: clips, hatching, pictures in nodes and
// fitting to the column. Skipped where Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const TeXglass = require('../src/texglass.js');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');
// a 20×10 PNG
const PNG = 'data:image/png;base64,' + Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000140000000a0802000000' + '3b37e9b1' +
  '0000001549444154789c63fccf4003302109a08a1ab5000097ba1101df0bc4d40000000049454e44ae426082', 'hex').toString('base64');

test('tikz pictures: \\clip, patterns, pictures under the drawing, and wide pictures fit the column', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const { html } = TeXglass.render(String.raw`\begin{document}
\begin{tikzpicture}
\path (0,0) rectangle (4,3);
\begin{scope}
  \clip (0,0) rectangle (2,2);
  \node[overlay,anchor=south west] at (0,0) {\includegraphics[width=4cm]{a.png}};
  \draw[pattern=north east lines] (0,0) rectangle (3,3);
\end{scope}
\end{tikzpicture}

\begin{tikzpicture}\draw (0,0) -- (30,0);\end{tikzpicture}

\resizebox{\linewidth}{!}{\begin{tikzpicture}\draw (0,0) -- (2,1);\end{tikzpicture}}
\end{document}`, { renderMath: (s) => s, resolveImage: () => PNG });
    const page = await browser.newPage({ viewport: { width: 600, height: 800 } });
    await page.setContent(`<style>${fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')}</style><article id="doc" style="width:500px">${html}</article>`);
    await page.addScriptTag({ path: path.join(ROOT, 'src/diagrams.js') });
    await page.waitForFunction(() => document.querySelectorAll('.tikz-svg').length === 3);
    const r = await page.evaluate(() => new Promise((done) => setTimeout(() => {
      const [a, b, c] = document.querySelectorAll('.tikz-wrap');
      const img = a.querySelector('img');
      const node = img.closest('.tikz-node');
      const box = (e) => { const q = e.getBoundingClientRect(); return [Math.round(q.width), Math.round(q.height)]; };
      done({
        clipPaths: a.querySelectorAll('clipPath').length,
        clipped: a.querySelectorAll('path[clip-path]').length,
        pattern: !!a.querySelector('pattern line') && /url\(#/.test(a.querySelector('path[clip-path]').getAttribute('style')),
        under: getComputedStyle(node).zIndex,
        nodeClip: node.style.clipPath,
        imgW: Math.round(img.getBoundingClientRect().width),
        em: parseFloat(getComputedStyle(a).fontSize),
        a: box(a), b: box(b), c: box(c),
      });
    }, 300)));
    assert.equal(r.clipPaths, 1);
    assert.equal(r.clipped, 2); // the hatching and the outline
    assert.ok(r.pattern, 'the rectangle is hatched');
    assert.equal(r.under, '-1');
    assert.match(r.nodeClip, /^inset\(/);
    assert.ok(Math.abs(r.imgW - 4 * 2.8453 * r.em) < 2, `the picture is 4cm wide (${r.imgW}px)`);
    // the overlay picture does not widen the drawing: 4cm and a margin
    assert.ok(r.a[0] < 4.2 * 2.8453 * r.em, `${r.a[0]}px`);
    assert.ok(r.b[0] <= 501, `a 30cm line is scaled to the 500px column (${r.b[0]}px)`);
    assert.ok(Math.abs(r.c[0] - 500) <= 1, `\\resizebox{\\linewidth} fills the column (${r.c[0]}px)`);
  } finally {
    await browser.close();
  }
});
