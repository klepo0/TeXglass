'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const TeXglass = require('../src/texglass.js');
const Tikz = require('../src/tikz.js');

// Math comes back as a readable marker, as in texglass.test.js.
const plain = (src) => TeXglass.render(src, { renderMath: (t, d) => `[${d ? 'D' : 'I'}:${t.trim()}]` });
const unq = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const models = (html, attr) => [...html.matchAll(new RegExp(`${attr}="([^"]*)"`, 'g'))].map((m) => JSON.parse(unq(m[1])));

test('tikzcd: cells, arrows, label sides and arrow styles', () => {
  const { html } = plain(String.raw`\begin{document}
\begin{tikzcd}[column sep=large]
A \arrow[r, "f"] \arrow[d, "g"', hook] \arrow[dr, phantom, "\lrcorner", very near start] & B \arrow[d, two heads, "h" description] \\
C \arrow[r, dashed, bend right=20] & D
\end{tikzcd}
\end{document}`);
  assert.match(html, /column-gap:3\.2em/); // large = 2.7em, plus the cell padding allowance
  assert.match(html, /data-rc="1-1">\[I:\\displaystyle A\]/);
  assert.match(html, /data-rc="2-2">\[I:\\displaystyle D\]/);
  const [cd] = models(html, 'data-cd');
  const byEnds = (f, t) => cd.arrows.find((a) => a.f === f && a.t === t);
  assert.deepEqual(byEnds('1-1', '1-2').L, [{ k: 0, p: 0.5, s: 'l' }]);
  const g = byEnds('1-1', '2-1');
  assert.equal(g.tail, 'hook');
  assert.equal(g.L[0].s, 'r');
  const corner = byEnds('1-1', '2-2');
  assert.equal(corner.ph, 1);
  assert.equal(corner.L[0].p, 0.125);
  assert.match(html, /\[I:\\displaystyle \\lrcorner\]/); // phantom labels are full size
  const h = byEnds('1-2', '2-2');
  assert.equal(h.head, '2h');
  assert.equal(h.L[0].d, 1);
  assert.match(html, /\[I:\\scriptstyle h\]/);
  const k = byEnds('2-1', '2-2');
  assert.equal(k.dash, 'dashed');
  assert.equal(k.bend, -20);
});

test('tikzcd: named labels for 2-cells, from/to, aliases and legacy syntax', () => {
  const [cd] = models(plain(String.raw`\begin{tikzcd}
|[alias=X]| A \arrow[r, bend left, "f", ""{name=U, below}] \arrow[r, bend right, ""{name=D}] & B \arrow[from=X, to=2-2, Rightarrow] \\
& C \rar{u}
\arrow[Rightarrow, from=U, to=D, "\alpha"]
\end{tikzcd}`).html, 'data-cd');
  const two = cd.arrows.find((a) => a.f === 'U');
  assert.equal(two.t, 'D');
  assert.equal(two.dbl, 1);
  const up = cd.arrows.find((a) => a.bend === 30);
  assert.ok(up.L.some((l) => l.n === 'U' && l.k === -1 && l.s === 'below'));
  assert.ok(cd.arrows.some((a) => a.f === '1-1' && a.t === '2-2' && a.dbl === 1));
  assert.ok(cd.arrows.some((a) => a.f === '2-2' && a.t === '2-3' && a.L && a.L.length === 1));
});

test('tikzcd inside numbered display math keeps the equation number and the math around it', () => {
  const { html, labels } = plain(String.raw`\begin{document}
\begin{equation}\label{eq:d}
F = \begin{tikzcd} A \arrow[r] & B \end{tikzcd}.
\end{equation}
See \eqref{eq:d}.
\end{document}`);
  assert.equal(labels['eq:d'].num, '1');
  assert.match(html, /class="math math-display diagram-display"/);
  assert.match(html, /<span class="diagram-math">\[I:\\displaystyle F =\]<\/span><span class="tg-diagram tg-cd">/);
  assert.match(html, /<span class="diagram-math">\[I:\\displaystyle \.\]<\/span>/);
  assert.match(html, /<span class="diagram-tag">\[I:\(1\)\]<\/span>/);
});

