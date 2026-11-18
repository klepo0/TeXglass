# TeXglass for arXiv

A browser extension (Manifest V3) for Chrome, Edge and Firefox that opens
arXiv papers in TeXglass (also from alphaXiv, HAL and ResearchGate), which
renders their LaTeX source as a readable page: math, numbered theorems and equations, working references.

- **Toolbar button**: on an arXiv page (`arxiv.org/abs/…`, `/pdf/…` or
  `/html/…`) it opens that paper. Anywhere else it opens the viewer.
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

The viewer downloads the source from `arxiv.org/src/<id>` (a gzipped tar
archive or a single gzipped `.tex` file), picks the main file, inlines its
`\input`/`\include` files and the `.bbl` bibliography, and shows PNG/JPEG
figures. This is the same code as the **arXiv** button of the web viewer.

By default papers open in a copy of the viewer bundled with the extension, so
nothing else needs to be online apart from arxiv.org. The extension's options
can switch to the TeXglass website instead (default
`https://klepo0.github.io/TeXglass/`, which takes `?arxiv=<id>`).

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
