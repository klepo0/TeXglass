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
  <img src="docs/images/tour.gif" width="820" alt="Scrolling a paper in TeXglass: hovering a reference previews Lemma 1.3, Go to jumps to the Snake lemma, and the page switches to dark">
</p>

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
  cursor on that word.
- **Copy a formula's LaTeX** by clicking it (`texglass.clickToCopyMath` to
  turn it off).
- **Table of contents** sidebar that highlights the section you are reading,
  on the left or right (`texglass.contentsPosition`).
- **Search** the preview (Ctrl+F, F3 / Shift+F3 for next and previous).
- **Go to** a theorem, equation or section by number (Ctrl+G).
- **Hover previews** of references and citations; click to jump there.
- **Light and dark themes**, toggled from the title bar, or following VS Code
  (`texglass.previewTheme`).
- **Fold** sections and proofs; **Hide proofs** folds them all at once.
- **Zoom** with Ctrl +/−/0 or Ctrl + mouse wheel, remembered per workspace.
- **Multi-file documents**: `\input`, `\include`, `\subfile`, `\import`
  and `\includeonly`, live across files. Previewing a chapter shows the whole
  document (`% !TEX root`, subfiles, or the file that includes it).
- **Bibliographies** from your `.bib` files (BibTeX and biblatex), or an
  existing `.bbl`.
- **Figures** in PNG, JPEG, SVG, GIF or WebP, with `\graphicspath`.
- **Diagrams**: `tikz-cd`, `xymatrix` and simple TikZ, drawn.
- **Export to HTML**: one standalone page that works offline
  (`texglass.exportEmbedFonts`).
- **Print / Save as PDF**, laid out like a paper.
- **Fast on long papers**: conversion runs in a background thread.
- Works in **github.dev and vscode.dev**: press `.` on any GitHub repo,
  preview, edit, commit.

Prefer a file? Every [release](https://github.com/klepo0/TeXglass/releases)
has a `.vsix` (**Extensions: Install from VSIX…**). More in
[vscode/README.md](vscode/README.md).

## Web viewer

**[klepo0.github.io/TeXglass](https://klepo0.github.io/TeXglass/)**: open or
drop a `.tex` file, or paste an arXiv or GitHub link. Nothing to install.

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
- **arXiv import**: paste `2301.00001` or any arXiv link. Included files, the
  `.bbl` and figures come along. Also `?arxiv=2301.00001`.
- **GitHub import**: paste a link to a file, folder or repo of a public
  repository; the main file, included files, `.bbl` and figures are found for
  you. Also `?gh=<link>`, a bookmarklet, and **Edit on GitHub**.
- **OpenAI math preprints**: the **Preprints** button lists the manuscripts in
  [openai/math](https://github.com/openai/math), searchable and filtered by
  discipline; click one to read its LaTeX source. Also `?preprint=<folder>`.
- **Three modes**: **Preview**, **Edit** (click any paragraph, theorem or
  equation to edit its LaTeX in place, Ctrl+E) and **Split** (source beside
  preview, scrolling together, resizable divider, Ctrl+Shift+E).
- **Table of contents** sidebar that highlights the section you are reading,
  on either side, or as a drawer on a phone.
- **Search** the document (Ctrl+F, Enter / Shift+Enter or F3 / Shift+F3).
- **Go to** a theorem, equation, section, figure or table by number (Ctrl+G).
- **Hover previews** of references; click to jump there.
- **Click a formula** to copy its LaTeX (in Preview and Split; in Edit a click
  opens the block). Works in the arXiv extension too.
- **Light and dark themes**, following your system until you pick one.
- **Fold** sections and proofs; **Hide proofs** folds them all at once.
- **Zoom** the document (toolbar, Ctrl +/−/0, Ctrl + mouse wheel).
- **Editor**: LaTeX syntax colouring, autocomplete for commands, snippets,
  environments (your `\newtheorem`s too) and labels with their numbers,
  auto-closing math delimiters, and Tab to step out of brackets.
- **Save** back to the file (Ctrl+S) and **live reload** when the file changes
  on disk (Chrome and Edge).
- **Export** a standalone offline `.html` page.
- **Print** (Ctrl+P) as a clean paper-style PDF.
- **Status** counts undefined references and duplicate labels.
- **Fast on long papers**: conversion runs in a background worker.

Run it locally with `npm start` (http://localhost:8000). It is a static page
with no build step.

## arXiv browser extension

For **Chrome, Edge and Firefox**.

- **Toolbar button**: on an arXiv abstract, PDF or HTML page, opens that paper
  in TeXglass.
- **Right-click menu**: open any link to an arXiv paper, on any site.
- **Links on arxiv.org**: *View in TeXglass* on abstract pages, a *texglass*
  link in listings, and a floating button on HTML papers.
- **Self-contained**: papers open in a viewer bundled with the extension, so
  only arxiv.org needs to be reachable. The options can switch to the website.

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
  `multline`, `alignat`, `eqnarray`, with `\tag`, `\nonumber`, `\notag`.
- **Macros**: `\newcommand`, `\renewcommand`, `\def` (delimited parameters
  too), `\let`, `\DeclareMathOperator`, in math and text.
- **Theorems**: `\newtheorem` in all its forms, `\theoremstyle`, `proof` ∎.
- **Numbering and references**: sections, `\appendix`, `\numberwithin`,
  enumerate labels, figures, tables; `\ref`, `\eqref`, `\cref`, `\Cref`,
  `\autoref`, `\nameref`.
- **Structure**: `\maketitle`, abstract, lists, footnotes, `thebibliography`
  and `.bbl`, `tabular`, `verbatim`, links.
- **Diagrams**: `tikzcd` and `\xymatrix` (bends, shifts, 2-cells, arrow
  styles) and simple `tikzpicture`s. Heavier TikZ shows its source.

Anything unknown is skipped gracefully.

## Development

The converter is `src/texglass.js`, dependency-free and shared by the web
viewer, the CLI and the VS Code extension. Diagrams live in `src/tikz.js` and
`src/diagrams.js`, editing aids in `src/editor.js`, HTML export in
`src/export.js`. `npm test` runs the tests.

**Releasing**: bump `version` in `vscode/package.json`, merge, then push a
matching tag from main (`git tag v0.9.0 && git push origin v0.9.0`). The
[Release workflow](.github/workflows/release.yml) builds the `.vsix` and
browser zips, publishes a GitHub Release, and publishes to the VS Code
Marketplace (trusted publishing) and to Open VSX when `OVSX_PAT` is set.

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