test('diagrams.sty connects the objects around arrow cells and keeps equation labels', () => {
  const { html, labels } = plain(String.raw`\usepackage{diagrams}
\newarrow {Mono} >--->
\begin{document}
\begin{equation}\label{eq:square}
  \begin{diagram}[width=1em]
  A & & \rTo^{f} & B \\
  \dMono_g & & & \dTo<h \\
  C & \lTo{k}{l} & & D
  \end{diagram}
\end{equation}
\end{document}`);
  assert.equal(labels['eq:square'].num, '1');
  const [cd] = models(html, 'data-cd');
  assert.deepEqual(cd.arrows.map(({ f, t, tail, L }) => [f, t, tail, L.map((l) => l.s)]), [
    ['1-1', '1-4', 'none', ['above']],
    ['1-1', '3-1', 'tail', ['right']],
    ['1-4', '3-4', 'none', ['left']],
    ['3-4', '3-1', 'none', ['above', 'below']],
  ]);
  assert.match(html, /\[I:\\scriptstyle f\]/);
  assert.match(html, /\[I:\\scriptstyle l\]/);
  assert.match(html, /<span class="diagram-tag">\[I:\(1\)\]<\/span>/);
});

test('an unsupported diagrams.sty arrow keeps the diagram source for fallback', () => {
  const { html } = plain(String.raw`\begin{diagram} A & \rUnknown & B \end{diagram}`);
  assert.match(html, /data-tg-source="\\begin\{diagram\} A &amp; \\rUnknown &amp; B \\end\{diagram\}"/);
  assert.match(html, /class="graphic-placeholder"/);
});

test('xymatrix: spacing, labels, hooks, curves and 2-cells', () => {
  const { html } = plain(String.raw`\[\xymatrix@C=3pc{
X \ar[r]^{f} \ar@{^{(}->}[d]_g & Y \ar@{=}[d] \ar@/^/[dl]|{s} \\
Z \ar@{-->}[r]^-{u} \rtwocell^{p}_{q}{\alpha} & W
}\]`);
  const [cd] = models(html, 'data-cd');
  const find = (f, t) => cd.arrows.filter((a) => a.f === f && a.t === t);
  assert.equal(find('1-1', '1-2')[0].L[0].s, 'l');
  assert.equal(find('1-1', '2-1')[0].tail, 'hook');
  assert.equal(find('1-1', '2-1')[0].L[0].s, 'r');
  const eq = find('1-2', '2-2')[0];
  assert.equal(eq.dbl, 1);
  assert.equal(eq.head, 'none');
  const curved = find('1-2', '2-1')[0];
  assert.equal(curved.bend, 30);
  assert.equal(curved.L[0].d, 1);
  assert.equal(find('2-1', '2-2').find((a) => a.dash).dash, 'dashed');
  // \rtwocell: two bent arrows and a double arrow between their named midpoints
  assert.equal(find('2-1', '2-2').filter((a) => a.bend).length, 2);
  assert.ok(cd.arrows.some((a) => /^_tc\d+u$/.test(a.f) && a.dbl === 1));
  assert.match(html, /column-gap:/);
});

test('xymatrix omits the curved arrows without losing the 2-cell or its label', () => {
  const { html } = plain(String.raw`\[\xymatrix{A \drtwocell\omit{\alpha} & B\\ C & D}\]`);
  const [cd] = models(html, 'data-cd');
  assert.equal(cd.arrows.filter((a) => a.ph && a.bend).length, 2);
  assert.ok(cd.arrows.some((a) => a.dbl === 1 && a.L.length));
  assert.match(html, /\\alpha/);
  assert.doesNotMatch(html, /\[I:[^\]]*\\omit/);
});

test('tikzpicture: paths, nodes, styles from \\tikzset and \\foreach', () => {
  const { html } = plain(String.raw`\tikzset{dot/.style={circle, fill, inner sep=1pt}}
\begin{document}
\begin{tikzpicture}[scale=2]
  \draw[->, thick, red] (0,0) -- (1,0) node[right] {$x$};
  \node[dot] (a) at (0,1) {};
  \node[draw, circle] (b) at (1,1) {$b$};
  \draw[->] (a) to[bend left] node[above] {$f$} (b);
  \foreach \i in {1,...,3} \fill (\i, -1) circle (2pt);
  \draw (0,0) circle (0.5) (2,0) arc (0:90:1);
\end{tikzpicture}
\end{document}`);
  const [m] = models(html, 'data-tikz');
  assert.equal(m.paths[0].draw, Tikz._.color('red'));
  assert.equal(m.paths[0].lw, 0.8);
  assert.equal(m.paths[0].head, 'to');
  assert.deepEqual(m.paths[0].segs, [['M', [0, 0]], ['L', [2, 0]]]); // scale=2
  const dot = m.nodes.find((n) => n.name === 'a');
  assert.equal(dot.shape, 'circle');
  assert.equal(dot.fill, 'currentColor');
  assert.deepEqual(dot.at, [0, 2]);
  const edge = m.paths.find((p) => p.segs[0][1] && p.segs[0][1].n === 1);
  assert.equal(edge.segs[1][0], 'C'); // bend left
  assert.deepEqual(edge.segs[1][3], { n: 2 });
  const f = m.nodes.find((n) => n.on);
  assert.equal(f.anchor, 'south');
  assert.equal(f.on.t, 0.5);
  assert.equal(m.paths.filter((p) => p.fill === 'currentColor').length, 3);
  assert.match(html, /<span class="tikz-node" data-k="0"><span class="math math-inline" data-tex="x">\[I:x\]<\/span>/);
  assert.doesNotMatch(html, /tikz-note/);
});

