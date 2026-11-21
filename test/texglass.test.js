'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const katex = require('katex');
const TeXglass = require('../src/texglass.js');

// Render math as a readable marker so tests can see exactly what KaTeX would get.
const plain = (src) => TeXglass.render(src, { renderMath: (t, d) => `[${d ? 'D' : 'I'}:${t.trim()}]`, today: 'TODAY' });
const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ');

test('numbers theorems within sections with a shared counter', () => {
  const { html } = plain(String.raw`
\newtheorem{theorem}{Theorem}[section]
\newtheorem{lemma}[theorem]{Lemma}
\begin{document}
\section{One}
\begin{lemma}A\end{lemma}
\begin{theorem}[Big]B\end{theorem}
\section{Two}
\begin{theorem}C\end{theorem}
\end{document}`);
  const t = text(html);
  assert.match(t, /Lemma 1\.1\. A/);
  assert.match(t, /Theorem 1\.2 \(Big\)\. B/);
  assert.match(t, /Theorem 2\.1\. C/);
});

test('\\ref, \\eqref and \\cref resolve labels, including forward references', () => {
  const { html, warnings } = plain(String.raw`
\newtheorem{thm}{Theorem}
\newtheorem{lem}[thm]{Lemma}
See Lemma~\ref{lem:a}, \cref{lem:a}, \Cref{eq:x} and \eqref{eq:x}.
\begin{thm}x\end{thm}
\begin{lem}\label{lem:a}
\begin{equation}\label{eq:x} a = b \end{equation}
\end{lem}`);
  const t = text(html);
  assert.match(t, /See Lemma 2, lemma 2, Equation \(1\) and \(1\)\./);
  assert.deepEqual(warnings, []);
  assert.match(html, /<div class="theorem[^"]*" id="(thm-\d+)"[^>]*>.*Lemma 2/);
});

test('label inside a theorem after an equation still refers to the theorem', () => {
  const { html } = plain(String.raw`
\begin{theorem}
\begin{equation} x \end{equation}
\label{t}
\end{theorem}
Theorem \ref{t}.`);
  assert.match(text(html), /Theorem 1\.$/m);
});

test('default theorem environments work without \\newtheorem', () => {
  const t = text(plain(String.raw`\begin{theorem}a\end{theorem}\begin{definition}b\end{definition}\begin{remark*}c\end{remark*}`).html);
  assert.match(t, /Theorem 1\. a/);
  assert.match(t, /Definition 2\. b/);
  assert.match(t, /Remark\. c/);
});

test('unnumbered theorems via \\newtheorem*', () => {
  const t = text(plain(String.raw`\newtheorem*{claim}{Claim}\begin{claim}x\end{claim}`).html);
  assert.match(t, /Claim\. x/);
});

test('sections are numbered and \\appendix switches to letters', () => {
  const { html } = plain(String.raw`
\section{A}\label{s:a}\subsection{B}\label{s:b}\section*{Unnumbered}\appendix\section{Extra}\label{s:x}
\ref{s:a} \ref{s:b} \ref{s:x}`);
  const t = text(html);
  assert.match(t, /1A/);
  assert.match(t, /1\.1B/);
  assert.match(t, /AExtra/);
  assert.match(t, /1 1\.1 A/);
});

test('align numbers each row, honours \\nonumber and \\tag', () => {
  const { html } = plain(String.raw`
\begin{align}
 a &= b \label{r1} \\
 c &= d \nonumber \\
 e &= f \tag{$*$} \label{r3}
\end{align}
\eqref{r1} \eqref{r3}`);
  assert.match(html, /\[D:\\begin\{align\*\}\s*a &= b\s*\\tag\{1\} \\\\\s*c &= d\s*\\\\\s*e &= f\s*\\tag\{\$\*\$\}\\end\{align\*\}\]/);
  assert.match(text(html), /\(1\) \(\$\*\$\)/);
});

test('\\numberwithin{equation}{section}', () => {
  const { html } = plain(String.raw`\numberwithin{equation}{section}\section{S}\begin{equation}\label{e}x\end{equation}\ref{e}`);
  assert.match(html, /\\tag\{1\.1\}/);
  assert.match(text(html), /1\.1$/m);
});

test('inline and display math delimiters', () => {
  const { html } = plain(String.raw`a $x$ b \(y\) c $$z$$ d \[w\] e \begin{equation*}v\end{equation*}`);
  for (const m of ['[I:x]', '[I:y]', '[D:z]', '[D:w]', '[D:v]']) assert.ok(html.includes(m), m);
});

test('refs inside math become text', () => {
  const { html } = plain(String.raw`\begin{equation}\label{a}x\end{equation} $\stackrel{\eqref{a}}{=}$`);
  assert.ok(html.includes('[I:\\stackrel{\\text{(1)}}{=}]'));
});

test('missing references are flagged', () => {
  const { html, warnings } = plain(String.raw`See \ref{nope}.`);
  assert.match(html, /ref-missing/);
  assert.deepEqual(warnings, ['Undefined reference "nope".']);
});

test('enumerate items can be labelled and referenced', () => {
  const t = text(plain(String.raw`
\begin{enumerate}[label=(\alph*)]
\item\label{i1} one
\item\label{i2} two
\end{enumerate}
\begin{enumerate}\item x \begin{enumerate}\item\label{n} y\end{enumerate}\end{enumerate}
\ref{i2} \ref{n}`).html);
  assert.match(t, /\(a\)\s*one/);
  assert.match(t, /\(b\) \(1a\)|\(b\) 1a/);
});

