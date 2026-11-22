# TeXglass for arXiv

A browser extension (Manifest V3) for Chrome, Edge and Firefox that opens
arXiv papers in TeXglass (also from alphaXiv, HAL and ResearchGate), which
renders their LaTeX source as a readable page: math, numbered theorems and equations, working references.

- **Toolbar button**: on an arXiv page (`arxiv.org/abs/…`, `/pdf/…` or
  `/html/…`) it opens that paper. Anywhere else it opens the viewer with its
  arXiv search dialog.
- **Keyboard shortcut**: **Alt+Shift+K** does the same as the toolbar button.
  Change it at `chrome://extensions/shortcuts` (Edge:
  `edge://extensions/shortcuts`; Firefox: *Manage Extension Shortcuts* in the
  gear menu of `about:addons`). Inside the viewer, **Ctrl+K** (Cmd+K on a Mac)
  opens the arXiv dialog, as on the website.
- **Right-click menu**: *Open arXiv paper in TeXglass* on any link to an
  arXiv paper, on any site, and *View this paper in TeXglass* on arXiv pages.
- **Links on arxiv.org**: *View in TeXglass* under "Access Paper" on abstract
  pages, a *texglass* link beside pdf/html/other on listing pages, and a
  floating button on HTML papers.
- **Other sites**: a floating *View in TeXglass* button on paper pages of
  - **alphaXiv** (`alphaxiv.org/abs/…`, `/overview/…`), whose addresses carry
    the arXiv id;
  - **HAL** (`hal.science` and its portals such as `inria.hal.science`,
    `theses.hal.science`, `hal.archives-ouvertes.fr`, `hal.inrae.fr`): the
    extension asks the HAL API (`api.archives-ouvertes.fr`) for the arXiv id
    that HAL records for deposits that are also on arXiv;
  - **ResearchGate** (`researchgate.net/publication/…`): an arXiv DOI
    (`10.48550/arXiv.…`) in the page's metadata, or else a paper on arXiv
    with exactly the same title, found with arXiv's search API.

  When a HAL deposit has no arXiv id, its title is searched on arXiv too. The
  button appears only when the paper is found on arXiv, since TeXglass renders
  the LaTeX source that arXiv keeps. On these pages the toolbar button and the right-click
  menu open the same paper, or say on the page that none was found. A title
  search sends the page's title to arXiv and nothing else; titles shorter
  than three words are not searched.

- **Overleaf**: on a project page (`overleaf.com/project/…`) a *TeXglass* tab
  on the right edge, the toolbar button or **Alt+Shift+K** opens a live
  preview panel beside the editor. It shows the file open in Overleaf's
  editor and re-renders it as you type, including your collaborators' edits
  and when you switch files. It
  - **follows the editor**: the preview scrolls to what is at the top of the
    editor (turn *Follow* off to read on your own);
  - **marks** the paragraph that holds the cursor;
  - **moves the cursor** to what you click in the preview: a word or the
    start of a paragraph, or a formula with Ctrl/Cmd+click or a double-click;
    text from another file (an `\input` file, with *Files* loaded) opens that
    file in the editor first;
  - as in the VS Code preview: a plain **click on a formula copies its
    LaTeX**, **hovering a reference or citation previews** what it points to,
    and **sections and proofs fold** (click a heading or the arrow; *Proofs*
    folds or unfolds every proof);
  - has a **table of contents** (*Contents*, on the left or the right), **Navigate**: find (Ctrl+F) and go to
    (Ctrl+G: "Lemma 4.1", "(3.2)", "§2"), and a **light or dark theme** (the
    moon button; it follows your system until you choose). Scrolling the
    preview yourself or jumping with these holds it in place until the editor
    scrolls again;
  - has an adjustable **text width**: drag either edge of the text (the
    column stays centred), drag to the panel's edge to fill it, or
    double-click an edge to go back to the usual width; it is remembered;
  - with **Files**, downloads the project's zip from Overleaf (its own
    *Download as zip*, with your login) and pulls in the files the open file
    `\input`s, the main file's preamble when the open file is a chapter (for
    its macros), references from the project's `.bib` files, and PNG, JPEG
    and SVG figures. The open file is always live; the other files are a
    snapshot, refreshed with *Reload*.

  The panel only reads the project: the one thing it does to the editor is
  move the cursor when you click. Overleaf's PDF stays the final version.
  Drag the panel's left edge to resize it; the page narrows to make room.

  How it reads the editor: `overleaf-page.js` runs in the page itself (a
  `"world": "MAIN"` content script, hence Chrome 111 and Firefox 128 or
  later) and finds Overleaf's CodeMirror 6 editor through CodeMirror's own
  handle on its DOM (`.cm-content`), or through the
  `UNSTABLE_editor:extensions` event Overleaf sends for extensions, rather
  than through Overleaf's page layout. It sends the text to the panel
  (`overleaf.html`, in a frame) with `postMessage`. Self-hosted Overleaf
  servers are not covered: the extension asks for `overleaf.com` only.