test('tikzpicture: plots, calc coordinates and expressions', () => {
  const { html } = plain(String.raw`\begin{tikzpicture}
\coordinate (A) at (0,0);
\coordinate (B) at (4,2);
\draw[domain=0:2, samples=3] plot (\x, {\x*\x});
\fill ($(A)!0.5!(B)$) circle (1pt);
\draw ({2*cos(60)}, {sqrt(4)}) -- (30:2);
\end{tikzpicture}`);
  const [m] = models(html, 'data-tikz');
  assert.deepEqual(m.paths[0].segs, [['M', [0, 0]], ['L', [1, 1]], ['L', [2, 4]]]);
  assert.deepEqual(m.paths[2].segs[0][1], [1, 2]);
  const p = m.paths[2].segs[1][1];
  assert.ok(Math.abs(p[0] - Math.sqrt(3)) < 1e-3 && Math.abs(p[1] - 1) < 1e-3);
  // the circle around the midpoint (2, 1)
  const xs = m.paths[1].segs.filter((s) => s[0] === 'C').map((s) => s[3][0]);
  assert.ok(Math.abs((Math.max(...xs) + Math.min(...xs)) / 2 - 2) < 1e-3);
});

test('tikzpicture: unsupported pictures fall back to their source', () => {
  const { html } = plain(String.raw`\begin{tikzpicture}\begin{axis}\addplot {x^2};\end{axis}\end{tikzpicture}`);
  assert.match(html, /tikz-fallback/);
  assert.match(html, /<details><summary>Source<\/summary><pre>/);
  const partial = plain(String.raw`\begin{tikzpicture}\draw (0,0) -- (1,1); \pic {foo};\end{tikzpicture}`).html;
  assert.match(partial, /tikz-note/);
  assert.match(partial, /data-tikz/);
});

test('colours follow the theme: black is the text colour and white the page', () => {
  const { color } = Tikz._;
  assert.equal(color('black'), 'currentColor');
  assert.equal(color('white'), 'var(--paper, #fff)');
  assert.equal(color('blue!20'), 'color-mix(in srgb, #2f6fdd 20%, var(--paper, #fff))');
  assert.equal(color('red!50!black'), 'color-mix(in srgb, #e53935 50%, currentColor)');
  assert.match(color('gray'), /currentColor 50%/);
});

test('expressions and \\foreach lists', () => {
  const { evaluate, expandList } = Tikz._;
  assert.equal(evaluate('2*3+1').v, 7);
  assert.ok(Math.abs(evaluate('sin(30)').v - 0.5) < 1e-9);
  assert.ok(Math.abs(evaluate('cos(pi r)').v + 1) < 1e-9);
  assert.equal(evaluate('2^3^2').v, 512);
  const cm = evaluate('1cm + 10mm');
  assert.ok(cm.unit && Math.abs(cm.v - 2) < 1e-9);
  assert.deepEqual(expandList('1,...,4'), ['1', '2', '3', '4']);
  assert.deepEqual(expandList('0,0.5,...,2'), ['0', '0.5', '1', '1.5', '2']);
  assert.deepEqual(expandList('a,...,d'), ['a', 'b', 'c', 'd']);
});

