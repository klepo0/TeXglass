'use strict';
// Run `npm run copy-shared` first: the worker loads ../shared/texglass.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Worker } = require('worker_threads');

function render(job) {
  const w = new Worker(path.join(__dirname, '..', 'render-worker.js'));
  return new Promise((resolve, reject) => {
    w.once('message', (m) => { w.terminate(); resolve(m); });
    w.once('error', reject);
    w.postMessage(Object.assign({ id: 1 }, job));
  });
}

test('renders blocks with source ranges and KaTeX math', async () => {
  const text = '\\begin{document}\n\\section{Intro}\\label{s}\nSee \\ref{s} and $x^2$.\n\\end{document}\n';
  const m = await render({ text });
  assert.strictEqual(m.id, 1);
  assert.ok(!m.error, m.error);
  assert.ok(m.result.blocks.length >= 2);
  assert.match(m.result.blocks[0], /^<div class="src-block" data-s="\d+" data-e="\d+">/);
  assert.match(m.result.blocks.join(''), /class="katex"/);
  assert.strictEqual(m.result.html, undefined);
});

test('finds figures next to the file, trying image extensions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'texglass-'));
  fs.mkdirSync(path.join(dir, 'figs'));
  fs.writeFileSync(path.join(dir, 'figs', 'plot one.png'), '');
  const text = '\\graphicspath{{figs/}}\\begin{document}\n\\includegraphics{plot one.pdf}\n\\includegraphics{missing}\n\\includegraphics{../secret}\n\\end{document}\n';
  const m = await render({ text, dir, base: 'https://webview/base' });
  const html = m.result.blocks.join('\n');
  assert.ok(html.includes('https://webview/base/figs/plot%20one.png'), html);
  assert.ok(!html.includes('secret.png'));
});
