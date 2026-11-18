<p align="center">
  <img src="docs/images/logo.svg" width="96" height="96" alt="TeXglass logo">
</p>

<h1 align="center">TeXglass</h1>

<p align="center">
  <b>Read LaTeX like a paper, not like code.</b><br>
  A live preview for <code>.tex</code> files: KaTeX math, numbered theorems and equations, working references, and drawn diagrams. No TeX install, no compile step.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=klepo1.texglass"><b>VS Code extension</b></a> ·
  <a href="https://klepo0.github.io/TeXglass/"><b>Web viewer</b></a> ·
  <a href="https://github.com/klepo0/TeXglass/releases/latest"><b>arXiv browser extension</b></a>
</p>

<p align="center">
  <img src="docs/images/tour.gif" width="820" alt="Scrolling a paper in the TeXglass web viewer: hovering a reference previews Lemma 1.3, Go to jumps to the Snake lemma, and the page switches to dark. Then VS Code: the preview switches to the handwritten notes look, ink on squared paper, and to chalk on a board in dark mode">
</p>

## Key features

The same reader runs in the VS Code extension, the web viewer and the arXiv
browser extension:

- **Reads like the paper**: KaTeX math, numbered theorems, equations and
  sections, working `\ref`/`\eqref`/`\cref`, citations and bibliographies
  (BibTeX, biblatex and amsrefs).
- **Hover previews** of references and citations; click to jump there.
- **Go to** any theorem, equation or section by number (Ctrl+G).
- **Click a formula** to copy its LaTeX.
- **Contents sidebar** that follows where you are; **fold** sections and
  proofs, or **Hide proofs** all at once.
- **Diagrams drawn**: `tikz-cd`, `xymatrix` and simple TikZ.
- **Search** (Ctrl+F), **zoom**, and **light and dark themes**.
- **No TeX install, no compile step**, and fast on long papers.

## VS Code extension

![The TeXglass preview beside a .tex file in VS Code](docs/images/vscode-dark.png)