test('user macros reach KaTeX and expand in text', () => {
  let seen = null;
  const r = TeXglass.render(String.raw`\newcommand{\R}{\mathbb{R}}\newcommand{\ie}{i.e.}\DeclareMathOperator{\Hom}{Hom} $\R \Hom$ \ie`, {
    renderMath: (t, d, macros) => { seen = macros; return 'M'; },
  });
  assert.equal(seen['\\R'], '\\mathbb{R}');
  assert.equal(seen['\\Hom'], '\\operatorname{Hom}');
  assert.match(text(r.html), /M i\.e\./);
});

// Render with real KaTeX and drop the source annotation, so a formula using
// user macros can be compared with the same formula written out by hand.
const katexOpts = { throwOnError: true, strict: 'ignore' };
const dropAnnotation = (html) => html.replace(/<annotation[^]*?<\/annotation>/g, '');
const realMath = (src) =>
  TeXglass.render(src, {
    renderMath: (tex, displayMode, macros) =>
      dropAnnotation(katex.renderToString(tex, Object.assign({ displayMode, macros }, katexOpts))),
  });
const handMath = (tex) => dropAnnotation(katex.renderToString(tex, Object.assign({ displayMode: false }, katexOpts)));
const MACRO_PREAMBLE = String.raw`
\newcommand{\R}{\mathbb{R}}
\newcommand{\pair}[2][x]{\langle #1, #2\rangle}
\newcommand\abs[1]{\lvert #1\rvert}
\newcommand{\second}[2]{#2}
\renewcommand{\phi}{\varphi}
\def\eps{\varepsilon}
\def\inner#1#2{(#1|#2)}
\def\pr(#1,#2){P(#1\mid #2)}
\DeclareMathOperator{\Hom}{Hom}
\DeclareMathOperator*{\argmax}{arg\,max}
\newcommand{\RR}{\R}
\newcommand{\name}[1][World]{Hello #1}
`;

test('\\ensuremath in user macros works inside math, and graphicx boxes and @{} columns reach KaTeX cleanly', () => {
  const pre = String.raw`\newcommand{\X}{\ensuremath{\mathbb{X}}\xspace}\def\Y{\ensuremath\alpha}`;
  const cases = [
    [String.raw`\X^2`, String.raw`\mathbb{X}^2`],
    [String.raw`\Y_1`, String.raw`\alpha_1`],
    [String.raw`\resizebox{\linewidth}{!}{$\displaystyle \frac{a}{b}=1$}`, String.raw`\displaystyle \frac{a}{b}=1`],
    [String.raw`\scalebox{0.5}{$x$}`, 'x'],
    [String.raw`\begin{array}{l@{}l} a & b\end{array}`, String.raw`\begin{array}{ll} a & b\end{array}`],
    [String.raw`\begin{array}{>{\displaystyle}c|p{2cm}} a & b\end{array}`, String.raw`\begin{array}{c|l} a & b\end{array}`],
  ];
  for (const [use, hand] of cases) {
    const { html } = realMath(pre + `\\begin{document}$${use}$\\end{document}`);
    assert.ok(html.includes(handMath(hand)), `${use} should render as ${hand}`);
  }
  // in text, \ensuremath still makes math
  assert.match(plain(pre + String.raw`\begin{document}a \X b\end{document}`).html, /\[I:\\mathbb\{X\}\]/);
});

test('\\includegraphics with an absolute width, and \\resizebox around a picture', () => {
  const r = TeXglass.render(String.raw`\begin{document}\includegraphics[width=4.85cm]{a.png} \includegraphics[height=2in]{b.png}
\resizebox{0.96\linewidth}{!}{\begin{tikzpicture}\draw (0,0) -- (1,1);\end{tikzpicture}}
\resizebox{3cm}{!}{text}\end{document}`, { renderMath: (t) => t, resolveImage: (p) => p });
  assert.ok(r.html.includes('style="width:13.8em"'), 'width=4.85cm is 13.8em at 10pt');
  assert.ok(r.html.includes('style="height:14.454em"'));
  assert.match(r.html, /<span class="tg-resize" data-fit="0\.96"><span class="tg-diagram tg-tikz">/);
  assert.doesNotMatch(text(r.html), /!|linewidth|3cm/);
});

test('user macros in math: arguments, defaults, \\def and operators', () => {
  const cases = [
    [String.raw`\pair{y}`, String.raw`\langle x, y\rangle`],
    [String.raw`\pair[z]{w}+1`, String.raw`\langle z, w\rangle+1`],
    [String.raw`\pair {y}`, String.raw`\langle x, y\rangle`],
    [String.raw`\abs{\pair{y}}`, String.raw`\lvert \langle x, y\rangle\rvert`],
    [String.raw`\second{A}{B}C`, 'BC'],
    [String.raw`\phi\eps`, String.raw`\varphi\varepsilon`],
    [String.raw`\inner{a}{b}`, '(a|b)'],
    [String.raw`\pr(a,b)`, String.raw`P(a\mid b)`],
    [String.raw`\Hom(A,B)`, String.raw`\operatorname{Hom}(A,B)`],
    [String.raw`\argmax_x f`, String.raw`\operatorname*{arg\,max}_x f`],
    [String.raw`\RR^n`, String.raw`\mathbb{R}^n`],
  ];
  for (const [use, hand] of cases) {
    const { html } = realMath(MACRO_PREAMBLE + `\\begin{document}$${use}$\\end{document}`);
    assert.ok(html.includes(handMath(hand)), `${use} should render as ${hand}`);
  }
});