- **Files on this computer**: right-click the toolbar button and choose
  *Open a .tex file from this computer…* to pick a `.tex` file or its whole
  folder (or drop either on the TeXglass page). A folder brings in the main
  file's `\input` files, local packages, bibliography and figures. In
  **Chrome and Edge** you can also open a `.tex` file in the browser itself
  (drag it onto a tab, or type its `file:///…` address): once you turn on
  *Allow access to file URLs* for the extension (`chrome://extensions` or
  `edge://extensions`, then *Details*), TeXglass shows it rendered instead of
  as plain text, reads the files it pulls in from beside it, and re-renders
  when you save any of them. The browser's Back button returns to the plain
  text; the options page can turn this off. (If the browser downloads a
  `.tex` file instead of showing it, which depends on how the computer
  registers `.tex` files, use the menu item.) Firefox never lets extensions
  read `file://` addresses, so there the menu item is the way.

The viewer downloads the source from `arxiv.org/src/<id>` (a gzipped tar
archive or a single gzipped `.tex` file), picks the main file, inlines its
`\input`/`\include` files and the authors' own `.sty` macros, builds the
bibliography from the `.bbl` (or else the `.bib` files), and shows PNG/JPEG
figures. This is the same code as the **Open** dialog of the web viewer.

By default papers open in a copy of the viewer bundled with the extension, so
nothing else needs to be online apart from arxiv.org. The extension's options
can switch to the TeXglass website instead (default
`https://texglass.js.org/`, which takes `?arxiv=<id>`).

## Install

The builds are zip files: `texglass-arxiv-chrome-<version>.zip` for Chrome and
Edge, `texglass-arxiv-firefox-<version>.zip` for Firefox.

**Chrome or Edge**

1. Unzip `texglass-arxiv-chrome-<version>.zip` to a folder you will keep (the
   browser loads it from there each time it starts).
2. Open `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode** (Edge: in the left sidebar).
4. Click **Load unpacked** and pick the unzipped folder, the one that holds
   `manifest.json`.
5. Optional: pin the ∑ button from the puzzle-piece menu so it stays in the
   toolbar.

To update, unzip the new version over the same folder and click the reload
arrow on the extension's card.

**Firefox**

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick the zip file itself (or
   `manifest.json` in the unzipped folder).

Firefox removes temporary add-ons when it quits. To keep it installed, the
zip has to be signed by Mozilla: upload it at
[addons.mozilla.org/developers](https://addons.mozilla.org/developers/) as
*On your own* (unlisted; signing is automatic and free) and install the
signed `.xpi` it returns. Firefox Developer Edition and Nightly can instead
set `xpinstall.signatures.required` to `false` in `about:config` and install
the zip directly.

## Build

```sh
npm install            # KaTeX, which is bundled into the extension
node browser/build.js  # writes browser/dist/{chrome,firefox}/ and the two zips
```

The extension's own files are in `browser/src/`; the build adds the web
viewer (`index.html`, `app.js`, `styles.css`, `src/*.js`) with KaTeX loaded
from the extension instead of the CDN, and writes a manifest for each browser.
Chrome and Edge run `background.js` as a service worker, Firefox as an event
page. `npm test` includes tests for the build and the background script.