test('a diagram wrapped in an array or \\fbox keeps the math around it balanced', () => {
  const { html } = plain(String.raw`\[\begin{array}{c}\xymatrix{A \ar[r] & B}\end{array}\qquad \fbox{\xymatrix{C}}\]`);
  assert.doesNotMatch(html.replace(/ data-tex="[^"]*"/g, ''), /\\begin\{array\}|\\fbox/); // rendered, not as source
  assert.equal(models(html, 'data-cd').length, 2);
});

test('an exported page carries the diagram script only when it has diagrams', () => {
  const Export = require('../src/export.js');
  const js = 'window.X = "</script>";';
  const withD = Export.page({ body: plain(String.raw`\begin{tikzcd}A\end{tikzcd}`).html, diagramsJs: js });
  assert.match(withD, /<script>window\.X = "<\\\/script>";<\/script>/);
  assert.doesNotMatch(Export.page({ body: '<p>x</p>', diagramsJs: js }), /window\.X/);
});

test('tikzpicture: macros with arguments, and path macros defined before the picture', () => {
  const { html } = plain(String.raw`\begin{document}
\def\edge{(0,0) -- (1,2)}
\begin{tikzpicture}
\def\branches#1{\draw[#1] (0,0) -- (3,0);\draw[#1] (0,1) -- (3,1);}
\newcommand{\dot}[1]{\fill (#1) circle (1pt);}
\branches{red}
\dot{2,2}
\draw \edge;
\foreach \e in {\edge} \draw[blue] \e;
\end{tikzpicture}
\end{document}`);
  const [m] = models(html, 'data-tikz');
  assert.doesNotMatch(html, /tikz-note/);
  assert.equal(m.paths.filter((p) => p.draw === '#e53935').length, 2);
  assert.deepEqual(m.paths[0].segs, [['M', [0, 0]], ['L', [3, 0]]]);
  assert.deepEqual(m.paths.find((p) => p.draw === '#2f6fdd').segs, [['M', [0, 0]], ['L', [1, 2]]]);
  assert.deepEqual(m.bbox, [0, 0, 3, 2.035]);
});

test('tikzpicture: \\clip cuts later paths and pictures in its scope; overlay nodes take no room', () => {
  const { html } = plain(String.raw`\begin{document}\begin{tikzpicture}
\path (0,0) rectangle (4,3);
\begin{scope}
  \clip (0,0) rectangle (2,2);
  \node[overlay,anchor=south west] at (0,0) {\includegraphics[width=10cm]{a.png}};
  \begin{scope}[shift={(1,0)},x=0.01cm,y=-0.01cm]
    \clip (0,-100) rectangle (50,0);
    \draw (0,0) -- (500,-500);
  \end{scope}
\end{scope}
\draw (0,0) -- (1,1);
\end{tikzpicture}\end{document}`);
  const [m] = models(html, 'data-tikz');
  assert.equal(m.clips.length, 2);
  assert.equal(m.clips[1].parent, 0);
  const cut = m.paths.find((p) => p.clip === 1);
  assert.deepEqual(cut.segs[1], ['L', [6, 5]]);
  assert.equal(m.nodes[0].ov, 1);
  assert.equal(m.nodes[0].clip, 0);
  assert.deepEqual(m.bbox, [0, 0, 4, 3]); // not the 10cm picture, nor the clipped line
});

test('tikzpicture: font sizes, hatching patterns and braces', () => {
  const { html } = plain(String.raw`\begin{document}\begin{tikzpicture}[every node/.style={font=\fontsize{8}{10}\selectfont}]
\node at (0,0) {a};
\node[font=\small] at (1,0) {\tiny{$0$}};
\draw[pattern=north west lines, pattern color=blue, opacity=0.2] (0,0) rectangle (1,1);
\draw[decorate,decoration={brace,amplitude=4pt,mirror}] (0,0) -- (2,0);
\end{tikzpicture}\end{document}`);
  const [m] = models(html, 'data-tikz');
  assert.doesNotMatch(html, /tikz-note/);
  assert.equal(m.nodes[0].scale, 0.8);
  assert.equal(m.nodes[1].scale, 0.45);
  assert.match(html, /data-k="1"><span[^>]*>\[I:0\]/); // the size command is gone
  assert.deepEqual(m.paths[0].pat, { c: '#2f6fdd', k: 'north west lines' });
  const brace = m.paths[1].segs;
  assert.equal(brace.length, 8);
  assert.deepEqual(brace[0], ['M', [0, 0]]);
  assert.deepEqual(brace[3][3], [1, -0.141]); // the tip, 4pt below the middle (mirrored)
  assert.deepEqual(brace[7][3], [2, 0]);
});

test('diagram fractions keep both arguments and support math tags and uniform xymatrix spacing', () => {
  const { html } = plain(String.raw`\[
F=\dfrac{\xymatrix@!=0.5pc{A \ar[r] & B}}{\xymatrix@!{C}}
\tag*{$\mathsf{R_{ab}}$}
\]`);
  assert.match(html, /class="diagram-fraction"/);
  assert.match(html, /class="diagram-tag">\[I:\\mathsf\{R_\{ab\}\}\]/);
  const diagrams = models(html, 'data-cd');
  assert.equal(diagrams.length, 2);
  assert.equal(diagrams[0].arrows[0].t, '1-2');
});
