<p align="center">
  <img src="docs/images/logo.svg" width="96" height="96" alt="TeXglass logo">
</p>

<h1 align="center">TeXglass</h1>

<p align="center">
  <b>Read LaTeX like a paper, not like code.</b><br>
  For mathematicians and scientists reading arXiv papers or writing LaTeX:
  the math rendered, theorems numbered, references live, diagrams drawn.
  Then the smart part: <b>What does this use?</b> lights up everything a theorem
  rests on, a <b>dependency map</b> shows how the results fit together, a
  <b>hypothesis checker</b> lists what a cited lemma needs, and <b>notation on
  hover</b> tells you what a symbol means. No TeX install, no compile step.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=klepo1.texglass"><img src="https://vsmarketplacebadges.dev/version-short/klepo1.texglass.svg" alt="VS Code Marketplace version"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=klepo1.texglass"><img src="https://vsmarketplacebadges.dev/installs-short/klepo1.texglass.svg" alt="VS Code Marketplace installs"></a>
  <a href="https://open-vsx.org/extension/klepo1/texglass"><img src="https://img.shields.io/open-vsx/dt/klepo1/texglass?label=Open%20VSX" alt="Open VSX downloads"></a>
  <a href="https://klepo0.github.io/TeXglass/dashboard/"><img src="https://img.shields.io/badge/render%20dashboard-nightly-2f6fb2" alt="Render dashboard"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial-555" alt="License: PolyForm Noncommercial 1.0.0"></a>
</p>

<p align="center">
  <a href="https://klepo0.github.io/TeXglass/?arxiv=2106.10340"><b>▶ Try it now</b></a>: <i>Rough stochastic differential equations</i> from arXiv, opened in the web viewer.
</p>

<p align="center">
  <img src="docs/images/tour.gif" width="820" alt="Scrolling a paper in the TeXglass web viewer: hovering a reference previews Lemma 1.3, Go to jumps to the Snake lemma, and the page switches to dark. Then VS Code: the preview switches to the handwritten notes look, ink on squared paper, and to chalk on a board in dark mode">
</p>

## Why TeXglass

- **Math that reflows.** Papers read like the published version, in light or
  dark, at any width, with every `\ref` a link you can hover.
- **See how a paper fits together.** A map of which lemma each theorem uses,
  "What does this use?" on any result, and a checklist of the hypotheses of
  each cited lemma.
- **Read anywhere, phones and tablets included.** Swipe-in panels, previews
  that open on a tap, notes written with Apple Pencil or a stylus, and a
  home-screen app that works offline.
- **Your notes go with you.** Highlights, margin notes, reading progress and
  your list of saved papers sync through your own GitHub gist, with no
  TeXglass server.
- **Works offline and stays private.** Save papers for a train or a plane and
  read them with no connection. Your files never leave your browser or editor.

## Get started

