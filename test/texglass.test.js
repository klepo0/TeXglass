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
