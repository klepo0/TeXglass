'use strict';
// PDF figures: kept from a paper's source, then drawn with pdf.js in the viewer.
// The browser part is skipped where Playwright and a browser are not installed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const A = require('../src/arxiv.js');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch (e) { /* not installed */ }

const ROOT = path.join(__dirname, '..');

/** A one-page PDF of `w` × `h` points with a blue rectangle on it. */
function tinyPdf(w, h) {
  const content = `0 0 1 rg 10 10 ${w - 20} ${h - 20} re f`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents 4 0 R /Resources << >> >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, k) => { offsets.push(out.length); out += `${k + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function tar(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const PAPER = tar({
  'main.tex': String.raw`\documentclass{article}\begin{document}
\includegraphics{plot} \includegraphics{both.pdf}
\end{document}`,
  'plot.pdf': tinyPdf(100, 50),
  'both.pdf': tinyPdf(100, 50),
  'both.png': 'PNG',
});

test('.pdf figures are kept from a paper, unless the authors also uploaded a picture browsers can show', async () => {
  const p = await A.importPaper('2301.00003', { fetch: async () => new Response(zlib.gzipSync(PAPER), { headers: { 'content-type': 'application/gzip' } }) });
  assert.deepEqual(Object.keys(p.images).sort(), ['both.png', 'plot.pdf']);
  assert.equal(p.images['plot.pdf'].type, 'application/pdf');
  const resolve = A.imageResolver({ 'plot.pdf': 'blob:plot', 'both.png': 'blob:both' }, p.source);
  assert.equal(resolve('plot'), 'blob:plot');
  assert.equal(resolve('both.pdf'), 'blob:both');
});

test('the viewer draws .pdf figures with pdf.js, at the size of the PDF page', { skip: !chromium && 'Playwright is not installed' }, async (t) => {
  let browser;
  try { browser = await chromium.launch(); } catch (e) { t.skip('no browser: ' + e.message.split('\n')[0]); return; }
  try {
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
    await context.route('**/*', (r) => {
      const url = new URL(r.request().url());
      if (url.host === 'texglass.test') {
        const p = decodeURIComponent(url.pathname.slice(1)) || 'index.html';
        const file = path.join(ROOT, p);
        if (p === 'sw.js' || !file.startsWith(ROOT) || !fs.existsSync(file)) return r.fulfill({ status: 404, body: '' });
        return r.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(p)] || 'application/octet-stream' });
      }
      if (url.host === 'arxiv.org') return r.fulfill({ body: zlib.gzipSync(PAPER), headers: { 'access-control-allow-origin': '*', 'content-type': 'application/gzip' } });
      if (url.protocol === 'blob:' || url.protocol === 'data:') return r.continue();
      return r.abort();
    });
    const page = await context.newPage();
    await page.goto('http://texglass.test/index.html?arxiv=2301.00003');
    await page.waitForFunction(() => {
      const img = document.querySelector('#preview img.graphic[alt="plot"]');
      return img && img.complete && img.naturalWidth > 0 && !document.documentElement.dataset.pdfFigures;
    }, null, { timeout: 30000 });
    const r = await page.evaluate(async () => {
      const img = document.querySelector('#preview img.graphic[alt="plot"]');
      const svg = await (await fetch(img.src)).text();
      return { w: img.naturalWidth, h: img.naturalHeight, png: /href="data:image\/png;base64,/.test(svg) };
    });
    // 100 × 50 pt is 133 × 67 CSS pixels
    assert.equal(r.w, 133);
    assert.equal(r.h, 67);
    assert.ok(r.png, 'the drawing is inside the SVG');
  } finally {
    await browser.close();
  }
});