test('user macros in text: defaults, math bodies and delimited \\def', () => {
  const { html, warnings } = realMath(MACRO_PREAMBLE + String.raw`\begin{document}
\name, \name[You]; \R, \RR, \eps, \abs{t}, \pair{y}, \Hom; \pr(a,b); file\_name.
\end{document}`);
  const t = text(html.replace(/<span class="katex">[^]*?<\/math>/g, ''));
  assert.match(t, /Hello World, Hello You;/);
  assert.match(t, /file_name\./);
  const hands = [String.raw`\mathbb{R}`, String.raw`\varepsilon`, String.raw`\lvert t\rvert`, String.raw`\langle x, y\rangle`, String.raw`\operatorname{Hom}`, String.raw`P(a\mid b)`];
  for (const hand of hands) assert.ok(html.includes(handMath(hand)), `text should contain ${hand}`);
  assert.deepEqual(warnings, []);
});

test('\\renewcommand of \\thesection changes numbers and references', () => {
  const t = text(plain(String.raw`\renewcommand{\thesection}{\Roman{section}}
\newtheorem{thm}{Theorem}[section]
\begin{document}
\section{A}\label{s}
\section{B}
\begin{thm}\label{t} x \end{thm}
See \ref{s} and \ref{t}.
\end{document}`).html);
  assert.match(t, /Theorem II\.1\. x/);
  assert.match(t, /See I and II\.1\./);
});

test('text formatting, footnotes, quotes and dashes', () => {
  const { html } = plain("\\textbf{b} \\emph{e} ``q'' a--b a---b x\\footnote{note} 50\\% \\'e");
  assert.ok(html.includes('<strong>b</strong>'));
  assert.ok(html.includes('<em>e</em>'));
  assert.ok(html.includes('“q”'));
  assert.ok(html.includes('a–b') && html.includes('a—b'));
  assert.ok(html.includes('id="fn-1">note'));
  assert.ok(html.includes('50%'));
  assert.ok(html.includes('é'));
});

test('comments are stripped but \\% is kept', () => {
  const t = text(plain('a % hidden\nb 5\\% c').html);
  assert.ok(!t.includes('hidden'));
  assert.ok(t.includes('5% c'));
});

test('HTML in the source is escaped', () => {
  const { html } = plain('<script>alert(1)</script> \\href{javascript:alert(1)}{x}');
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('javascript:'));
});

test('bibliography and citations', () => {
  const t = text(plain(String.raw`\cite{b,a} \cite[Thm.~2]{a}
\begin{thebibliography}{9}\bibitem{a} Alpha.\bibitem{b} Beta.\end{thebibliography}`).html);
  assert.match(t, /\[2, 1\] \[1, Thm\. 2\]/);
});

test('figures and tables get numbered captions', () => {
  const t = text(plain(String.raw`\begin{figure}\caption{F}\label{f}\end{figure}\begin{table}\caption{T}\label{t}\end{table}\ref{f}/\ref{t}`).html);
  assert.match(t, /Figure 1\. F/);
  assert.match(t, /Table 1\. T/);
  assert.match(t, /1\/1/);
});

test('the sample document renders with KaTeX without warnings', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'examples', 'sample.tex'), 'utf8');
  const errors = [];
  const r = TeXglass.render(src, {
    renderMath: (tex, displayMode, macros) => {
      try {
        return katex.renderToString(tex, { displayMode, macros, throwOnError: true, strict: 'ignore' });
      } catch (e) {
        errors.push(`${e.message} in ${tex}`);
        return '';
      }
    },
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(r.warnings, []);
  assert.match(text(r.html), /Theorem 2\.1 \(Hölder\)/);
  assert.match(text(r.html), /\(2\.1\)/);
});

test('sourceMap marks each top-level block with its range in the original source', () => {
  const src = '\\begin{document}\n\\section{Intro}\nSome text % a comment\nmore text.\n\n\\begin{theorem}\\label{t}$x$\\end{theorem}\n\n$$y$$\n\\end{document}\n';
  const r = TeXglass.render(src, { sourceMap: true, renderMath: () => 'M' });
  const spans = Array.from(r.html.matchAll(/data-s="(\d+)" data-e="(\d+)"/g)).map((m) => src.slice(+m[1], +m[2]));
  assert.deepEqual(spans, [
    '\\section{Intro}',
    'Some text % a comment\nmore text.',
    '\\begin{theorem}\\label{t}$x$\\end{theorem}',
    '$$y$$',
  ]);
  assert.ok(!plain(src).html.includes('data-s'), 'off by default');
});

