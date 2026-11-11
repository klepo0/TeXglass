# TeXdown Preview for VS Code

Preview LaTeX files beside the editor the way VS Code previews Markdown: math
rendered with [KaTeX](https://katex.org), and sections, equations and
theorem-like environments numbered the way LaTeX would number them, with
`\ref`, `\eqref` and `\cref` resolving to those numbers. No TeX installation
is needed, and the preview updates as you type, without saving.

## Use

- Open a `.tex` file and click the preview icon in the editor title bar, or run
  **TeXdown: Open Preview to the Side** (Ctrl+K V, Cmd+K V on a Mac).
  **TeXdown: Open Preview** opens it in the current editor group instead;
  it is also in the Explorer's right-click menu for `.tex` files.
- The preview follows the LaTeX file you are editing, and scrolls along with
  the editor (and the editor with the preview). The link button in the
  preview's title bar turns that off and on again (or **TeXdown: Toggle
  Scrolling with the Editor**, or the `texdown.scrollSync` setting).
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
  (**TeXdown: Toggle Light/Dark Preview**; the `texdown.previewTheme` setting
  can also be set back to `auto`, which follows VS Code's theme).
- Hover over a reference or citation to see what it points to; click it to go
  there. Links to web pages open in your browser.
- Figures (`\includegraphics`) are shown when a PNG, JPEG, SVG, GIF or WebP
  file with that name sits next to the document (`\graphicspath` is
  respected). PDF and EPS figures are shown only if a PNG of the same name
  exists.

Long documents are fine: a 350-page paper takes a few seconds to convert, and
the conversion runs in a background thread, so typing is never held up.

## Install

From a release `.vsix` file: in VS Code, open the Extensions view, click the
`…` menu, choose **Install from VSIX…**, and pick the file. Or run
`code --install-extension texdown-0.1.0.vsix`.

## Build

The extension uses the converter (`src/texdown.js`) and stylesheet
(`styles.css`) of the TeXdown web viewer in the parent folder; packaging
copies them into `shared/`.

```sh
cd vscode
npm install
npm run copy-shared   # also runs automatically before packaging
npm test
npx vsce package      # makes texdown-0.1.0.vsix
```

To try changes, open this folder in VS Code and press F5 (after
`npm run copy-shared`).
