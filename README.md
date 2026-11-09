# TeXdown

A viewer for LaTeX files that works like a Markdown preview. Open a `.tex`
file and read it as a nicely typeset page: math is rendered with
[KaTeX](https://katex.org), and sections, equations and theorem-like
environments are numbered the way LaTeX would number them, with `\ref`,
`\eqref` and `\cref` resolving to those numbers.

## Using the viewer

It is a static web page with no build step.

```sh
npm install   # only needed for the tests and the CLI
npm start     # serves the viewer at http://localhost:8000
```

Any static file server works too (`python3 -m http.server`), and the page can
be hosted on GitHub Pages as is. Then:

- **Open .tex** (or Ctrl+O), or drag a file onto the page.
- In Chrome and Edge, an opened file is **watched**: save it in your editor and
  the preview updates within a second.
- **Edit source** (Ctrl+E) shows the source next to the preview, with live
  re-rendering as you type.
- Hover a reference to preview the theorem or equation it points to; click
  it to jump there.
- The status in the toolbar counts undefined references and duplicate labels.

## Converting to HTML from the command line

```sh
npx texdown paper.tex -o paper.html
```

## What is supported

- **Math**: `$…$`, `\(…\)`, `$$…$$`, `\[…\]`, and `equation`, `align`,
  `gather`, `multline`, `alignat`, `eqnarray` (starred or not). Each
  numbered row gets its own number; `\nonumber`, `\notag` and `\tag` work.
  `\newcommand`, `\def` and `\DeclareMathOperator` macros are passed to KaTeX.
- **Theorems**: `\newtheorem{name}{Title}`, `\newtheorem{name}[shared]{Title}`,
  `\newtheorem{name}{Title}[section]`, `\newtheorem*`, and `\theoremstyle`
  (`plain`, `definition`, `remark`). Common environments (`theorem`, `lemma`,
  `definition`, …) work even without a declaration. `proof` gets a ∎.
- **Numbering and references**: sections (with `\appendix`), equations
  (`\numberwithin`), theorems, enumerate items (including enumitem
  `label=(\roman*)`), figures and tables. `\label` with `\ref`, `\eqref`,
  `\cref`, `\Cref`, `\autoref`, `\nameref`; forward references work.
- **Document structure**: `\maketitle`, `abstract`, `\tableofcontents`,
  `itemize`/`enumerate`/`description`, footnotes, `thebibliography` with
  `\cite`, `tabular`, `verbatim`, `\verb`, `\url`/`\href`, text styles,
  accents and TeX ligatures (``` `` ''```, `--`, `---`, `~`).

Anything unknown is skipped gracefully: the command disappears and its
arguments are shown. Pictures (`\includegraphics`, TikZ) show a placeholder in
the browser, since the page cannot read files next to the `.tex` file.

## Development

The converter is `src/texdown.js`, a dependency-free module that works in the
browser and in Node. `npm test` runs the test suite.