test('mathtools paired delimiters, \\mathbbm, \\hdots, \\intertext and \\tag macros', () => {
  const real = (src) =>
    TeXglass.render(src, {
      renderMath: (tex, displayMode, macros) => katex.renderToString(tex, { displayMode, macros, throwOnError: true, strict: 'ignore' }),
    });
  const warn = console.warn;
  console.warn = () => {}; // KaTeX has no metrics for the 𝟙 glyph
  let html;
  try {
    ({ html } = real(String.raw`
\DeclarePairedDelimiter{\norm}{\lVert}{\rVert}
\DeclarePairedDelimiter\abs\lvert\rvert
\DeclarePairedDelimiterX{\inp}[2]{\langle}{\rangle}{#1, #2}
\DeclarePairedDelimiterX\set[1]\lbrace\rbrace{\def\given{\;\delimsize\vert\;} #1}
\newcommand*{\Gtag}[1]{\tag{G$#1$}}
\begin{document}
$\norm{x}_p + \norm*{\frac ab} + \norm[\Big]{y} + \abs{z} + \inp{u}{v} + \set*{x \given x>0} + \mathbbm{1}_A + 1,\hdots,n$
\begin{align}
a &= b \label{e1}\\\shortintertext{and}
c &= d \label{e2}
\end{align}
\begin{equation}\Gtag{1} X = 1\end{equation}
\eqref{e1} \eqref{e2}
\end{document}`));
  } finally {
    console.warn = warn;
  }
  assert.doesNotMatch(html, /cc0000|katex-error/);
  assert.match(html, /𝟙/);
  assert.match(html, /<p class="intertext">and<\/p>/);
  const t = text(html);
  assert.match(t, /\(1\)\s*\(2\)/);
});

test('\\hyperref, \\hyperlink and \\hypertarget make links', () => {
  const { html, warnings } = plain(String.raw`\begin{enumerate}\item\label{ass.sewing.R} a\end{enumerate}
See \hyperref[ass.sewing.R]{(R)}, \hyperref[nope]{X}, \hyperlink{t}{go}, \hypertarget{t}{here} and \hyperref{http://a.b/c}{sec}{2}{ext}.`);
  assert.match(html, /<a class="ref" href="#item-1" data-label="ass.sewing.R">\(R\)<\/a>/);
  assert.match(html, /<span class="ref-missing" title="Undefined label: nope">X<\/span>/);
  assert.match(html, /<a class="ref" href="#ht-t">go<\/a>/);
  assert.match(html, /<span id="ht-t">here<\/span>/);
  assert.match(html, /<a class="href" href="http:\/\/a\.b\/c#sec\.2">ext<\/a>/);
  assert.deepEqual(warnings, ['Undefined reference "nope".']);
});

test('each formula carries its LaTeX as written, for click-to-copy', () => {
  const { html } = plain(String.raw`\newcommand{\R}{\mathbb{R}}
\begin{document}
Let $x \in \R$ and \(a<b\).
\begin{equation}\label{eq:one} e^{i\pi} + 1 = 0 \end{equation}
\begin{align}
  a &= b \label{eq:a} \\
  c &= d \nonumber
\end{align}
\[ f(x) = "q" \]
See \eqref{eq:one}.
\end{document}`);
  const tex = Array.from(html.matchAll(/class="math [^"]*"(?: id="[^"]*")? data-tex="([^"]*)"/g), (m) =>
    m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  assert.deepEqual(tex, [
    String.raw`x \in \R`,
    'a<b',
    String.raw`e^{i\pi} + 1 = 0`,
    String.raw`\begin{align}
  a &= b  \\
  c &= d
\end{align}`,
    'f(x) = "q"',
  ]);
});

test('mhequ: equ and equs are display math, numbered when labelled', () => {
  const { html } = plain(String.raw`\begin{document}
\begin{equ}[e:one]
a = b
\end{equ}
\begin{equ}
c = d
\end{equ}
\begin{equs}[e:block]
x &= y \\ \nonumber
z &= w
\end{equs}
\begin{equs}
p &= q \label{e:row}\\
r &= s
\end{equs}
See \eqref{e:one}, \eqref{e:block} and \eqref{e:row}.
\end{document}`);
  const t = text(html).replace(/\s+/g, ' ');
  assert.match(t, /\[D:a = b \\tag\{1\}\]/);
  assert.match(t, /\[D:c = d\]/);
  assert.match(t, /\[D:\\begin\{aligned\} x &= y \\\\ z &= w \\end\{aligned\}\\tag\{2\}\]/);
  assert.match(t, /\[D:\\begin\{align\*\} p &= q \\tag\{3\} \\\\ r &= s \\end\{align\*\}\]/);
  assert.match(t, /See \(1\), \(2\) and \(3\)\./);
  assert.doesNotMatch(t, /e:one|e:block/);
});

test('\\definealphabet defines one macro per letter', () => {
  const { html } = plain(String.raw`\definealphabet{mc}{\mathcal}{A}{C}
\begin{document}$\mcB + \mcC$\end{document}`);
  assert.equal(html.includes('[I:\\mcB + \\mcC]'), true);
  const r = TeXglass.render(String.raw`\definealphabet{mc}{\mathcal}{A}{C}
\begin{document}$\mcB$\end{document}`, { renderMath: (t, d, m) => katex.renderToString(t, { macros: m, throwOnError: true }) });
  assert.match(r.html, /mathcal/);
});

