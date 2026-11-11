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
- **arXiv** imports a paper's LaTeX source: paste a link such as
  `https://arxiv.org/abs/2301.00001` (or just `2301.00001`, `arXiv:…`,
  `math/0211159`). TeXdown downloads the source from arxiv.org, picks the main
  file, inlines its `\input`/`\include` files and the `.bbl` bibliography, and
  shows PNG/JPEG figures. Pasting an arXiv link onto the page, or opening
  `index.html?arxiv=2301.00001`, does the same.
- **GitHub** opens a `.tex` file from a public GitHub repository: paste a link
  to the file, to a folder or to the whole repo (TeXdown then picks the file
  with `\documentclass`). Its `\input`/`\include` files, a committed `.bbl` and
  PNG/JPEG/SVG figures are fetched too. **Edit on GitHub** then opens the file
  on GitHub to make and commit changes. Pasting a GitHub link onto the page,
  or opening `index.html?gh=<GitHub link>`, does the same. For one click from
  any GitHub page, drag **Open in TeXdown** from the GitHub dialog to your
  bookmarks bar.
- **Preview / Edit / Split** switch modes (Ctrl+E toggles Edit). In Edit mode, click any
  paragraph, theorem, equation or heading to edit its LaTeX right there; the
  caret lands where you clicked. Everything else stays rendered, and numbering
  and references update as you type. Esc or a click outside finishes; ↑ and ↓
  at the edges of a block move to the neighbouring block. **Add text at the
  end** appends a new paragraph.
- In Preview and Edit, a **Contents** sidebar lists the sections (and the
  references). Click an entry to jump there; the section you are reading is
  highlighted as you scroll. The **Contents** button hides or shows it, and on
  a phone it opens as a drawer.
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
- In Split mode, **drag the divider** to resize the panes (arrow keys work
  when it is focused, double-click resets it). The size is remembered.
- The **sun/moon button** switches between light and dark; the choice is
  remembered, and until you pick one the page follows your system setting.
- Hover a reference to preview the theorem or equation it points to; click
  it to jump there.
- The status in the toolbar counts undefined references and duplicate labels.

## Converting to HTML from the command line

```sh
npx texdown paper.tex -o paper.html
```

## Preview in VS Code

The [`vscode/`](vscode) folder is a VS Code extension that shows the same
preview beside the editor, live as you type: **TeXdown: Open Preview to the
Side** (Ctrl+K V). It scrolls along with the editor (a button turns that off),
and Ctrl+click in the preview jumps to that spot in the source. See [vscode/README.md](vscode/README.md) to build
and install it.

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
