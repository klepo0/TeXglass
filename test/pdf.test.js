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

const RASTER_EPS = String.raw`%!PS-Adobe-3.0 EPSF-3.0
%%Creator: GPL Ghostscript 10070 (eps2write)
%%BeginPageSetup
4 0 obj
<</Type/Page/MediaBox [0 0 100 50] /Contents 5 0 R >>
endobj
%%EndPageSetup
5 0 obj
<</Length 125>>stream
q 1 0 0 1 0 0 cm
q 100 0 0 -50 0 50 cm
BI
/CS/DeviceRGB /W 1 /H 1 /BPC 8 /F[/A85 /Fl]
ID
Gb"ZW^]4?:!!*'~>
EI Q Q
endstream
endobj
%%PageTrailer
`;

test('eps2write only forwards the supported single-raster layout', () => {
  const eps = require('../src/eps.js');
  assert.match(eps.rasterPdf(RASTER_EPS), /^%PDF-1.4/);
  assert.equal(eps.rasterPdf(RASTER_EPS.replace('EI Q Q', 'EI 1 1 m Q Q')), null);
  assert.equal(eps.rasterPdf(RASTER_EPS.replace('/W 1', '/W 140000001')), null);
});

const PAPER = tar({
  'main.tex': String.raw`\documentclass{article}\begin{document}
\includegraphics{plot} \includegraphics{both.pdf} \includegraphics{raster.eps}
\end{document}`,
  'plot.pdf': tinyPdf(100, 50),
  'raster.eps': RASTER_EPS,
  'both.pdf': tinyPdf(100, 50),
  'both.png': 'PNG',
});

test('.pdf figures are kept from a paper, unless the authors also uploaded a picture browsers can show', async () => {
  const p = await A.importPaper('2301.00003', { fetch: async () => new Response(zlib.gzipSync(PAPER), { headers: { 'content-type': 'application/gzip' } }) });
  assert.deepEqual(Object.keys(p.images).sort(), ['both.png', 'plot.pdf', 'raster.eps']);
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
    const raster = await page.locator('#preview img[alt="raster.eps"]').evaluate(async (img) => {
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, 1, 1);
      return Array.from(ctx.getImageData(0, 0, 1, 1).data);
    });
    assert.deepEqual(raster, [255, 0, 0, 255]);
  } finally {
    await browser.close();
  }
});

test('Cairo single-image EPS preserves its page box and clipping', () => {
  const eps = require('../src/eps.js');
  const source = String.raw`%!PS-Adobe-3.0 EPSF-3.0
%%BoundingBox: 0 1 100 51
%%Creator: cairo 1.16.0
%%EndPageSetup
q 0 1 100 50 rectclip
1 0 0 -1 0 51 cm q
q
0 0 100 50 re W n
[ 100 0 0 50 0 0 ] concat
/cairo_ascii85_file currentfile /ASCII85Decode filter def
/DeviceRGB setcolorspace
<<
  /ImageType 1
  /Width 1
  /Height 1
  /Interpolate false
  /BitsPerComponent 8
  /Decode [ 0 1 0 1 0 1 ]
  /DataSource cairo_ascii85_file /FlateDecode filter
  /ImageMatrix [ 1 0 0 -1 0 1 ]
>>
cairo_image
Gb"ZW^]4?:!!*'~>
Q
Q Q
showpage
`;
  const pdf = eps.rasterPdf(source);
  assert.match(pdf, /\/MediaBox \[0 1 100 51\]/);
  assert.match(pdf, /0 1 100 50 re W n 1 0 0 -1 0 51 cm/);
  assert.equal(eps.rasterPdf(source.replace('/ImageType 1', '/ImageType 3')), null);
});
