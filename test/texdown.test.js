'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const katex = require('katex');
const TeXdown = require('../src/texdown.js');

// Render math as a readable marker so tests can see exactly what KaTeX would get.
const plain = (src) => TeXdown.render(src, { renderMath: (t, d) => `[${d ? 'D' : 'I'}:${t.trim()}]`, today: 'TODAY' });
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
  const r = TeXdown.render(String.raw`\newcommand{\R}{\mathbb{R}}\newcommand{\ie}{i.e.}\DeclareMathOperator{\Hom}{Hom} $\R \Hom$ \ie`, {
    renderMath: (t, d, macros) => { seen = macros; return 'M'; },
  });
  assert.equal(seen['\\R'], '\\mathbb{R}');
  assert.equal(seen['\\Hom'], '\\operatorname{Hom}');
  assert.match(text(r.html), /M i\.e\./);
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
  const r = TeXdown.render(src, {
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