Install **TeXglass** from the
[Marketplace](https://marketplace.visualstudio.com/items?itemName=klepo1.texglass)
(`ext install klepo1.texglass`), open a `.tex` file and press **Ctrl+K V**.

- **Live preview** beside the editor (Ctrl+K V) or in place (**Open
  Preview**, also in the Explorer's right-click menu), updated as you type,
  without saving.
- **Scroll sync** both ways, with a title-bar button and the
  `texglass.scrollSync` setting to turn it off.
- **Jump to source**: Ctrl+click or double-click in the preview puts the
  cursor on that word; **Ctrl+K J** jumps the preview to the cursor.
- **Multi-file documents**: `\input`, `\include`, `\subfile`, `\import`
  and `\includeonly`, live across files. Previewing a chapter shows the whole
  document (`% !TEX root`, subfiles, or the file that includes it).
- **Bibliographies** from your `.bib` files (BibTeX and biblatex), an
  existing `.bbl`, or amsrefs records (`\begin{bibdiv}…\bib{key}{article}{…}`)
  in the document itself.
- **Figures** in PNG, JPEG, SVG, GIF or WebP, with `\graphicspath`.
- **Handwritten notes look** (optional): **TeXglass: Toggle Handwritten
  Notes Look** shows the document in ink on squared, lined or plain paper, or
  as chalk on a board in dark mode. Pick the hand, the pen (ballpoint,
  fountain pen or black) and whether formulas are handwritten too in the
  `texglass.notes.*` settings. Print and HTML export keep the look.
- **Export to HTML**: one standalone page that works offline
  (`texglass.exportEmbedFonts`).
- **Print / Save as PDF**, laid out like a paper.
- Works in **github.dev and vscode.dev**: press `.` on any GitHub repo,
  preview, edit, commit.

Prefer a file? Every [release](https://github.com/klepo0/TeXglass/releases)
has a `.vsix` (**Extensions: Install from VSIX…**). More in
[vscode/README.md](vscode/README.md).

## Web viewer

**[klepo0.github.io/TeXglass](https://klepo0.github.io/TeXglass/)**: open or
drop a `.tex` file, search arXiv, paste an arXiv or GitHub link, or browse OpenAI's math
preprints. Nothing to install, and after your first visit it opens and renders
offline too (arXiv, GitHub and Preprints still need a connection).

<table>
  <tr>
    <td width="50%"><img src="docs/images/hover.png" alt="Hovering a reference shows the lemma it points to"><br><sub>Hover a reference to preview what it points to.</sub></td>
    <td width="50%"><img src="docs/images/goto.png" alt="The Go to bar listing lemmas by number"><br><sub><b>Go to</b> any theorem, equation or section by number.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/diagrams.png" alt="tikz-cd and xymatrix diagrams drawn in the preview"><br><sub><code>tikz-cd</code>, <code>xymatrix</code> and simple TikZ, drawn.</sub></td>
    <td width="50%"><img src="docs/images/overview-dark.png" alt="Numbered definitions, lemmas and equations in the dark theme"><br><sub>Light and dark themes.</sub></td>
  </tr>
</table>

- **Open** a file (Ctrl+O) or drag it onto the page.
- **arXiv search and import**: type words, a title or an author in the arXiv
  dialog to search arXiv (through [DataCite](https://datacite.org), which holds
  every arXiv DOI, with OpenAlex and Semantic Scholar as fallbacks, since
  arXiv's own search API can't be called from a web page), then click a result
  to open it. Or paste `2301.00001` or any arXiv link. **Ctrl+K** (Cmd+K on a
  Mac) opens the dialog. Included files, the authors' own `.sty` macros, the
  bibliography (from the `.bbl`, BibTeX's or biber's, or else from the `.bib`
  files) and figures come along. Also `?arxiv=2301.00001`.
- **GitHub import**: paste a link to a file, folder or repo of a public
  repository; the main file, included files, `.bbl` or `.bib` and figures are found for
  you. Also `?gh=<link>`, a bookmarklet, and **Edit on GitHub**.
- **OpenAI math preprints**: the **Preprints** button lists the manuscripts in
  [openai/math](https://github.com/openai/math), searchable and filtered by
  discipline; click one to read its LaTeX source. Also `?preprint=<folder>`.
- **Three modes**: **Preview**, **Edit** (click any paragraph, theorem or
  equation to edit its LaTeX in place, Ctrl+E) and **Split** (source beside
  preview, scrolling together, resizable divider, Ctrl+Shift+E).
- **Editor**: LaTeX syntax colouring, autocomplete for commands, snippets,
  environments (your `\newtheorem`s too) and labels with their numbers,
  auto-closing math delimiters, and Tab to step out of brackets.
- **Save** back to the file (Ctrl+S) and **live reload** when the file changes
  on disk (Chrome and Edge).
- **Export** a standalone offline `.html` page.
- **Print** (Ctrl+P) as a clean paper-style PDF.
- **Status** counts undefined references and duplicate labels.

Run it locally with `npm start` (http://localhost:8000). It is a static page
with no build step.

## arXiv browser extension

For **Chrome, Edge and Firefox** (Chrome/Edge 111 or later, Firefox 128 or later).

- **Toolbar button**, or **Alt+Shift+K**: on an arXiv abstract, PDF or HTML
  page, opens that paper in TeXglass; anywhere else, TeXglass with its arXiv
  search.
- **Right-click menu**: open any link to an arXiv paper, on any site.
- **Links on arxiv.org**: *View in TeXglass* on abstract pages, a *texglass*
  link in listings, and a floating button on HTML papers.
- **alphaXiv, HAL and ResearchGate**: a *View in TeXglass* button on paper
  pages whose paper is also on arXiv (HAL's own records, or an exact title
  match on arXiv).
- **Live preview on Overleaf**: a TeXglass panel beside Overleaf's editor
  that re-renders the open file as you (or your collaborators) type, scrolls
  along with the editor, and moves the cursor to whatever you click. It only
  reads the document; Overleaf's PDF stays the final version.
- **Self-contained**: papers open in a viewer bundled with the extension, so
  only arxiv.org needs to be reachable. The options can switch to the website.
- **Everything above**: hover previews, Go to, contents, click to copy and
  themes work on every paper.

Grab the zips from the latest
[release](https://github.com/klepo0/TeXglass/releases/latest); install steps
are in [browser/README.md](browser/README.md).

## Command line

```sh
npx texglass paper.tex -o paper.html
```

Same standalone page as **Export**. Add `--link-katex` to load KaTeX fonts
from a CDN instead of embedding them (~350 KB).

## What it understands

- **Math**: `$…$`, `\(…\)`, `\[…\]`, `equation`, `align`, `gather`,
  `multline`, `alignat`, `eqnarray`, mhequ's `equ` and `equs`, with `\tag`,
  `\nonumber`, `\notag`.
- **Macros**: `\newcommand`, `\renewcommand`, `\def` (delimited parameters
  too), `\let`, `\DeclareMathOperator`, in math and text, and those in a
  paper's own `.sty` files when imported from arXiv.
- **Theorems**: `\newtheorem` in all its forms, `\theoremstyle`, `proof` ∎.
- **Numbering and references**: sections, `\appendix`, `\numberwithin`,
  enumerate labels, figures, tables; `\ref`, `\eqref`, `\cref`, `\Cref`,
  `\autoref`, `\nameref`.
- **Structure**: `\maketitle`, abstract, lists, footnotes, `tabular`,
  `verbatim`, links.
- **Bibliographies**: `thebibliography`, `.bbl` (BibTeX or biber), `.bib`
  files (BibTeX and biblatex) and amsrefs records.
- **Diagrams**: `tikzcd` and `\xymatrix` (bends, shifts, 2-cells, arrow
  styles) and `tikzpicture`s, including `\clip`, hatching patterns, braces,
  pictures inside nodes, macros that hold paths, and `\resizebox` to the
  column width (pictures wider than the column shrink to fit). Tree symbols declared with
  `\DeclareSymbol` (as in regularity structures papers) are drawn inside
  formulas. Heavier TikZ shows its source.

Anything unknown is skipped gracefully.

## Development

The converter is `src/texglass.js`, dependency-free and shared by the web
viewer, the CLI and the VS Code extension. Diagrams live in `src/tikz.js` and
`src/diagrams.js`, editing aids in `src/editor.js`, HTML export in
`src/export.js`. `npm test` runs the tests.

TeXglass was called TeXdown until November 2026; settings carry over.

## License

TeXglass is licensed under the
[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0).
See [LICENSE](LICENSE). You can use, change and share it for any
noncommercial purpose: personal use, research, teaching, and use by
universities, charities and other noncommercial organisations.

Commercial use needs a separate license. To ask about one, contact the
author, [@klepo0](https://github.com/klepo0), on GitHub or through an
[issue](https://github.com/klepo0/TeXglass/issues).

The license changed from MIT to PolyForm Noncommercial in November 2026,
from the release after 0.8.8. Versions up to and including 0.8.8 stay
under the MIT license for anyone who got a copy of them.

Bundled third-party code, such as KaTeX, keeps its own license.