| | How | Best for |
| --- | --- | --- |
| **[Web viewer](https://klepo0.github.io/TeXglass/)** | Open the link. Search arXiv, paste an arXiv or GitHub link, or drop a `.tex` file. | Reading papers in any browser |
| **[VS Code extension](https://marketplace.visualstudio.com/items?itemName=klepo1.texglass)** | `ext install klepo1.texglass`, open a `.tex` file, press **Ctrl+K V**. Also on [Open VSX](https://open-vsx.org/extension/klepo1/texglass). | Writing LaTeX with a live preview |
| **[Home Screen app](docs/GUIDE.md#on-phones-and-tablets)** | On a phone or tablet, open the [web viewer](https://klepo0.github.io/TeXglass/), then Share → **Add to Home Screen** (iPhone, iPad) or **Install TeXglass as an app** in the **…** menu (Android). | Reading on the go, offline too |
| **[arXiv browser extension](browser/README.md)** | For **Chrome, Edge and Firefox**. Download the zips from the [latest release](https://github.com/klepo0/TeXglass/releases/latest) and follow the install steps. | One click from arXiv, alphaXiv, HAL, ResearchGate and Overleaf |

There is also a command line tool: `npx texglass paper.tex -o paper.html`
writes one standalone page.

## Features

Everything below is described in full, with every shortcut, command and
setting, in the **[TeXglass guide](docs/GUIDE.md)**.

### Read

- **Rendered like the paper**: KaTeX math, numbered theorems, equations and sections, BibTeX, biblatex and amsrefs bibliographies.
- **Diagrams drawn**: `tikz-cd`, `xymatrix` and TikZ pictures.
- **Hover previews** of references, footnotes, citations (with the cited paper's abstract) and cited theorems.
- **Go to** any theorem, equation or section by number, and **Back** to where you were after any jump.
- **Contents** that follows you, folding sections and proofs, search, zoom, light and dark.
- **Open anything**: arXiv search, GitHub repositories, OpenAI's math preprints, or local files and folders.

### Understand

- **Dependency map** of which results each theorem uses, read from the paper's own references; double-click a result to jump to it.
- **What does this use?** lights up everything a result rests on, or everything that uses it.
- **Hypothesis checker**: a cited lemma's hypotheses split out, each with a box to tick.
- **Notation on hover** and a **notation index** of the paper's macros and defined symbols.
- **Reading progress** per result and section, with **What should I read next?**

### Study

- **Highlights and margin notes** of your own, anchored to the text so they survive a revised version.
- **Handwritten notes look**: ink on squared paper, or chalk on a board in dark mode.
- **Write with a pen** in the margin on a tablet.
- **Show selected results** and **print** exactly that view.
- **Save for offline**: keep papers on your device and find them under **Saved papers**.
- **Sync** notes through a private GitHub gist, your browser's sync or VS Code Settings Sync.

### Write

- **Live preview in VS Code** as you type, without saving, across multi-file documents.
- **Scroll sync** both ways and **jump to source** from the preview.
- **Live preview beside Overleaf's editor** from the browser extension.
- **Edit in the web viewer** with in-place editing, a split view and LaTeX autocomplete.
- **Export** a standalone offline HTML page, or **print** to PDF laid out like a paper.

## A closer look

<table>
  <tr>
    <td width="50%"><img src="docs/images/map.png" alt="The larger dependency map of an arXiv paper: results grouped by section, with arrows from each result to the ones that use it and cited works as leaves"><br><sub>The <b>dependency map</b>: which result rests on which.</sub></td>
    <td width="50%"><img src="docs/images/hypotheses.png" alt="A preview of Lemma 1.1 cited in a proof, split into hypotheses with tick boxes and a conclusion; one hypothesis is flagged as not mentioned near the citation"><br><sub>The <b>hypothesis checker</b> in a reference preview.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/phone.png" alt="TeXglass on a phone: a compact toolbar, and a tap on a reference opens Theorem 5.1 in a sheet at the bottom with a Go there button"><br><sub>On a <b>phone</b>: a tap opens the preview as a sheet.</sub></td>
    <td width="50%"><img src="docs/images/vscode-dark.png" alt="The TeXglass preview beside a .tex file in VS Code"><br><sub>The <b>VS Code</b> preview beside the source.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/diagrams.png" alt="tikz-cd and xymatrix diagrams drawn in the preview"><br><sub><code>tikz-cd</code>, <code>xymatrix</code> and TikZ, drawn.</sub></td>
    <td width="50%"><img src="docs/images/goto.png" alt="The Go to bar listing lemmas by number"><br><sub><b>Go to</b> any theorem, equation or section by number.</sub></td>
  </tr>
</table>

## Reliability, privacy and offline use

- **Tested every night**: the [render dashboard](https://klepo0.github.io/TeXglass/dashboard/)
  opens about 200 arXiv papers across maths, physics and computer science and
  lists what broke.
- **Private**: your files and papers stay in your browser or editor. Citation
  previews ask DataCite and Crossref only when you hover, and can be switched
  off. The extensions and the command line count nothing; the public website
  counts visits with a cookieless counter. Details in the
  [guide](docs/GUIDE.md#offline-and-privacy).
- **Offline**: the VS Code extension and the command line work fully offline,
  and the web viewer does too after your first visit. Papers you **Save for
  offline** open without a connection.
- **What LaTeX it understands** is listed in the
  [guide](docs/GUIDE.md#what-latex-it-understands). Anything unknown is skipped
  gracefully.

## Contribute

Found a paper that renders badly? [Open an issue](https://github.com/klepo0/TeXglass/issues)
with its arXiv id. To work on the code, see [CONTRIBUTING.md](CONTRIBUTING.md);
`npm start` serves the web viewer at http://localhost:8000 and `npm test` runs
the tests.

## License

[PolyForm Noncommercial 1.0.0](LICENSE): free for any noncommercial use,
including personal use, research, teaching, and universities, charities and
other noncommercial organisations. Commercial use needs a separate license;
ask [@klepo0](https://github.com/klepo0) on GitHub or through an
[issue](https://github.com/klepo0/TeXglass/issues). Versions up to and
including 0.8.8 stay under the MIT license for anyone who got a copy of them.
Bundled third-party code, such as KaTeX and pdf.js, keeps its own license.
