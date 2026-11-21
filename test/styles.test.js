'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// A stray brace makes the browser drop the rule after it without a word: it once
// hid the find bar's own rule, so the bar sat unpositioned under the zoom box.
for (const file of ['styles.css', 'vscode/media/preview.css']) {
  test(`${file} has balanced braces`, () => {
    const css = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
    let depth = 0;
    css.split('\n').forEach((line, k) => {
      for (const ch of line) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        assert.ok(depth >= 0, `unmatched } on line ${k + 1}`);
      }
    });
    assert.equal(depth, 0, 'unclosed {');
  });
}

// Filled accent buttons ("Open in TeXglass" in a citation preview, the arXiv dialog's
// primary button): the accent is light in the dark theme and chalk-white on the
// handwritten board, so white text on it was all but invisible. Text goes in
// var(--on-accent); check WCAG AA (4.5:1) in every theme and look.
let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

test('text on filled accent buttons has AA contrast in light, dark and handwritten looks', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message); return; }
  try {
    const page = await browser.newPage();
    const ROOT = path.join(__dirname, '..');
    const css = ['styles.css', 'vscode/media/notes.css'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
    await page.setContent(`<style>${css}</style><div class="ref-popover"><div class="cite-actions">
      <button class="cite-open">Open in TeXglass</button></div></div>
      <div class="arxiv-actions"><button class="primary">Open</button></div>
      <div class="folder-hint"><button>Open folder</button></div>
      <ol class="bibliography"><li>Entry <button class="bib-open" style="background: var(--accent); color: var(--on-accent)"></button></li></ol>`);
    for (const theme of ['light', 'dark']) {
      for (const look of ['standard', 'notes']) {
        const ratios = await page.evaluate(([theme, look]) => {
          const root = document.documentElement;
          root.dataset.theme = theme;
          if (look === 'notes') root.dataset.look = 'notes'; else delete root.dataset.look;
          const lum = (c) => {
            const [r, g, b] = c.match(/[\d.]+/g).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
            return 0.2126 * r + 0.7152 * g + 0.0722 * b;
          };
          return [...document.querySelectorAll('button')].map((b) => {
            const cs = getComputedStyle(b);
            const [x, y] = [lum(cs.color), lum(cs.backgroundColor)];
            return [b.className || b.parentNode.className, (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)];
          });
        }, [theme, look]);
        for (const [name, ratio] of ratios) assert.ok(ratio >= 4.5, `${name} in ${theme}/${look}: contrast ${ratio.toFixed(2)}`);
      }
    }
  } finally { await browser.close(); }
});