test('tree symbols \\<name> from \\DeclareSymbol are drawn inside the formula', () => {
  const r = TeXglass.render(String.raw`\tikzset{bxi/.style={circle,fill=Cyan,draw=symbols,inner sep=0pt,minimum size=1.1mm}}
\tikzset{txi/.style={regular polygon,regular polygon sides=3,draw=symbols,minimum size=1.3mm}}
\makeatletter
\def\DeclareSymbol#1#2#3{\expandafter\gdef\csname MH@symb@#1\endcsname{\tikz[baseline=#2,scale=0.15,draw=symbols]{#3}}}
\def\<#1>{\csname MH@symb@#1\endcsname}
\makeatother
\DeclareSymbol{b0}{-3}{\node[bxi]{};}
\DeclareSymbol{t1}{0}{\draw (0,0) -- (0,1.5) node[txi] {};}
\begin{document}$\mathcal{H}_{\<b0>} + \<t1> + \<b0s> + \<nope>$\end{document}`, { renderMath: (t, d, m) => katex.renderToString(t, { displayMode: d, macros: m, throwOnError: true }) });
  assert.doesNotMatch(r.html, /math-error|katex-error/);
  const pics = Array.from(r.html.matchAll(/class="tg-diagram tg-tikz tg-tree"><span class="tikz-wrap" data-tikz="([^"]*)"/g), (m) => JSON.parse(m[1].replace(/&quot;/g, '"')));
  assert.equal(pics.length, 3);
  assert.equal(pics[0].nodes[0].fill, '#00aeef');
  assert.ok(Math.abs(pics[0].baseline + 3 / 28.4527) < 1e-3);
  assert.equal(pics[1].nodes[0].shape, 'poly');
  assert.equal(pics[1].nodes[0].sides, 3);
  assert.doesNotMatch(r.html, /color:#a5/);
  assert.match(r.html, /mathtt[^>]*>nope/);
});

test('a $ inside \\text{…} does not end inline math', () => {
  const { html } = plain(String.raw`\begin{document}Norm $|x|_s^{\text{\tiny $\wedge$}}$ here.\end{document}`);
  assert.match(text(html), /\[I:\|x\|_s\^\{\\text\{\\tiny \$\\wedge\$\}\}\] here\./);
});

const realKatex = (src) => TeXglass.render(src, {
  renderMath: (t, d, m) => katex.renderToString(t, { displayMode: d, macros: m, throwOnError: true, strict: 'ignore' }),
});

test('nicefrac, slashed, \\adjustlimits and \\mathpalette macros render', () => {
  const r = realKatex(String.raw`
\makeatletter
\newcommand*\tinydot{{\mathpalette\tinydot@{.5}}}
\newcommand*\tinydot@[2]{\mathbin{\vcenter{\hbox{\scalebox{#2}{$\m@th#1\bullet$}}}}}
\makeatother
\begin{document}
$s\in(\nicefrac12,1]$, $\sfrac{3}{4}$, $\nicefrac[\mathrm]{a}{b}$, $\slashed{\partial}\phi=\slashed A$,
$x_\tinydot$ and $f\tinydot g$.
\[ \adjustlimits\lim_{n\to\infty}\sup_{m\ge n} c_{m} \]
\end{document}`);
  assert.doesNotMatch(r.html, /math-error|katex-error/);
  assert.match(r.html, /∙/);
});

test('a triple-bar delimiter from \\DeclareMathDelimiter works in paired delimiters and \\left', () => {
  const r = realKatex(String.raw`
\DeclareFontEncoding{FMS}{}{}
\DeclareSymbolFont{fouriersymbols}{FMS}{fxyz}{m}{n}
\DeclareMathDelimiter{\tribar}{\mathord}{fouriersymbols}{152}{fourierlargesymbols}{147}
\DeclarePairedDelimiter{\tn}{\tribar}{\tribar}
\begin{document}
$\tn{u} + \tn*{\frac ab} + \tn[\Big]{v} + \left\tribar w \right\tribar + \tribar z\tribar + \vvvert y \vvvert$
\end{document}`);
  assert.doesNotMatch(r.html, /math-error|katex-error/);
  assert.equal(r.unknownCommands.length, 0);
  // KaTeX's MathML for \mathopen{a\mkern…b} nests <mspace/> in <mo>, which
  // the HTML parser does not close: it would swallow the rest of the page.
  assert.doesNotMatch(r.html, /<mo[^>]*>(?:(?!<\/mo>).)*<mspace/);
  assert.equal(plain(String.raw`\DeclareMathDelimiter{\tribar}{\mathord}{fouriersymbols}{152}{fourierlargesymbols}{147}\begin{document}$\left\tribar x\right\tribar$\end{document}`).html.match(/\\left\\vert/g).length, 3);
});

test('\\long\\def, \\cites and \\todo', () => {
  const { html, unknownCommands } = plain(String.raw`
\long\def\remark#1{\textbf{#1}}
\begin{document}
\remark{Hi} as in \cites{alpha,beta}. \todo[color=red]{fix} Done.
\end{document}`);
  const t = text(html);
  assert.match(t, /Hi as in \[alpha, beta\]\. fix Done\./);
  assert.match(html, /class="mnote mnote-todo" style="--note-c:red"/);
  assert.equal(unknownCommands.length, 0);
});

test('\\marginpar, \\marginnote and \\todo go to the margin; \\todo[inline] stays in the line', () => {
  const { html, unknownCommands } = plain(String.raw`\begin{document}
Text.\marginpar[left]{A note with $x$.} More\marginnote{Side}[2cm] and \todo{Fix} \todo[inline, color=blue]{Here} \todo[disable]{Gone} \reversemarginpar end.
\end{document}`);
  assert.equal((html.match(/class="mnote mnote-par"/g) || []).length, 2);
  assert.match(html, /<span class="mnote mnote-par"><span class="mnote-body">A note with <span class="math/);
  assert.doesNotMatch(html, /left/);
  assert.doesNotMatch(html, /2cm/);
  assert.match(html, /<span class="mnote mnote-todo"><span class="mnote-body">Fix<\/span><\/span>/);
  assert.match(html, /<span class="todo" style="--note-c:blue">Here<\/span>/);
  assert.doesNotMatch(html, /Gone/);
  assert.equal(unknownCommands.length, 0);
});

test('physics-package commands render like their written-out forms', () => {
  const cases = [
    [String.raw`\abs{x}`, String.raw`\left\lvert x \right\rvert`],
    [String.raw`\abs*{x}`, String.raw`\mathopen{\lvert}x\mathclose{\rvert}`],
    [String.raw`\abs\big{x}`, String.raw`\mathopen{\bigl\lvert}x\mathclose{\bigr\rvert}`],
    [String.raw`\norm{\frac{u}{2}}`, String.raw`\left\lVert \frac{u}{2} \right\rVert`],
    [String.raw`\qty(\frac ab)`, String.raw`\left( \frac ab \right)`],
    [String.raw`\qty[x]+\qty|y|+\qty{z}`, String.raw`\left[ x \right]+\left\lvert y \right\rvert+\left\{ z \right\}`],
    [String.raw`\order{h^2}`, String.raw`\mathcal{O}\left\{ h^2 \right\}`],
    [String.raw`\dv{f}{x}+\dv[2]{f}{t}+\dv{s}`, String.raw`\frac{\mathrm{d}{f}}{\mathrm{d}{x}}+\frac{\mathrm{d}^{2}{f}}{\mathrm{d}{t}^{2}}+\frac{\mathrm{d}}{\mathrm{d}{s}}`],
    [String.raw`\pdv{f}{x}{y}`, String.raw`\frac{\partial^{2} {f}}{\partial{x}\,\partial{y}}`],
    [String.raw`\int g\dd{x}`, String.raw`\int g\mathop{}\!\mathrm{d}{x}`],
    [String.raw`\expval{A}{\psi}`, String.raw`\left\langle \psi \middle\vert A \middle\vert \psi \right\rangle`],
    [String.raw`\mel{m}{B}{n}+\comm{P}{Q}`, String.raw`\left\langle m \middle\vert B \middle\vert n \right\rangle+\left[ P , Q \right]`],
    [String.raw`\eval{x^2}_0^1`, String.raw`\left. x^2 \right\rvert_0^1`],
    [String.raw`\tr\rho+\vb{v}+\vu{e}`, String.raw`\operatorname{tr}\rho+\mathbf{v}+\hat{\mathbf{e}}`],
  ];
  for (const [src, hand] of cases) {
    const r = realMath(String.raw`\begin{document}$` + src + String.raw`$\end{document}`);
    assert.doesNotMatch(r.html, /math-error|katex-error/, src);
    assert.ok(r.html.includes(handMath(hand)), src);
  }
});

test("a document's own \\abs and \\norm win over the physics-package ones", () => {
  const r = realMath(String.raw`\usepackage{mathtools}
\DeclarePairedDelimiter\norm{\lVert}{\rVert}
\newcommand{\abs}[1]{|#1|}
\begin{document}$\abs{x}+\norm{y}$\end{document}`);
  assert.ok(r.html.includes(handMath(String.raw`|x|+\mathopen{\lVert} y \mathclose{\rVert}`)));
});

test('ulem underlines, strike-outs and underlined \\emph', () => {
  const r = TeXglass.render(String.raw`\usepackage{ulem}
\begin{document}\uline{a} \uuline{b} \uwave{c} \sout{d} \xout{e} \dashuline{f} \dotuline{g} \emph{h} {\em i}\end{document}`);
  assert.match(r.html, /<u>a<\/u> <u class="uuline">b<\/u> <u class="uwave">c<\/u> <s>d<\/s> <s class="xout">e<\/s>/);
  assert.match(r.html, /<u class="dashuline">f<\/u> <u class="dotuline">g<\/u> <u>h<\/u> <u>i<\/u>/);
  const n = TeXglass.render(String.raw`\usepackage[normalem]{ulem}
\begin{document}\emph{h}\end{document}`);
  assert.match(n.html, /<em>h<\/em>/);
  const m = realMath(String.raw`\begin{document}$\text{\uline{a} and \uwave{b}}$\end{document}`);
  assert.doesNotMatch(m.html, /math-error|katex-error/);
});

test('amsart: each \\author adds an author to the title block', () => {
  const src = '\\documentclass{amsart}\n\\title{T}\n\\author{Ada Writer}\n\\address{Somewhere}\n\\author{Bo Reader}\n\\email{b@example.org}\n\\begin{document}\n\\maketitle\nText.\n\\end{document}';
  const html = TeXglass.render(src, { renderMath: (t) => t }).html;
  assert.match(html, /<span class="author">Ada Writer<\/span><span class="author">Bo Reader<\/span>/);
});

test('a macro that calls itself does not hang the renderer', () => {
  // \\let then \\def wrapping the old meaning, as package code does; calling
  // itself twice made the old renderer expand it 2^200 times.
  const src = '\\documentclass{article}\n\\def\\twice{a\\twice b\\twice c}\n\\def\\loop{\\loop}' +
    '\n\\begin{document}\nStart \\twice{} \\loop{} end.\n\\end{document}';
  const t = Date.now();
  const out = plain(src);
  assert.ok(Date.now() - t < 2000, 'renders quickly');
  assert.match(text(out.html), /Start a+/);
  assert.match(text(out.html), /end\./);
  assert.ok(out.warnings.some((w) => /expands without end/.test(w)));
});

test('a math-only check over many macros that use each other stays fast', () => {
  // Each \\mK uses the previous one twice: the math-only check used to walk every path.
  let defs = '\\def\\mA{x}\n';
  const names = 'ABCDEFGHIJKLMNOP';
  for (let k = 1; k < names.length; k++) defs += `\\def\\m${names[k]}{\\m${names[k - 1]}\\relax\\m${names[k - 1]}}\n`;
  const t = Date.now();
  plain(`\\documentclass{article}\n${defs}\\begin{document}\nHi \\mB.\n\\end{document}`);
  assert.ok(Date.now() - t < 2000, 'renders quickly');
});

test('KaTeX MathML with an empty element inside <mo> still closes it, so it cannot swallow the page', () => {
  // \mathrel{\rlap{…}\mkern2mu…} (a common "independent" symbol): KaTeX puts
  // <mspace/> inside <mo>, where the HTML parser reads it as an open element.
  const r = realKatex(String.raw`
\newcommand\indep{\protect\mathpalette{\protect\independenT}{\perp}}
\def\independenT#1#2{\mathrel{\rlap{$#1#2$}\mkern2mu{#1#2}}}
\begin{document}
$X \indep Y$ and $\mathrel{a\mkern2mu b}$.
\end{document}`);
  assert.doesNotMatch(r.html, /katex-error|math-error/);
  assert.doesNotMatch(r.html, /<mspace[^>]*\/>/);
  assert.match(r.html, /<mspace[^>]*><\/mspace>/);
});

test('\\let\\cmd\\@undefined forgets a command, and double angle brackets render', () => {
  const r = realKatex(String.raw`
\makeatletter
\let\llangle\@undefined
\let\rrangle\@undefined
\DeclareMathDelimiter{\llangle}{\mathopen}{MnLargeSymbols}{'164}{MnLargeSymbols}{'164}
\DeclareMathDelimiter{\rrangle}{\mathclose}{MnLargeSymbols}{'171}{MnLargeSymbols}{'171}
\makeatother
\begin{document}
$\llangle x \rrangle + \big\llangle y \bigr\rrangle_q + \left\llangle \frac ab \right\rrangle$
\end{document}`);
  assert.doesNotMatch(r.html, /katex-error|math-error/);
  const tex = plain(String.raw`\let\foo\undefined\begin{document}$\left\llangle a \right\rrangle$\end{document}`).html;
  assert.match(tex, /\\left\\langle\\mkern-4mu\\left\\langle a \\right\\rangle\\mkern-4mu\\right\\rangle/);
});

test('upgreek letters and \\talloblong render', () => {
  const r = realKatex(String.raw`\begin{document}$\uptau + \upalpha_{\Upgamma} + \talloblong x \talloblong_p$\end{document}`);
  assert.doesNotMatch(r.html, /katex-error|math-error/);
});

test('a label with commas in it is one label, while \\cref{a,b} still lists two', () => {
  const { html, warnings } = plain(String.raw`\begin{document}
\section{A}\label{sec:a}
\begin{equation}x\label{eq:x,y,z}\end{equation}
See \eqref{eq:x,y,z} and \cref{sec:a,eq:x,y,z}.
\end{document}`);
  assert.deepEqual(warnings.filter((w) => /Undefined reference/.test(w)), ['Undefined reference "eq:x".', 'Undefined reference "y".', 'Undefined reference "z".']);
  assert.match(text(html), /See \(1\) and/);
});

test('imsart / elsarticle front matter: title block, thanks notes, keywords; running heads dropped', () => {
  const { html, title } = plain(String.raw`\documentclass{imsart}
\startlocaldefs
\newcommand\R{\mathbb R}
\endlocaldefs
\begin{document}
\begin{frontmatter}
\title{A Study of Things}
\runtitle{Short Things}
\author{\fnms{Ada} \snm{Lovelace}\ead[label=e1]{ada@example.org}\thanksref{t1}}
\thankstext{t1}{Supported by a grant.}
\address{Somewhere \\ \printead{e1}}
\affiliation{Some University}
\author{\fnms{Alan} \snm{Turing}\corref{}}
\runauthor{A. Lovelace and A. Turing}
\begin{abstract}We study $\R$.\end{abstract}
\begin{keyword}[class=MSC]
\kwd[Primary ]{60H10}
\kwd{60G99}
\end{keyword}
\begin{keyword}
\kwd{first word}
\kwd{second}
\end{keyword}
\end{frontmatter}
\section{Intro}
Text.
\end{document}`);
  const t = text(html);
  assert.equal(title, 'A Study of Things');
  assert.match(html, /<h1 class="doc-title">A Study of Things<\/h1>/);
  assert.match(t, /Ada Lovelace1/);
  assert.match(t, /Alan Turing/);
  assert.match(t, /Supported by a grant\./);
  assert.match(t, /MSC subject classifications: Primary 60H10, 60G99/);
  assert.match(t, /Keywords: first word, second/);
  assert.doesNotMatch(t, /Short Things|A\. Lovelace and|Some University|ada@example|t1|TODAY/);
  assert.ok(html.indexOf('doc-title') < html.indexOf('abstract'), 'title before the abstract');

  // elsarticle: \fntext[key]{…} with \fnref, keywords split by \sep
  const els = text(plain(String.raw`\begin{document}\begin{frontmatter}
\title{T}\author{B. Name\fnref{f1}}\fntext[f1]{Note one.}
\begin{keyword} alpha \sep beta \end{keyword}
\end{frontmatter}\end{document}`).html);
  assert.match(els, /B\. Name1/);
  assert.match(els, /Note one\./);
  assert.match(els, /Keywords: alpha, beta/);
});

test('\\mbox in maths is a text box that may hold maths of its own; \\boldmath, \\mathds and \\lefteqn render', () => {
  const cases = [
    [String.raw`f(x)=1 \mbox{ if $x>0$, and } \mbox{0 otherwise}`, String.raw`f(x)=1 \text{ if $x>0$, and } \text{0 otherwise}`],
    [String.raw`x_{\mbox{\scriptsize max}}`, String.raw`x_{\text{\scriptsize max}}`],
    [String.raw`\mbox{\boldmath $v$}\cdot w`, String.raw`\text{$v$}\cdot w`],
    [String.raw`\mathds{1}_A`, String.raw`\mathbb{1}_A`],
    [String.raw`\lefteqn{a+b}`, String.raw`\mathrlap{\displaystyle a+b}`],
  ];
  for (const [src, hand] of cases) {
    const r = realMath(String.raw`\begin{document}$` + src + String.raw`$\end{document}`);
    assert.doesNotMatch(r.html, /math-error|katex-error/, src);
    assert.ok(r.html.includes(handMath(hand)), src);
  }
  // the $ inside the box does not end the formula around it
  const d = realMath(String.raw`\begin{document}\[ |x| = \mbox{$x$ for $x\ge 0$} \]\end{document}`);
  assert.doesNotMatch(d.html, /math-error|katex-error/);
  assert.equal((d.html.match(/class="katex-display"/g) || []).length, 1);
});

test('\\begin{document} inside a macro definition is not where the document starts; the macro is', () => {
  const r = plain(String.raw`\documentclass{article}
\newcommand{\bd}{\begin{document}}
\newcommand{\ed}{\end{document}}
\newcommand{\R}{\mathbb{R}}
\begin{document}
Hello $\R$.
\end{document}`);
  assert.match(text(r.html), /Hello \[I:\\R\]\./);
  // and a paper that only ever starts it through the macro
  const s = plain(String.raw`\def\bd{\begin{document}}
\title{T}
\bd
Body text.
\end{document}`);
  assert.match(text(s.html), /Body text\./);
  assert.doesNotMatch(text(s.html), /\\bd/);
});

test('a paper\'s own \\text made of \\mbox, and its own \\char, do not send KaTeX round in circles', () => {
  const r = realMath(String.raw`\newcommand{\text}[1]{\mbox{#1}}\def\char{{\rm char}}
\newcommand{\top}{\mbox{\footnotesize$\Lambda$}}\begin{document}$\top + \text{a} \neq b$\end{document}`);
  assert.doesNotMatch(r.html, /math-error|katex-error/);
});

test('enumitem labels with commands, nested braces, \\ref, ref=, start= and resume render cleanly', () => {
  const { html, warnings } = plain(String.raw`
\begin{theorem}\label{thm:x} Claim.\end{theorem}
\begin{enumerate}[wide,itemsep=2pt,label={\upshape(\ref{thm:x}\alph*)}]
\item\label{p1} first
\item second
\end{enumerate}
\begin{enumerate}[resume*]
\item\label{p3} third
\end{enumerate}
\begin{enumerate}[label=\textbf{Step \arabic*.}, ref=S\arabic*, start=4]
\item\label{s4} go
\end{enumerate}
\begin{enumerate}[label={\upshape(\roman*)}]
\item\label{r1} one
\item two
\end{enumerate}
\begin{enumerate}[resume]
\item\label{r3} three
\end{enumerate}
See \ref{p1}, \ref{p3}, \ref{s4}, \ref{r1}, \ref{r3}.`);
  const t = text(html);
  assert.doesNotMatch(t, /upshape|textbf|alph|roman/);
  assert.match(t, /\(1a\)\s*first/);
  assert.match(t, /\(1b\)\s*second/);
  assert.match(t, /\(1c\)\s*third/);
  assert.match(html, /<strong>Step 4\.<\/strong>/);
  assert.match(t, /\(i\)\s*one/);
  assert.match(t, /\(ii\)\s*two/);
  assert.match(t, /3\.\s*three/); // plain resume keeps the count, not the label
  assert.match(t, /See \(1a\), \(1c\), S4, \(i\), 3\./);
  assert.deepEqual(warnings, []);
});
