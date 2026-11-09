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

- **Open** (or Ctrl+O), or drag a file onto the page.
- **Preview / Edit / Split** switch modes (Ctrl+E toggles Edit). In Edit mode, click any
  paragraph, theorem, equation or heading to edit its LaTeX right there; the
  caret lands where you clicked. Everything else stays rendered, and numbering
  and references update as you type. Esc or a click outside finishes; ↑ and ↓
  at the edges of a block move to the neighbouring block. **Add text at the
  end** appends a new paragraph.
- **Fold** sections and proofs with the arrow beside them (or click a section
  heading or a folded proof in Preview mode). **Hide proofs** folds every
  proof at once to its first line. Folds are remembered, and following a
  reference into folded content unfolds it.
- Both editors have **LaTeX syntax colouring** and **autocomplete**: type `\`
  for commands and snippets (`\frac`, `\sum`, `\int`, `\section`, `thm`,
  `lem`, `eqn`, `cases`, `pmatrix`, `figure`, …), `\begin{` for
  environments (including your own `\newtheorem`s), and `\ref{`/`\eqref{`/
  `\cref{` for your labels with their numbers. Tab or Enter accepts, Tab then
  jumps between the snippet's fields, Ctrl+Space opens the list.
- Math delimiters close themselves: typing `$`, `$$`, `\(` or `\[` adds the
  closing `$`, `$$`, `\)` or `\]` with the cursor inside, typing the closing
  delimiter steps over it, Backspace on an empty pair removes both, and
  typing `$` with text selected wraps it in `$…$`.
- **Tab out**: with the cursor right before a closing `$`, `$$`, `\)`, `\]`,
  `}`, `)` or `]`, Tab jumps past it (after any snippet fields are done).
- **Save** (Ctrl+S) writes back to the opened file in Chrome and Edge, and
  downloads a copy elsewhere.
- In Chrome and Edge, an opened file is **watched**: save it in your editor and
  the preview updates within a second (unless you have unsaved edits here).
- **Split** (Ctrl+Shift+E) shows the source and the preview side by side.
  They scroll together: scroll either one and the other follows to the same
  place. Typing re-renders live, and clicking a block in the preview puts the
  cursor at its source.
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

The editing aids are in `src/editor.js`. The converter is `src/texdown.js`, a dependency-free module that works in the
browser and in Node. With `{ sourceMap: true }` it wraps each top-level block
in `<div class="src-block" data-s data-e>` giving its range in the source,
which is what Edit mode uses. `npm test` runs the test suite.
