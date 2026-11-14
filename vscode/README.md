# TeXglass Preview for VS Code

Preview LaTeX files beside the editor the way VS Code previews Markdown: math
rendered with [KaTeX](https://katex.org), and sections, equations and
theorem-like environments numbered the way LaTeX would number them, with
`\ref`, `\eqref` and `\cref` resolving to those numbers. No TeX installation
is needed, and the preview updates as you type, without saving.

![The TeXglass preview beside a .tex file: numbered theorems and equations, scrolled to the same place as the editor](https://raw.githubusercontent.com/klepo0/TeXglass/main/docs/images/vscode-dark.png)

Hover a reference to see what it points to, and jump to a theorem by its number:

![Hovering a reference previews the lemma it points to](https://raw.githubusercontent.com/klepo0/TeXglass/main/docs/images/hover.png)

![Go to lists lemmas by their numbers](https://raw.githubusercontent.com/klepo0/TeXglass/main/docs/images/goto.png)

Commutative diagrams (`tikz-cd`, `xymatrix`) are drawn in the preview:

![tikz-cd and xymatrix diagrams in the preview](https://raw.githubusercontent.com/klepo0/TeXglass/main/docs/images/diagrams.png)

## Use

- Open a `.tex` file and click the preview icon in the editor title bar, or run
  **TeXglass: Open Preview to the Side** (Ctrl+K V, Cmd+K V on a Mac).
  **TeXglass: Open Preview** opens it in the current editor group instead;
  it is also in the Explorer's right-click menu for `.tex` files.
- The preview follows the LaTeX file you are editing, and scrolls along with
  the editor (and the editor with the preview). The link button in the
  preview's title bar turns that off and on again (or **TeXglass: Toggle
  Scrolling with the Editor**, or the `texglass.scrollSync` setting).
- **Ctrl+click** (Cmd+click on a Mac) anywhere in the preview, or
  double-click, to put the cursor at that spot in the source: on the word you
  clicked, or at the start of the formula.
- **Fold** sections and proofs with the arrow beside them, or by clicking a
  section heading or a folded proof. Folds are remembered.
- The buttons in the preview's title bar: **Contents** shows a sidebar of the
  sections that highlights the one you are reading (on a narrow preview it
  opens as a drawer); **Hide proofs** / **Show proofs** folds or unfolds every
  proof; the link button turns scrolling with the editor off and on; and the
  half-moon button switches the preview between **light and dark**
  (**TeXglass: Toggle Light/Dark Preview**; the `texglass.previewTheme` setting
  can also be set back to `auto`, which follows VS Code's theme).
- **Zoom** the document with Ctrl/Cmd + and − (Ctrl/Cmd 0 resets) or Ctrl +
  mouse wheel while the preview has focus, or **Zoom In / Zoom Out / Reset Zoom**
  in the preview's `…` menu. The level shows at the bottom left (click it to
  go back to 100%) and is remembered for the workspace.
- The **contents** can sit on the left or the right of the document: the
  button beside the word *Contents* switches sides, as does the
  `texglass.contentsPosition` setting.
- Hover over a reference or citation to see what it points to; click it to go
  there. Links to web pages open in your browser.
- **Find in the preview** (Ctrl+F or the search button in the title bar, with
  the preview focused): every match is highlighted, and Enter / Shift+Enter
  (or F3 / Shift+F3) go to the next and previous one. Formulas are not searched.
- **Go to a theorem, equation or section** (Ctrl+G with the preview focused,
  or **TeXglass: Go to Theorem, Equation or Section…**): type `Lemma 4.1`,
  `(3.2)`, `§2` or just `3.2` and press Enter. A kind (`lemma`) or a title
  lists those too.
- **Export to HTML** (**TeXglass: Export to HTML**, in the preview's `…` menu,
  the editor's `…` menu and the Explorer's right-click menu) saves the document
  as one standalone `.html` page, next to the `.tex` file unless you pick
  another place: math rendered, theorems and equations numbered and references
  linked as in the preview. Exporting a chapter exports the whole document.
  KaTeX's fonts go inside the page (about 350 KB) so it looks right offline;
  set `texglass.exportEmbedFonts` to `false` to load them from a CDN instead.
  Figures are linked relative to the page. Other extensions can call the
  command with the `.tex` file's URI and the output URI to skip the dialog.
- **Print / Save as PDF** (**TeXglass: Print / Save as PDF**, in the same
  menus) opens the document in your browser with its print dialog showing;
  pick "Save as PDF" there for a PDF. The printout looks like a paper: serif
  text in black on white, paper margins, all proofs and sections unfolded, no
  page break inside a theorem or a displayed equation, and links as text.
  (VS Code's preview panes cannot print themselves, so the page is written to
  a temporary folder first.) In vscode.dev and github.dev it prints the
  preview directly.
- **Documents in several files**: `\input`, `\include`, `\subfile` and
  `\import` files are pulled in, and edits in any of them show up live (even
  before saving), as do changes made on disk. `\includeonly` is respected.
  Previewing a chapter shows the whole document: TeXglass finds the main file
  from a `% !TEX root = main.tex` line, from `\documentclass[main]{subfiles}`,
  or by looking in the chapter's folder and the folders above it (up to the
  workspace folder) for the file that includes it, directly or through other
  files. Ctrl+click jumps into the right file.
- **Bibliographies**: `\bibliography{refs}` (BibTeX) and `\addbibresource` +
  `\printbibliography` (biblatex) are filled in from your `.bib` files, with
  only the entries you cite (or all, with `\nocite{*}`), sorted
  alphabetically, or in citation order for `unsrt`-like styles, with
  `[Sch12]`-style labels for `alpha` styles. If a `.bbl` from an earlier
  LaTeX run covers every citation, it is used as is.
- Commutative diagrams (`tikzcd`, `\xymatrix`) and simple `tikzpicture`s
  are drawn, and follow the light/dark theme.
- Figures (`\includegraphics`) are shown when a PNG, JPEG, SVG, GIF or WebP
  file with that name sits next to the document (`\graphicspath` is
  respected). PDF and EPS figures are shown only if a PNG of the same name
  exists.

Long documents are fine: a 350-page paper takes a few seconds to convert, and
the conversion runs in a background thread, so typing is never held up.

## In the browser: github.dev and vscode.dev

The extension also runs in VS Code for the Web. On any GitHub repository,
press `.` (or change `github.com` to `github.dev` in the address) to open it
in the browser, open a `.tex` file, and click the preview icon. Everything
above works there too, including `\input` files, `.bib` bibliographies and
figures read straight from the repository. Edit, then commit from the Source
Control view: nothing to install on your computer and no TeX needed.

github.dev installs extensions from the VS Code Marketplace, so the extension
has to be published there first (see **Publish** below). Then search for
"TeXglass" in the Extensions view of github.dev and click **Install**.

In the browser the conversion runs in the extension host (a background web
worker), not in a separate thread.

## Install

From a release `.vsix` file: in VS Code, open the Extensions view, click the
`…` menu, choose **Install from VSIX…**, and pick the file. Or run
`code --install-extension texglass-0.8.1.vsix`.

Upgrading from TeXdown Preview (0.2.0 and earlier): the extension was
renamed, so VS Code sees TeXglass Preview as a new extension. Uninstall
TeXdown Preview after installing it, or both previews will open on Ctrl+K V.
Your `texdown.scrollSync` and `texdown.previewTheme` settings are copied to
`texglass.scrollSync` and `texglass.previewTheme` the first time it runs, and
the old entries can then be deleted from settings.json. The commands are now
`texglass.*`, so update any keybindings that name `texdown.*` commands.

Upgrading from 0.7.0 and earlier: from 0.7.1 the publisher is `klepo1`, the
same as on the VS Code Marketplace, so the extension ID changed from
`klepo0.texglass` to `klepo1.texglass` and VS Code sees it as a new
extension. Install 0.7.1, then uninstall the old one (it shows the same name,
TeXglass Preview; check the ID in its details page), or both previews will
open on Ctrl+K V. Settings, commands and keybindings are unchanged: they use
the `texglass.*` names, which do not depend on the publisher.

## Build

The extension uses the converter (`src/texglass.js`) and stylesheet
(`styles.css`) of the TeXglass web viewer in the parent folder; packaging
copies them into `shared/`.

```sh
cd vscode
npm install
npm run copy-shared   # also runs automatically before packaging
npm test
npx vsce package      # makes texglass-0.8.1.vsix
```

To try changes, open this folder in VS Code and press F5 (after
`npm run copy-shared`).

The browser version is `dist/web.js`, one file bundled by
`npm run build-web` (esbuild; packaging runs it too). To try it in VS Code
for the Web, with the folder `test/fixtures/web` as a virtual workspace:

```sh
npm run build-web
npm run test-web      # opens VS Code in Chromium with the extension loaded
```

## Publish

Publishing on the [VS Code Marketplace](https://marketplace.visualstudio.com)
makes the extension installable from the Extensions view, in github.dev and
vscode.dev as well as on the desktop. Once:

1. Sign in at https://marketplace.visualstudio.com/manage with a Microsoft
   account and create the publisher `klepo1` (the `publisher` in
   `package.json`).
2. In Azure DevOps (https://dev.azure.com), create a personal access token
   with the **Marketplace → Manage** scope and **All accessible
   organizations**.
3. `npx vsce login klepo1` and paste the token.

Then, for each release, raise `version` in `package.json` and run
`npx vsce publish`.
