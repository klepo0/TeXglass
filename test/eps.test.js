'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const Eps = require('../src/eps.js');
const A = require('../src/arxiv.js');

// The shape of an xfig (fig2dev) figure: a prolog of procedures, then the drawing.
const FIG = String.raw`%!PS-Adobe-2.0 EPSF-2.0
%%Creator: fig2dev Version 3.2
%%BoundingBox: 0 0 100 50
/$F2psDict 200 dict def
$F2psDict begin
$F2psDict /mtrx matrix put
/col-1 {0 setgray} bind def
/col4 {1.000 0.000 0.000 srgb} bind def
end
save
-10.0 60.0 translate
1 -1 scale
/l {lineto} bind def /m {moveto} bind def /n {newpath} bind def /s {stroke} bind def
/gs {gsave} bind def /gr {grestore} bind def /srgb {setrgbcolor} bind def /sc {scale} bind def
/slw {setlinewidth} bind def /tr {translate} bind def /cp {closepath} bind def /ef {eofill} bind def
/ff {findfont} bind def /scf {scalefont} bind def /sf {setfont} bind def /sh {show} bind def
/rm {rmoveto} bind def /sw {stringwidth} bind def
/DrawEllipse {
	/endangle exch def /startangle exch def /yrad exch def /xrad exch def /y exch def /x exch def
	/savematrix mtrx currentmatrix def
	x y tr xrad yrad sc 0 0 1 startangle endangle arc
	closepath savematrix setmatrix
	} def
/$F2psBegin {$F2psDict begin /$F2psEnteredState save def} def
/$F2psEnd {$F2psEnteredState restore end} def
$F2psBegin
10 setmiterlimit
 0.06000 0.06000 sc
7.500 slw
% Polyline
n 300 300 m 1500 300 l 1500 900 l gs col4 s gr
% Ellipse
n 600 600 150 75 0 360 DrawEllipse gs 0.00 setgray ef gr
[60] 0 setdash
n 300 900 m 900 900 l gs col-1 s gr
[] 0 setdash
/Symbol ff 180.00 scf sf
900 600 m
gs 1 -1 sc (a) dup sw pop 2 div neg 0 rm col-1 sh gr
/Times-Italic ff 180.00 scf sf
1200 600 m
gs 1 -1 sc (x<1) col-1 sh gr
$F2psEnd
showpage
`;

test('an xfig EPS figure becomes SVG: lines, colours, ellipses, dashes and text', () => {
  const r = Eps.toSvg(FIG);
  assert.ok(r, 'something was drawn');
  assert.equal(r.partial, false);
  const { svg } = r;
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="100pt" height="50pt" viewBox="0 -50 100 50">/);
  assert.match(svg, /<rect x="0" y="-50" width="100" height="50" fill="#fff"\/>/);
  // device point of (300,300): 0.06 * 300 = 18, then x - 10 and 60 - y, then y flipped for SVG
  assert.match(svg, /<path d="M8,-42L80,-42L80,-6" style="fill:none;stroke:rgb\(255,0,0\);stroke-width:0.45/);
  assert.match(svg, /fill-rule:evenodd/); // the ellipse
  assert.match(svg, /stroke-dasharray:3.6;/);
  assert.match(svg, /font-family:serif;font-size:1px;fill:rgb\(0,0,0\)">α<\/text>/); // Symbol a
  assert.match(svg, /font-style:italic[^>]*>x&lt;1<\/text>/);
});

test('EPS: control flow, dictionaries and errors that do not stop the drawing', () => {
  const r = Eps.toSvg(`%!PS\n%%BoundingBox: 0 0 10 10\n/sq { dup mul } def\n0 1 2 { /i exch def i sq 0 moveto 1 1 rlineto stroke } for\nundefinedthing\n<< /a 3 >> /a get 0 moveto 0 1 rlineto stroke\n{ nosuchop } stopped { 5 5 moveto 1 0 rlineto stroke } if\n`);
  assert.equal((r.svg.match(/<path/g) || []).length, 5);
  assert.match(r.svg, /M4,0L5,-1/); // i = 2
  assert.match(r.svg, /M3,0L3,-1/); // from the dictionary
  assert.equal(r.partial, true); // the undefined name
  assert.equal(Eps.toSvg('%!PS\n1 2 add pop\n'), null);
  assert.equal(Eps.toSvg('%!PS\n{ } loop\n'), null); // a runaway loop is cut short
});

test('arXiv import draws .eps figures as SVG unless a picture of the same name is there', async () => {
  const tarball = (files) => {
    const blocks = [];
    for (const [name, text] of Object.entries(files)) {
      const data = Buffer.from(text);
      const h = Buffer.alloc(512);
      h.write(name, 0); h.write('0000644\0', 100); h.write(data.length.toString(8).padStart(11, '0') + '\0', 124); h.write('0', 156); h.write('ustar\0' + '00', 257);
      blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return zlib.gzipSync(Buffer.concat(blocks));
  };
  const respond = (body) => async () => new Response(body, { status: 200, headers: { 'content-type': 'application/gzip' } });
  const p = await A.importPaper('cond-mat/0503313', { fetch: respond(tarball({
    'art.tex': '\\documentclass{article}\\begin{document}\\includegraphics{hex.eps}\\includegraphics{plot}\\end{document}',
    'hex.eps': FIG, 'plot.eps': FIG, 'plot.png': 'PNG',
  })) });
  assert.deepEqual(Object.keys(p.images).sort(), ['hex.eps', 'plot.png']);
  assert.equal(p.images['hex.eps'].type, 'image/svg+xml');
  assert.match(await p.images['hex.eps'].text(), /^<svg /);
  const resolve = A.imageResolver({ 'hex.eps': 'blob:hex', 'plot.png': 'blob:plot' }, p.source);
  assert.equal(resolve('hex.eps'), 'blob:hex');
  assert.equal(resolve('hex'), 'blob:hex');
  assert.equal(resolve('plot'), 'blob:plot');
});
