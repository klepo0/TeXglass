# TeXglass guide

Everything TeXglass does, where to find it, and every keyboard shortcut.

TeXglass runs in four places that share one reader:

| Where | What it is |
| --- | --- |
| [Web viewer](#web-viewer) | [klepo0.github.io/TeXglass](https://klepo0.github.io/TeXglass/): open a `.tex` file, an arXiv paper or a GitHub repository in the browser. |
| [Browser extension](#browser-extension) | Chrome, Edge and Firefox: open arXiv, alphaXiv, HAL and ResearchGate papers in TeXglass, and a live preview beside Overleaf's editor. |
| [VS Code extension](#vs-code-extension) | A live preview beside your `.tex` file, with jump to source and notes saved beside the file. |
| [Command line](#command-line) | `npx texglass paper.tex -o paper.html` makes a standalone page. |

Most features below work in all of them. Where one is missing somewhere, the
section says so. On a Mac, read <kbd>Cmd</kbd> for <kbd>Ctrl</kbd> throughout.

**Contents**

- [Keyboard shortcuts](#keyboard-shortcuts)
- [Reading a paper](#reading-a-paper)
- [Previews on hover](#previews-on-hover)
- [Finding your way: Navigate, Go to, Trace](#finding-your-way-navigate-go-to-trace)
- [The side panel: Contents, Map, Notation](#the-side-panel-contents-map-notation)
- [Understanding the logic](#understanding-the-logic)
- [Your own highlights and notes](#your-own-highlights-and-notes)
- [Looks: themes, handwritten notes, zoom](#looks-themes-handwritten-notes-zoom)
- [Settings: switching features on or off](#settings-switching-features-on-or-off)
- [Web viewer](#web-viewer)
- [Browser extension](#browser-extension)
- [VS Code extension](#vs-code-extension)
- [Command line](#command-line)
- [On phones and tablets](#on-phones-and-tablets)
- [Offline and privacy](#offline-and-privacy)
- [What LaTeX it understands](#what-latex-it-understands)
- [Render dashboard](#render-dashboard)

## Keyboard shortcuts

### Everywhere the document is shown

These work in the web viewer, the browser extension's viewer and the VS Code
preview (and the Overleaf panel, where the feature exists there). Single
letters are ignored while you type in a text field.

| Keys | What they do |
| --- | --- |
| <kbd>Ctrl+F</kbd> | Find in the document (opens the **Navigate** bar on **Find**). |
| <kbd>Ctrl+G</kbd> | Go to a theorem, equation, section, figure or table by number (**Navigate** on **Go to**). |
| <kbd>F3</kbd> / <kbd>Shift+F3</kbd> | Next / previous match while the bar is open. In the Find box, <kbd>Enter</kbd> and <kbd>Shift+Enter</kbd> do the same. |
| <kbd>Alt+Left</kbd> / <kbd>Alt+Right</kbd> | [Back](#back-to-where-you-were) to where you were before a jump, and forward again (<kbd>Option</kbd> on a Mac). Not while you type in a text field. |
| <kbd>↑</kbd> <kbd>↓</kbd> <kbd>Enter</kbd> | In **Go to** and **Trace**: move through the list and pick. |
| <kbd>Esc</kbd> | Close the Navigate bar, a hover preview, "What does this use?", or the contents drawer on a narrow window. |
| <kbd>M</kbd> | Open or close the larger dependency map. |
| <kbd>+</kbd> <kbd>−</kbd> <kbd>0</kbd> <kbd>F</kbd> | In the larger map: zoom in, zoom out, 100%, fit the whole map. Ctrl + scroll or a pinch zooms at the pointer; drag the background to move. |
| <kbd>N</kbd> / <kbd>Shift+N</kbd> | Jump to the next / previous margin note (the author's and your own). |
| <kbd>Ctrl+=</kbd> / <kbd>Ctrl+-</kbd> / <kbd>Ctrl+0</kbd> | Zoom the document in / out / back to 100%. Ctrl + mouse wheel or a pinch zooms too. |
| Click a formula | Copy its LaTeX. |
| <kbd>←</kbd> <kbd>→</kbd> on a divider | Resize the side panel, the margin column or the [text width](#looks-themes-handwritten-notes-zoom) from the keyboard. |

### Web viewer

| Keys | What they do |
| --- | --- |
| <kbd>Ctrl+K</kbd> | **Open** dialog: search arXiv or GitHub, paste a link or id, or pick a local file. |
| <kbd>Ctrl+O</kbd> | Open a `.tex` file from this computer. |
| <kbd>Ctrl+Shift+O</kbd> | Open a folder (or Shift+click **Open**). |
| <kbd>Ctrl+S</kbd> | Save back to the file. |
| <kbd>Ctrl+P</kbd> | Print, or save as PDF. |
| <kbd>Ctrl+E</kbd> | Switch between **Preview** and **Edit**. |
| <kbd>Ctrl+Shift+E</kbd> | Switch between **Preview** and **Split**. |
| <kbd>Ctrl+Space</kbd> | In the editor: show autocomplete. |
| <kbd>Tab</kbd> | In the editor: next snippet field, or step out of brackets. |
| <kbd>Esc</kbd> or <kbd>Ctrl+Enter</kbd> | In Edit mode: finish editing a paragraph. <kbd>↑</kbd> at its start or <kbd>↓</kbd> at its end moves to the neighbouring one. |
| <kbd>←</kbd> <kbd>→</kbd>, <kbd>Home</kbd>, <kbd>End</kbd>, <kbd>Enter</kbd> | On the Split divider: move it (with <kbd>Shift</kbd> in bigger steps), to either end, or back to the middle (double-click too). |

### Browser extension

| Keys | What they do |
| --- | --- |
| <kbd>Alt+Shift+K</kbd> | Same as the toolbar button: open this paper in TeXglass, the live panel on Overleaf, or the arXiv search anywhere else. Change it at `chrome://extensions/shortcuts` (Edge: `edge://extensions/shortcuts`; Firefox: *Manage Extension Shortcuts* in `about:addons`). |
| <kbd>Ctrl+K</kbd> | Inside the bundled viewer: the Open dialog, as on the website. |

### VS Code

| Keys | Command |
| --- | --- |
| <kbd>Ctrl+K V</kbd> | **TeXglass: Open Preview to the Side** (in a `.tex` file). |
| <kbd>Ctrl+K J</kbd> | **TeXglass: Jump Preview to Cursor**. |
| <kbd>Ctrl+F</kbd> | **TeXglass: Find in Preview** (preview focused). |
| <kbd>Ctrl+G</kbd> | **TeXglass: Go to Theorem, Equation or Section…** |
| <kbd>F3</kbd> / <kbd>Shift+F3</kbd> | **Find Next / Find Previous in Preview**. |
| <kbd>Alt+Left</kbd> / <kbd>Alt+Right</kbd> | **TeXglass: Go Back in Preview** / **Go Forward in Preview** (preview focused; VS Code's own Go Back elsewhere). |
| <kbd>Ctrl+=</kbd> (also <kbd>Ctrl+Shift+=</kbd>, <kbd>Ctrl+Numpad +</kbd>) | **TeXglass: Zoom In**. |
| <kbd>Ctrl+-</kbd> (also <kbd>Ctrl+Shift+-</kbd>, <kbd>Ctrl+Numpad -</kbd>) | **TeXglass: Zoom Out**. |
| <kbd>Ctrl+0</kbd> (also <kbd>Ctrl+Numpad 0</kbd>) | **TeXglass: Reset Zoom**. |
| <kbd>Ctrl+click</kbd> or double-click | In the preview: put the editor's cursor on that spot of the source. |

Rebind any of them in **Keyboard Shortcuts** (Ctrl+K Ctrl+S) by searching for
`texglass.`.

## Reading a paper

- **Rendered like the paper**: KaTeX math; theorems, equations, sections,
  figures and tables numbered the way LaTeX numbers them; `\ref`, `\eqref`,
  `\cref`, `\autoref`, `\nameref` resolve and are links; bibliographies from
  `.bbl`, `.bib` (BibTeX and biblatex) or amsrefs.
- **Click a formula** to copy its LaTeX, as written (labels left out).
  "Copied LaTeX" shows by the pointer. VS Code: `texglass.clickToCopyMath`.
- **Fold** a section or a proof with the arrow beside it, or by clicking a
  section heading or a folded proof. **Hide proofs** folds or unfolds every
  proof at once. Folds are remembered.
- **Diagrams** are drawn: `tikz-cd`, `xymatrix` and TikZ pictures (heavier
  TikZ shows its source). Pictures wider than the column shrink to fit.
- **Margin notes**: `\marginpar`, `\marginnote` and `\todo` sit in a margin
  column level with their line (`\todo[inline]` stays in the line).
  - Drag the line between the text and the margin to resize it, or use
    <kbd>←</kbd> <kbd>→</kbd> on it; double-click for the automatic width.
    The width is remembered.
  - Fold the margin away with the small arrow on that line, or by dragging it
    all the way right. Each line with a note then gets a small dot at the right
    edge of the text (orange for a todo, the highlight colour for your own
    notes; a ringed dot means several notes on that line). Click a dot to open
    the margin with that note lit up.
  - The arrows under the margin, or <kbd>N</kbd> and <kbd>Shift+N</kbd>, jump
    from note to note. The button below them narrows the jumps to margin
    notes, todo notes or your own notes.
- **Footnotes**: hover the mark to read the footnote in place.
- **Reading progress**: a small marker by each theorem, lemma, definition and
  proof.
  - Click it to step through **unread → skimmed → read → understood**.
  - The **?** beside it flags a result to ask about later.
  - The **Contents** tab shows an overall bar ("4 of 7 understood"), a bar per
    section, **What should I read next?** (the unread result that the most
    others rest on; **Another** suggests the next one), and **? n**, the list
    of flagged results with **Copy list** to send to a supervisor or a
    coauthor.
  - The **Map** colours results by status.
  - Statuses are kept by `\label` with your notes, so they sync with them and
    survive a revised version of the paper.
  - Turn it off in the web viewer's **…** menu (**Reading progress**) or with
    `texglass.readingProgress` in VS Code. Not in the Overleaf panel.

## Previews on hover

Rest the pointer on a link and a preview pops up; move onto the preview to
scroll it. It stays inside the window and closes with <kbd>Esc</kbd>.

- **References** (`\ref`, `\eqref`, …): the theorem, equation, figure or
  section they point to, and for a result also what it **uses** and where it
  is **used in**. Click to jump there.
- **Footnotes**: the footnote text.
- **Citations**: the bibliography entry, then the cited paper's title and
  abstract, looked up on DataCite and Crossref only when you hover, and kept
  for the visit. The abstract starts folded: click **Abstract** to open it. **Open in TeXglass** opens the paper when it is on arXiv.
  Offline, the bibliography entry shows on its own.
- **Cited theorems**: on a citation such as "[12, Theorem 4.1]" or "Theorem
  4.1 of [12]", when reference 12 is on arXiv, the preview shows Theorem 4.1
  itself, rendered from that paper's source. A result numbered as another kind
  (a shared counter) is shown and says so. Statements are kept, so they come
  back at once and offline. Opening the paper from there goes straight to that
  result.
- **Hypothesis checker**: when a proof cites a result ("by Lemma 3.2"), its
  preview splits the statement into its **hypotheses**, each with a box to
  tick once you have checked it holds here, and its **conclusion**. Standing
  assumptions of that section ("Throughout this section…", an Assumption
  environment) are listed too, and a hypothesis that nothing near the citation
  mentions gets a quiet hint. **As written** switches back to the statement as
  the paper writes it (remembered). Ticks are kept with your notes. Web viewer
  and VS Code.
- **Notation on hover**: rest on a formula to see where its notation comes
  from: the paper's own macros (`\newcommand`, with their definition and
  first use), symbols defined with `:=`, and symbols the text introduces in
  words ("let X be", "denote by X", "where X is"), with a link to the
  definition. Turn it off with the checkbox in the **Notation** tab, or
  `texglass.notationHover` in VS Code.
- **Map nodes**: resting on a result in the map (small or large) previews its
  statement.

## Finding your way: Navigate, Go to, Trace

The **Navigate** button (<kbd>Ctrl+F</kbd> / <kbd>Ctrl+G</kbd>) opens a bar
with three tabs:

- **Find**: search the text. Matches are highlighted; <kbd>Enter</kbd>,
  <kbd>F3</kbd> next, <kbd>Shift+Enter</kbd>, <kbd>Shift+F3</kbd> previous. A
  short selection is used as the search when you open it.
- **Go to**: type `Lemma 4.1`, `(3.2)`, `§2`, `Fig. 3` or part of a name and
  pick from the list.
- **Trace**: pick a theorem, lemma or definition (the list shows "uses 3 ·
  used in 5") to see only what it uses and what uses it. It starts
  [What does this use?](#understanding-the-logic) on that result.

Web viewer links can go straight to a result: `?arxiv=<id>&goto=Theorem 4.1`.

### Back to where you were

Every jump remembers where you were reading: clicking a reference or a
citation, an entry in **Contents**, a result on the **Map** (double-click, or
**Go there**) or in the notation
index, **Go to**, **Trace**, the first match of **Find**, **Go there** in a
preview, and the next or previous margin note. A jump to something already on
screen doesn't count.

- After a jump, a **Back** button appears over the top left corner of the
  document. Click it, or press <kbd>Alt+Left</kbd>, to go back to the very
  spot you left. Press it again to go back further, as in a browser.
- Once you have gone back, a **→** button beside it (or <kbd>Alt+Right</kbd>)
  goes forward again. A new jump clears the way forward.
- The button fades while you read and brightens when you point at it.
- Opening another document starts afresh. In the web viewer and the Overleaf
  panel, <kbd>Alt+Left</kbd> goes back in the document, not to the previous
  web page. In VS Code it goes back in the preview while the preview has
  focus, and is VS Code's own **Go Back** everywhere else.

## The side panel: Contents, Map, Notation

**Contents** (toolbar button; VS Code: **TeXglass: Show or Hide Contents**)
opens the side panel. Drag its edge, or use <kbd>←</kbd> <kbd>→</kbd> on it, to
resize; the width and tab are remembered, and on a narrow panel the tabs stack.
The button at its top moves it to the other side (VS Code: **TeXglass: Move
Contents to the Other Side**, `texglass.contentsPosition`).

- **Contents**: the sections, highlighting the one you are reading, plus the
  reading progress summary.
- **Map**: which results each theorem uses, read from the `\ref`s in its
  statement and proof.
  - Solid lines: used in a proof. Dotted: only named in a statement. Dashed:
    a guess from a result named without a link ("Lemma 2.3" typed by hand,
    "the previous lemma").
  - A cited equation links to the result it sits in, or whose proof holds it;
    cited works (`\cite`) are leaves.
  - Results are grouped by section; on big maps chains of lemmas that serve one
    result fold into it (**+3** on the result shows them).
  - Click a result to light up what it uses and what uses it; double-click
    (double-tap on a touch screen) to jump to it in the text, which also
    closes the larger map. **Back** returns you.
  - Drag to pan. **Show what it uses** starts "What does this use?" there.
  - <kbd>M</kbd> (or **Larger map**; VS Code: **TeXglass: Show Larger
    Dependency Map**) opens the map filling the window: drag to move, Ctrl +
    scroll or pinch to zoom, or **−**, **100%**, **+**, **Fit** (keys
    <kbd>−</kbd> <kbd>+</kbd> <kbd>0</kbd> <kbd>F</kbd>).
- **Notation**: an index of the paper's macros and defined symbols, with
  their meaning in words where the text gives one and a link to the first use.
  The checkbox turns notation on hover off and on.
  - **Search** by symbol or by meaning: a command name (`norm`), a letter
    (`alpha` or `α`) or a word from the sentence that introduces the symbol
    (`measure`).
  - **Section**, **Kind** and **A–Z** arrange the list: under the section
    where each symbol is first defined; as spaces and sets, maps and
    operators, named functions, constants and parameters (guessed from the
    wording and the symbol's shape); or alphabetically, with Greek letters
    together. Each group folds with a click on its heading. Your choice is
    remembered.
  - **Used in …** at the top shows the symbols of the section you are reading
    and follows you as you scroll. Click (or tap) one to find its entry in the
    list.
  - **Pin** a symbol with the pin by its entry: pinned symbols gather at the
    top of the tab and stay in view while you scroll the list (and while you
    search). Pins are kept per paper; click the pin again to unpin. Drag a
    pinned symbol by its handle (⋮⋮) to reorder them, with the mouse or a
    finger, or focus the handle and press <kbd>↑</kbd> <kbd>↓</kbd>; the order
    is kept with the pins. The pin by
    **Used in …** keeps that strip in view too.

## Understanding the logic

- **What does this use?** The small button by a theorem's heading lights up
  the results it rests on, directly or not, its proof and the equations it
  cites, and fades the rest of the page.
  - Switch to **Used in** for the other direction, and step through the
    results with the arrows in the bar.
  - Results reached only through a guessed link get a dashed outline; cited
    works light up in the bibliography.
  - **Hide the rest** folds everything else away (headings stay). The proofs
    of the shown results stay folded until you click them.
  - A map on show lights up the same results, and picking a result on the map
    moves the focus to it.
  - **Done** or <kbd>Esc</kbd> ends it.
  - **Print** on the bar prints what is shown: with **Hide the rest** on, only
    the lit results, and of their proofs only the ones you opened.
- **Trace**: the same, chosen by name from the Navigate bar.
- **Show selected results**: pick theorems, lemmas, definitions and numbered
  equations, and see only those. Start it from the … menu (web viewer) or
  **TeXglass: Show Selected Results…** (VS Code, also in the preview's `…`
  menu).
  - Every result and numbered equation gets a tick box; click a result or an
    equation to tick it, again to untick it. **Show selected** shows only the
    ticked ones, with the headings of their sections and the paper's title.
  - The proof of a selected result comes along folded to its first line.
    Click it to open it; its fold arrow folds it again.
  - **Print** on the bar prints exactly that view, to a printer or as a PDF:
    the selected results and equations, and only the proofs you opened. For
    example, tick Theorem 1, (1.1) and (3.4), open the proof of Theorem 1, and
    print. <kbd>Ctrl+P</kbd> (web viewer) and **TeXglass: Print / Save as
    PDF** print the view too.
  - **Change** goes back to ticking; **Done** or <kbd>Esc</kbd> shows the
    whole document again.
- **Hypothesis checker** and **cited theorems**: see
  [Previews on hover](#previews-on-hover).
- **Reading progress**: see [Reading a paper](#reading-a-paper).

## Your own highlights and notes

In the web viewer, the browser extension's viewer and VS Code (not the
Overleaf panel).

- **Highlight**: select text and pick a colour (yellow, green, pink, blue)
  from the bar that appears below the selection; click a highlight to recolour
  or remove it. The bar stays clear of the system's own menu (copy, look up,
  share), which opens above the selection; on a phone or tablet it also sits
  below the selection handles, and appears once a long press has selected.
- **Note**: the note button on that bar writes a note on the selection; or
  drag the **note pad** (bottom right) onto any line. Drag the pad's dotted
  handle to move the pad itself (arrow keys on the handle work too). Drag a
  note in the margin to move it to another line.
- In a note, `$…$` is maths with the paper's own macros. <kbd>Ctrl+Enter</kbd>
  saves, <kbd>Esc</kbd> cancels. Hover a note for edit and delete.
- Each paper's notes are one small file, `paper.texglass.json`, keyed by the
  paper: its arXiv id, its GitHub path, or for a `.tex` file its name and title.
- Notes are anchored to the text they mark (a quote plus its surroundings),
  not line numbers, so they find their place in a revised paper; a note whose
  text has gone shows "Text not found".
- **Where they are kept**:
  - VS Code: `name.texglass.json` beside the `.tex` (the `.tex` is never
    changed). Hide them with **TeXglass: Show or Hide Highlights and Notes** or
    `texglass.studyTools`.
  - Web viewer and browser extension: in the browser, per paper (an arXiv
    paper keeps its notes across versions). The **…** menu has **Highlights
    and notes** to turn them off and on.
- **Export / Import**: **Export notes** and **Import notes…** in the **…**
  menu; VS Code: **TeXglass: Export Highlights and Notes…** and **Import
  Highlights and Notes…**. All of them read the same `paper.texglass.json`.
- **Sync through GitHub**: notes go to a private gist, `texglass-notes.json`,
  in your own GitHub account (there is no TeXglass server), and come back
  wherever you sign in. **You sign in once, and from then on it is
  automatic**: it syncs on opening a paper, a few seconds after an edit, and
  when you come back to the tab. There is no button you need to press.
  - VS Code: run **TeXglass: Sync Highlights and Notes with GitHub** once; it
    uses VS Code's GitHub sign-in. While a preview is open, the status bar
    shows **Notes sync on** (its tooltip says when it last synced); click it
    to sync right away or stop. **Stop Syncing Highlights and Notes with
    GitHub** ends it.
  - Web viewer and browser extension: **Sync notes with GitHub…** in the
    **…** menu, then paste a token with only the `gist` scope (the dialog links
    to the page that makes one). Once signed in, the menu item reads
    **Syncing with GitHub… automatic**, and the dialog shows *Syncing automatically ·
    last synced …*, a **Sync now** link (only to pull in another device's
    change at once) and **Sign out**.
- **Without GitHub**: the browser extension also syncs with your browser's own
  sync, and VS Code with Settings Sync.
- Changes on two devices are merged note by note: the later edit wins, and a
  deleted note stays deleted. Reading progress and hypothesis ticks travel
  with the notes.

## Looks: themes, handwritten notes, zoom

- **Light and dark**: the moon button. It follows your system until you choose.
  VS Code: **TeXglass: Toggle Light/Dark Preview**, `texglass.previewTheme`
  (`auto` follows VS Code).
- **Handwritten notes look**: the pen button beside it shows the paper as notes
  in ink on squared paper, or chalk on a board in the dark theme. Worked out
  only when you ask for it, so rendering is not slowed down. VS Code: **TeXglass:
  Toggle Handwritten Notes Look**, plus settings for the paper, hand, pen and
  ink (see [VS Code settings](#settings)). Print and HTML export keep the look.
- **Zoom**: the **− 100% +** buttons, <kbd>Ctrl+=</kbd> <kbd>Ctrl+-</kbd>
  <kbd>Ctrl+0</kbd>, or Ctrl + scroll / pinch. Remembered.
- **Text width**: hover either edge of the text until the pointer becomes
  ↔, then drag it to make the column wider or narrower (it stays centred).
  Drag it to the edge of the window to let the text fill it; double-click an
  edge for the usual width; <kbd>←</kbd> <kbd>→</kbd> move a focused edge. The
  margin notes keep their column beside the text, and the width scales with
  zoom. Remembered: in the web viewer and browser extension per browser, in
  VS Code for every preview, and in the Overleaf view on its own (that panel is
  usually narrower). Not on phones, where the text always takes the screen.

## Settings: switching features on or off

The **gear** button (on a phone, **Settings** in the **…** menu) opens Settings, a list of TeXglass's reading aids with a
switch for each. Turn off what you don't use; **Turn everything back on**
restores them. Choices apply to every paper at once.

| Group | Switch | What it covers |
| --- | --- | --- |
| Previews on hover | References | Previews of theorems, equations, sections and figures. |
| | Footnotes | Footnote previews. |
| | Citations | The bibliography entry when you rest on a citation. |
| | Look up cited papers online | Title, authors and abstract from DataCite, Crossref and arXiv (needs Citations). Off means no citation is sent anywhere. |
| | Cited theorems | "[12, Theorem 4.1]" previews (needs the lookup). |
| | Hypothesis checker | Results cited in proofs split into hypotheses to tick (needs References). |
| Notation and structure | Notation on hover | Where a formula's symbols are defined. |
| | Symbols introduced in words | Also read "let X be", "denote by X". |
| | Notation index | The Notation tab. |
| | Dependency map | The Map tab, the larger map (<kbd>M</kbd>), and "Uses / Used in" under previews. |
| | "What does this use?" buttons | The button by each result. |
| Study | Highlights and notes | Same as the `…` menu item. |
| | Reading progress | Same as the `…` menu item. |
| Page | Click a formula to copy its LaTeX | |
| | Handwritten notes look | Same as the pen button. |

A switch that needs another one is dimmed while that one is off. Where each
one is kept:

- **Web viewer and browser extension**: in that browser (the extension's
  viewer and its Overleaf view share them). Not synced with your notes.
- **Overleaf view**: the gear in its toolbar shows the switches that apply
  there (no footnotes, cited theorems, hypothesis checker, notes or progress).
- **VS Code**: the gear in the preview's title bar (**TeXglass: Settings:
  Switch Reading Aids On or Off**) opens the same panel. Each switch is a
  `texglass.*` setting (see [Settings](#settings)), so Settings Sync carries
  them and a workspace can set its own.

## Web viewer

[klepo0.github.io/TeXglass](https://klepo0.github.io/TeXglass/). Nothing to
install; after the first visit it opens and renders offline.

**Opening a document**

- **Open** (<kbd>Ctrl+K</kbd>) is one dialog for everything:
  - type words, a title or an author to **search arXiv** (through
    [DataCite](https://datacite.org), which holds every arXiv DOI, with
    OpenAlex and Semantic Scholar as fallbacks, since arXiv's own search can't
    be called from a web page), or paste an arXiv id or link; the source, the authors' own `.sty` files, the bibliography and
    figures (including `.eps` and `.pdf`) come along;
  - type `github` and words to **search GitHub** for repositories with LaTeX,
    or paste a link to a public file, folder or repository (`github
    owner/repo` works too);
  - or pick a file or folder from this computer.
- <kbd>Ctrl+O</kbd> opens a `.tex` file; <kbd>Ctrl+Shift+O</kbd> (or Shift+click
  **Open**) a folder, so its `\input` files, local packages, bibliography and
  figures come too. Several files at once work as well, and so does dropping
  a file or folder on the page. TeXglass finds the main file. In Chrome and
  Edge a folder chosen this way re-renders when you save any of its files.
- **OAI preprints** lists the manuscripts in
  [openai/math](https://github.com/openai/math), searchable and filtered by
  discipline.
- **Links**: `?arxiv=2301.00001` (add `&goto=Theorem 4.1` to land on a
  result), a bare `?arxiv` for the search dialog, `?gh=<GitHub link>`,
  `?preprint=<folder>`. A **bookmarklet** in the Open dialog opens the GitHub
  page you are on.

**Saving papers for offline reading**

- **Save offline** (the bookmark in the toolbar, also **Save for offline** in
  the **…** menu) keeps the open paper on this device: its source, figures and
  where it came from. Once saved the bookmark fills in and reads **Saved
  offline**; press it again to remove the paper.
- The **Open** dialog lists your five most recently saved or opened saved
  papers, with **All saved papers** for the rest.
- **Saved papers…** in the **…** menu lists them all with their size. Tap one to open it, with or without a connection;
  **Remove** deletes it. A search box appears once there are several.
- An arXiv paper you saved opens from its saved copy when you are offline or
  arXiv can't be reached, from Open, a `?arxiv=` link or a reload.
- Signed in under **Sync notes with GitHub…**, the list (titles and links, not
  the papers) travels with your notes, automatically. A paper saved on another device shows
  as *saved on another device*; **Download** fetches it from arXiv or GitHub
  and keeps it here too. Removing a paper takes it off the list everywhere.
- Works for any open document (arXiv, GitHub, OAI preprints, your own files).
  The browser is asked to keep saved papers even when space runs low.

**Editing**

- **Preview**, **Edit** and **Split** modes (<kbd>Ctrl+E</kbd>,
  <kbd>Ctrl+Shift+E</kbd>). In Edit, click any paragraph, theorem or equation
  to edit its LaTeX in place; **+ Add text at the end** adds a new one. Split
  shows the source beside the preview, scrolling together, with a draggable
  divider.
- The editor colours LaTeX, autocompletes commands, snippets, environments
  (your `\newtheorem`s too) and labels with their numbers
  (<kbd>Ctrl+Space</kbd>), closes `$`, `\(` and `\[` for you, and
  <kbd>Tab</kbd> steps out of brackets.
- **Edit on GitHub** appears for a document opened from GitHub.

**The … menu**: **Save** (<kbd>Ctrl+S</kbd>, back to the file, with live
reload when it changes on disk in Chrome and Edge), **Export as HTML** (one
standalone page that works offline), **Show selected results…** (see
[Understanding the logic](#understanding-the-logic)), **Print or save as PDF**
(<kbd>Ctrl+P</kbd>; prints what the page shows, so a selection or **Hide the
rest** prints as shown), **Save for offline** and **Saved papers…** (see
above), **Highlights and notes**, **Export notes**, **Import notes…**, **Sync
notes with GitHub…** (**Syncing with GitHub…** once signed in) and **Reading progress**. At the very end, **Support
TeXglass ☕** opens its [Buy Me a Coffee](https://buymeacoffee.com/texglass)
page.

**Status** at the top counts undefined references and duplicate labels.

Run it yourself with `npm start` (http://localhost:8000); it is a static page
with no build step.

## Browser extension

For Chrome, Edge (111 or later) and Firefox (128 or later). Install steps:
[browser/README.md](../browser/README.md).

- **Toolbar button** or <kbd>Alt+Shift+K</kbd>: on an arXiv abstract, PDF or
  HTML page, open that paper in TeXglass; on Overleaf, the live panel;
  anywhere else, TeXglass with its arXiv search.
- **Right-click menu**: *Open arXiv paper in TeXglass* on any link to an arXiv
  paper, *View this paper in TeXglass* on arXiv pages, and on the toolbar
  button *Open a .tex file from this computer…*.
- **On arxiv.org**: *View in TeXglass* on abstract pages, a *texglass* link in
  listings, and a floating button on HTML papers.
- **alphaXiv, HAL and ResearchGate**: a *View in TeXglass* button on paper
  pages whose paper is also on arXiv (the id in the address or metadata, HAL's
  own record, or an exact title match on arXiv).
- **Self-contained**: papers open in a viewer bundled with the extension, with
  everything the web viewer has, so only arxiv.org must be reachable.
- **Options**: open papers in the bundled viewer or the TeXglass website, and
  (Chrome and Edge, with *Allow access to file URLs*) show `.tex` files you
  open in the browser in TeXglass, live as you save them.
- **Support TeXglass ☕** on the toolbar button's right-click menu (and a
  link in Options) opens its [Buy Me a Coffee](https://buymeacoffee.com/texglass)
  page.

### Overleaf view

On an Overleaf project, the *TeXglass* tab on the right edge (or the toolbar
button, or <kbd>Alt+Shift+K</kbd>) opens a live preview panel beside the
editor.

- Re-renders the open file as you and your collaborators type, and when you
  switch files.
- **Follow**: scrolls along with the editor (turn it off to read on your own)
  and marks the paragraph holding the cursor.
- Click in the preview to move the editor's cursor there (a formula: Ctrl+click
  or double-click); text from an `\input` file opens that file first.
- Click a formula to copy it, hover previews, folding and **Proofs**,
  **Contents** (left or right), **Navigate** (<kbd>Ctrl+F</kbd>,
  <kbd>Ctrl+G</kbd>), [Back](#back-to-where-you-were) after a jump
  (<kbd>Alt+Left</kbd>), the map and notation, light and dark.
- **Text width**: drag either edge of the text (double-click for the usual
  width; see [Looks](#looks-themes-handwritten-notes-zoom)); remembered apart
  from the viewer's. Drag the panel's left edge to resize the panel.
- **Files** downloads the project's zip with your login and pulls in
  `\input` files, the main preamble, `.bib` references and figures (a
  snapshot; **Reload** refreshes it).
- It only reads the project; Overleaf's PDF stays the final version.

## VS Code extension

Install **TeXglass** from the
[Marketplace](https://marketplace.visualstudio.com/items?itemName=klepo1.texglass)
or Open VSX (`ext install klepo1.texglass`), open a `.tex` file and press
<kbd>Ctrl+K V</kbd>. It also works in github.dev and vscode.dev: press `.` on
any GitHub repository, preview, edit, commit. Prefer a file? Every
[release](https://github.com/klepo0/TeXglass/releases) has a `.vsix`
(**Extensions: Install from VSIX…**).

- **Live preview** beside the editor or in place, updated as you type without
  saving; also in the Explorer's right-click menu.
- **Scroll sync** both ways (title-bar link button, `texglass.scrollSync`).
- **Jump to source**: Ctrl+click or double-click in the preview;
  <kbd>Ctrl+K J</kbd> brings the cursor's spot to the preview, highlighted.
- **Multi-file documents**: `\input`, `\include`, `\subfile`, `\import`,
  `\includeonly`, live across files; previewing a chapter shows the whole
  document (`% !TEX root`, subfiles, or the file that includes it).
- **Bibliographies** from `.bib`, `.bbl` or amsrefs; **figures** in PNG, JPEG,
  SVG, GIF, WebP, PDF and EPS, with `\graphicspath`.
- **Export to HTML**: one standalone page that works offline
  (`texglass.exportEmbedFonts`). **Print / Save as PDF**, laid out like a paper.
- Title-bar buttons: Navigate, Contents, Hide/Show proofs, handwriting,
  Settings (gear), light/dark, scroll sync; the `…` menu has the rest.

### Commands

All in the Command Palette under **TeXglass:**.

| Command | What it does |
| --- | --- |
| Open Preview to the Side | Preview beside the editor (<kbd>Ctrl+K V</kbd>). |
| Open Preview | Preview in the current editor group. |
| Jump Preview to Cursor | Show the cursor's spot in the preview (<kbd>Ctrl+K J</kbd>). |
| Stop Scrolling with the Editor | Turn scroll sync off. |
| Scroll with the Editor | Turn scroll sync on. |
| Toggle Scrolling with the Editor | Switch scroll sync. |
| Show or Hide Contents | The side panel. |
| Move Contents to the Other Side | Left or right. |
| Hide Proofs | Fold every proof. |
| Show Proofs | Unfold every proof. |
| Toggle Light/Dark Preview | Switch the theme. |
| Toggle Handwritten Notes Look | Switch the look. |
| Settings: Switch Reading Aids On or Off | The [Settings panel](#settings-switching-features-on-or-off) (gear). |
| Show or Hide Highlights and Notes | Your own notes and highlights. |
| Next Margin Note | <kbd>N</kbd> in the preview. |
| Previous Margin Note | <kbd>Shift+N</kbd> in the preview. |
| Export Highlights and Notes… | Save them as a file. |
| Import Highlights and Notes… | Add them from a file. |
| Sync Highlights and Notes with GitHub | Private gist sync. |
| Stop Syncing Highlights and Notes with GitHub | End it. |
| Find in Preview | <kbd>Ctrl+F</kbd>. |
| Find Next in Preview | <kbd>F3</kbd>. |
| Find Previous in Preview | <kbd>Shift+F3</kbd>. |
| Go to Theorem, Equation or Section… | <kbd>Ctrl+G</kbd>. |
| Go Back in Preview | Back to where the preview was before a jump (<kbd>Alt+Left</kbd>). |
| Go Forward in Preview | Forward again (<kbd>Alt+Right</kbd>). |
| Show Notation Index | The Notation tab. |
| Show Dependency Map of the Results | The Map tab. |
| Show Larger Dependency Map | <kbd>M</kbd> in the preview. |
| Show Selected Results… | Tick results and numbered equations, then show (and print) only those. |
| Export to HTML | A standalone page. |
| Print / Save as PDF | Laid out like a paper, in the browser; prints what the preview shows (a selection, or **Hide the rest**). |
| Zoom In | <kbd>Ctrl+=</kbd>. |
| Zoom Out | <kbd>Ctrl+-</kbd>. |
| Reset Zoom | <kbd>Ctrl+0</kbd>. |
| Support TeXglass ☕ | Opens its [Buy Me a Coffee](https://buymeacoffee.com/texglass) page (also at the end of the preview's `…` menu). |

### Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `texglass.scrollSync` | `true` | Scroll the preview with the editor and back. |
| `texglass.studyTools` | `true` | Your highlights and notes in the preview. |
| `texglass.readingProgress` | `true` | Reading progress markers and summaries. |
| `texglass.notationHover` | `true` | Notation on hover. |
| `texglass.notationFromText` | `true` | Notation also finds symbols introduced in words. |
| `texglass.notationIndex` | `true` | The Notation tab. |
| `texglass.dependencyMap` | `true` | The Map tab, larger map and "Uses / Used in" under previews. |
| `texglass.whatDoesThisUse` | `true` | "What does this use?" buttons. |
| `texglass.previews.references` | `true` | Previews of references. |
| `texglass.previews.footnotes` | `true` | Previews of footnotes. |
| `texglass.previews.citations` | `true` | Previews of citations (the bibliography entry). |
| `texglass.citationLookup` | `true` | Look up cited papers on DataCite, Crossref and arXiv. |
| `texglass.citedTheoremPreviews` | `true` | "[12, Theorem 4.1]" previews from arXiv. |
| `texglass.hypothesisChecker` | `true` | Hypotheses to tick in previews of cited results. |
| `texglass.clickToCopyMath` | `true` | Click a formula to copy its LaTeX. |
| `texglass.previewTheme` | `auto` | `auto`, `light` or `dark`. |
| `texglass.previewStyle` | `standard` | `standard` or `handwritten`. |
| `texglass.notes.paper` | `grid` | Handwritten look: `grid`, `lined` or `plain` paper. |
| `texglass.notes.handwriting` | `kalam` | The hand: `kalam`, `caveat`, `patrick-hand`, `architects-daughter`. |
| `texglass.notes.handwrittenMath` | `true` | Handwrite letters and digits in formulas too. |
| `texglass.notes.ink` | `ballpoint` | `ballpoint`, `fountain` or `black` (chalk in dark mode). |
| `texglass.notes.realisticInk` | `true` | Ragged, pooling ink; off for flat strokes. |
| `texglass.contentsPosition` | `left` | Side of the contents: `left` or `right`. |
| `texglass.exportEmbedFonts` | `true` | Put KaTeX fonts inside exported HTML (off: load from a CDN). |

## Command line

```sh
npx texglass paper.tex -o paper.html
```

Writes the same standalone page as **Export**. `--link-katex` loads KaTeX's
stylesheet and fonts from a CDN instead of embedding them (about 350 KB).
`-h` or `--help` prints the usage.

## On phones and tablets

The web viewer adapts to a phone or a tablet. Nothing needs switching on.

**Install it like an app.** On an iPhone or iPad, open the site in Safari, tap
Share, then **Add to Home Screen**. On Android, or in Chrome or Edge, choose
**Install TeXglass as an app** in the **…** menu when it appears there. Opened
from the home screen it has no browser bars and works offline after the first
visit, like the web viewer anywhere.

**Papers to read offline.** Before a trip, open each paper and tap the bookmark
in the toolbar (**Save offline**). The **Open** dialog lists the recent ones and
**Saved papers…** in the **…** menu lists them all; they open with no connection, figures included (see [Saving papers for
offline reading](#web-viewer)).

**A compact toolbar (windows up to 760px wide).** The toolbar is one row of
large buttons: **Open**, the side panel (the three lines), **Navigate** (the
magnifier), **Save offline** (the bookmark), the handwritten and theme toggles,
and **…**. The mode switch (Preview, Edit, Split), **OAI preprints**, zoom,
**Hide proofs**, **Edit on GitHub** and **Settings** move to the top of the
**…** menu. They move back when the window is
wider.

**Drawers you swipe in.** On a narrow screen the side panel and the margin notes
are drawers over the text, so the text keeps the whole width (a text width set
on a computer does not apply on a phone):

- Swipe in from the left edge to open the side panel (from the right edge if you
  moved it to the right). Its button opens it too.
- Swipe in from the right edge to open the margin. Its small arrow button, or a
  tap on a note's dot at the right edge of the text, opens it too.
- Swipe a drawer back toward its edge, tap outside it, or press <kbd>Esc</kbd>
  to close it. Choosing a section in Contents closes the side panel.

Whether the margin is open on a phone isn't saved, so it stays the way you set
it on a computer.

**Previews open on a tap.** On a touch screen, the previews that a mouse shows
on hover open as a sheet at the bottom of the screen. That covers references,
citations, footnotes, notation and the map's results.

- A tap on a reference or citation shows it, without leaving your place.
  **Go there** in the sheet jumps to it, and the **Back** button at the top
  left brings you back.
- A tap on a formula shows where its notation comes from.
- Tap outside the sheet, swipe its handle down, or tap the handle to close it.
  A long preview scrolls inside the sheet.

**Formulas fit the screen.** On a phone or tablet, a display formula too wide
for the screen breaks after its relations and operators (`=`, `≤`, `+`) and
continues on the next line, instead of scrolling sideways. Formulas that can't
break, such as matrices and aligned equations, still scroll sideways.

**Write notes with Apple Pencil or a stylus.** With **Highlights and notes** on,
a pen writes in the margin column. Your finger still scrolls, and selecting
text still works as usual.

- The first touch of the pen opens the margin column, even when there are no
  notes yet.
- Strokes you write one soon after another make one note, placed beside the
  line where you started. Pause for a moment, or start writing well above or
  below, to begin a new note.
- A handwritten note is kept with your other notes, so it exports, imports and
  syncs through your gist like them. Its pencil button adds typed words under
  the handwriting, and its bin button deletes it. You can drag it to another
  line like any note.
- The browser extension's own sync holds at most 8 KB of notes per paper.
  Many handwritten notes on one paper can go over that, and then they stay in
  that browser. Gist sync has no such limit.

## Offline and privacy

- The VS Code extension and the command line work fully offline. The web
  viewer works offline after the first visit (arXiv, GitHub, citation lookups
  and OAI preprints need a connection). Cited theorems and citation details
  already seen are kept, and so are papers you **Save for offline** (in the
  browser's own storage on this device).
- Your files and the papers you open never leave your browser or editor.
  Citation previews ask DataCite and Crossref about a citation only when you
  hover it; switch **Look up cited papers online** off in
  [Settings](#settings-switching-features-on-or-off) to stop that. Notes sync goes only to your own GitHub gist.
- The public website counts visits with [GoatCounter](https://www.goatcounter.com),
  a cookieless counter: one request per visit with the site's path, the
  referring site and the screen width, never a paper, file name or arXiv id.
  It stores nothing on your device and is skipped when your browser sends Do
  Not Track or Global Privacy Control. Local copies, the browser extension, the
  VS Code extension and the command line count nothing.

## What LaTeX it understands

- **Math**: `$…$`, `\(…\)`, `\[…\]`, `equation`, `align`, `gather`,
  `multline`, `alignat`, `eqnarray`, mhequ's `equ` and `equs`, with `\tag`,
  `\nonumber`, `\notag`. The physics package's macros (`\abs`, `\norm`,
  `\qty`, `\dv`, …) work out of the box.
- **Macros**: `\newcommand`, `\renewcommand`, `\def` (delimited parameters
  too), `\let`, `\DeclareMathOperator`, in math and text, and those in a
  paper's own `.sty` files when imported from arXiv.
- **Theorems**: `\newtheorem` in all its forms, `\theoremstyle`, `proof` ∎.
- **Numbering and references**: sections, `\appendix`, `\numberwithin`,
  enumerate and enumitem labels, figures, tables; `\ref`, `\eqref`, `\cref`,
  `\Cref`, `\autoref`, `\nameref`.
- **Structure**: `\maketitle`, abstract, lists, footnotes, `tabular`,
  `verbatim`, links, ulem underlines.
- **Bibliographies**: `thebibliography`, `.bbl` (BibTeX or biber), `.bib`
  files (BibTeX and biblatex) and amsrefs records
  (`\begin{bibdiv}…\bib{key}{article}{…}`).
- **Figures**: PNG, JPEG, SVG, GIF and WebP, with `\graphicspath`. `.eps`
  figures (common in older papers) are drawn as SVG by a small PostScript
  interpreter, pictures inside them included, and `.pdf` figures with pdf.js,
  loaded only for papers that have them.
- **Diagrams**: `tikzcd` and `\xymatrix` (bends, shifts, 2-cells, arrow
  styles) and `tikzpicture`s, including `\clip`, hatching patterns, braces,
  pictures inside nodes, macros that hold paths, and `\resizebox` to the
  column width (pictures wider than the column shrink to fit). Tree symbols
  declared with `\DeclareSymbol` (as in regularity structures papers) are
  drawn inside formulas. Heavier TikZ shows its source.

Anything unknown is skipped gracefully. There is no TeX install and no compile
step, and long papers stay fast.

## Render dashboard

Every night the [render dashboard](https://klepo0.github.io/TeXglass/dashboard/)
opens about 200 arXiv papers in the web viewer and lists what broke: maths
KaTeX could not render, missing figures, undrawn diagrams, papers that froze,
and slow loads, with what changed since the night before. See [dashboard/README.md](../dashboard/README.md).
