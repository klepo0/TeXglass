# TeXglass guide

Everything TeXglass does, where to find it, and every keyboard shortcut.

TeXglass runs in four places that share one reader:

| Where | What it is |
| --- | --- |
| [Web viewer](#web-viewer) | [klepo0.github.io/TeXglass](https://klepo0.github.io/TeXglass/): open a `.tex` file, an arXiv paper or a GitHub repository in the browser. |
| [Browser extension](#browser-extension) | Chrome, Edge and Firefox: open arXiv, alphaXiv, HAL and ResearchGate papers in TeXglass, and a live preview beside Overleaf's editor. |
| [VS Code extension](#vs-code-extension) | A live preview beside your `.tex` file, with jump to source and notes saved beside the file. |
| [Command line](#command-line) | `npx texglass paper.tex -o paper.html` makes a standalone page; `--reader` adds the reading tools; `--epub` makes an e-book. |

Most features below work in all of them. Where one is missing somewhere, the
section says so. On a Mac, read <kbd>Cmd</kbd> for <kbd>Ctrl</kbd> throughout.

**Contents**

- [Keyboard shortcuts](#keyboard-shortcuts)
- [Reading a paper](#reading-a-paper)
- [Previews on hover](#previews-on-hover)
- [Finding your way: Navigate, Go to, Uses](#finding-your-way-navigate-go-to-uses)
- [The side panel: Contents, Map, Notation](#the-side-panel-contents-map-notation)
  - [Pins and your own map](#pins-and-your-own-map)
  - [Everything pinned in one place](#everything-pinned-in-one-place)
- [Understanding the logic](#understanding-the-logic)
- [Comparing versions](#comparing-versions)
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
- [Hints for TeXglass in your own papers](#hints-for-texglass-in-your-own-papers)
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
| <kbd>↑</kbd> <kbd>↓</kbd> <kbd>Enter</kbd> | In **Go to** and **Uses**: move through the list and pick. |
| <kbd>Esc</kbd> | Close the Navigate bar, a hover preview, "What does this use?", stepping through a proof, or the contents drawer on a narrow window. |
| <kbd>M</kbd> | Open or close the larger dependency map. |
| <kbd>Alt</kbd> + arrow keys | On the map: move the focused result (unless the map is locked). |
| <kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Shift+Z</kbd> | On the map: undo / redo the last change to it (also <kbd>Ctrl+Y</kbd>). |
| <kbd>+</kbd> <kbd>−</kbd> <kbd>0</kbd> <kbd>F</kbd> | In the larger map: zoom in, zoom out, 100%, fit the whole map. Ctrl + scroll or a pinch zooms at the pointer; drag the background to move. |
| <kbd>→</kbd> / <kbd>←</kbd> | While [stepping through a proof](#understanding-the-logic): the next / previous piece. <kbd>Space</kbd> and <kbd>Shift+Space</kbd>, <kbd>PageDown</kbd> and <kbd>PageUp</kbd> do the same; <kbd>Home</kbd> / <kbd>End</kbd> go to the first / last piece; <kbd>Esc</kbd> stops. |
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
  section heading or a folded proof. **Hide proofs** (the toolbar button with
  two arrows meeting at a line) folds or unfolds every proof at once; its
  tooltip says which it will do. Folds are remembered.
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
    notes, todo notes or your own notes. The fold arrow and these buttons stay
    put near the top of the window while you scroll.
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
  is **used in**. Click to jump there. For a result, a numbered equation or a
  figure, the **pin** at the preview's top right pins it (see
  [Everything pinned in one place](#everything-pinned-in-one-place)).
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
  definition. The **pin** beside each symbol or macro pins it to the top of the
  **Notation** tab and to the **Pinned** list. Turn it off with the checkbox in
  the **Notation** tab, or `texglass.notationHover` in VS Code.
- **Map nodes**: resting on a result in the map (small or large) previews its
  statement.

## Finding your way: Navigate, Go to, Uses

The **Navigate** button (<kbd>Ctrl+F</kbd> / <kbd>Ctrl+G</kbd>) opens a bar
with three tabs:

- **Find**: search the text. Matches are highlighted; <kbd>Enter</kbd>,
  <kbd>F3</kbd> next, <kbd>Shift+Enter</kbd>, <kbd>Shift+F3</kbd> previous. A
  short selection is used as the search when you open it.
- **Go to**: type `Lemma 4.1`, `(3.2)`, `§2`, `Fig. 3` or part of a name and
  pick from the list.
- **Uses**: what a result uses and what uses it, or a search by structure.
  - With nothing typed it lists every theorem, lemma and definition ("uses 3 ·
    used in 5"). Pick one, or type its number or part of its name (`Lemma 2`,
    `(3.1)` for an equation), and you get two lists: **Uses** (what it rests
    on, directly or through other results) and **Used by** (everything that
    rests on it). Other results that match what you typed are listed below;
    pick one to see its lists instead.
  - Picking the result itself starts
    [What does this use?](#understanding-the-logic) on it, both ways. Picking
    one from **Uses** lights up what the result uses, starting at the one you
    picked; picking one from **Used by** lights up everything that uses it,
    starting there.
  - Combine names to search by structure, for every result that uses them:
    several, separated by commas or `and`, for results that use all of them;
    `Lemma 2 or Lemma 3` for either; `but not`, `not`, `without` or `except`
    leaves out every result that uses what follows:
    `Theorem 1 but not Assumption A`. A single term can be left out as
    `-Lemma 3`, and `not Assumption A` alone lists every result that doesn't
    need the assumption.
  - **Directly** (or typing `directly`) counts only the links written in a
    result itself, not what it uses through other results.

  A search counts what it found ("3 results use Lemma 2 but not Assumption
  A"). Picking one lights them all up in the text, with **Hide the rest** on,
  starting at the one you picked; the bar steps through them, **Change**
  reopens the search, **Done** or <kbd>Esc</kbd> ends it. A map on show
  lights up the same results. The search follows the same links as the
  [Map](#the-side-panel-contents-map-notation): your own links and
  `\tguses` hints count, links you took away don't.

Web viewer links can go straight to a result: `?arxiv=<id>&goto=Theorem 4.1`.

### Back to where you were

Every jump remembers where you were reading: clicking a reference or a
citation, an entry in **Contents**, a result on the **Map** (double-click, or
**Go there**) or in the notation
index, **Go to**, **Uses**, the first match of **Find**, **Go there** in a
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

**Contents** (the toolbar button with three lines; VS Code: **TeXglass: Show or Hide Contents**)
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
  - Drag the background to pan. **Show what it uses** starts "What does this
    use?" there.
  - <kbd>M</kbd> (or **Larger map**; VS Code: **TeXglass: Show Larger
    Dependency Map**) opens the map filling the window: drag to move, Ctrl +
    scroll or pinch to zoom, or **−**, **100%**, **+**, **Fit** (keys
    <kbd>−</kbd> <kbd>+</kbd> <kbd>0</kbd> <kbd>F</kbd>).
  - **Editing the map** (see [Pins and your own map](#pins-and-your-own-map)):
    drag a result to move it, pin results and equations, hide results, and
    draw your own links or take wrong ones away. **Lock** stops all of that
    (pins still work).
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

### Pins and your own map

The map is drawn from the paper, but you can make it yours. Everything below is
kept per paper with your notes, so it is exported, imported and synced with them
(gist, browser sync, VS Code's `paper.texglass.json` and Settings Sync).

- **Undo** and **Redo** (the ↶ ↷ buttons above the map, or <kbd>Ctrl+Z</kbd>
  and <kbd>Ctrl+Shift+Z</kbd>) take back or redo each change: a drag, a pin,
  a hidden result, a link, a saved map. After each change a short note says
  what happened ("Hid Lemma 2") with an **Undo** button.
- **Reset map…** puts the map back as the paper has it: TeXglass's layout,
  nothing hidden or pinned, only the paper's links. It asks first, **saved
  maps stay** as they are, and Undo brings everything back.
- **Move**: drag a result (or a cited work) to where you want it; on a touch
  screen hold your finger still for a moment first, so a swipe still scrolls.
  <kbd>Alt</kbd> + arrow keys move the focused result. **Reset layout** puts
  everything back.
- **Pin**: pick a result on the map and choose under **Pin**: **It** (just
  the result), **+ uses** (with everything it uses, directly or not), **+ used
  in** (with everything that uses it) or **+ both**. Pinned results get a pin on
  the map; what a pin brings along gets a dashed outline. You can also pin from
  the text: a pin appears by a result's heading when you rest on it, and
  **Pin** on the "What does this use?" bar pins the result with what is lit.
- **Pin an equation**: rest on a numbered equation and click the pin that
  appears at its left (or tick it in **Show pinned results**). A pinned equation
  shows on the map as a small round node, linked to the results that refer to
  it. Equations a result's statement or proof refers to come along with a
  **+ uses** pin anyway.
- **Show pinned**: on the map, or **Show pinned results…** in the … menu
  (VS Code: **TeXglass: Show Pinned Results…**), shows only what is pinned,
  with the headings of their sections and the title; the rest is hidden. Proofs
  come along folded to their first line; click one to open it. **Print** prints
  exactly that view. **Change** lets you pin or unpin by ticking results and
  equations in the text; **Done** or <kbd>Esc</kbd> shows the whole paper.
  With nothing pinned, the menu item starts with the ticking.
- **Save** the pins under a name (**Save as…** above the map; a name is
  suggested, such as "Theorem 2 with what it uses", which you can type over):
  the saved maps are listed beside **Saved**; click one to pin exactly those
  again, **×** deletes it. The saved map whose pins are showing is
  highlighted; once you change those pins, **Update “name”** keeps the new
  pins under the same name. **Unpin all** clears the pins, not the saved maps.
- **Hide**: **Hide from map** leaves a result off the map. **Hidden (n)**
  above the map draws the hidden ones faded, so you can pick one and **Show on
  map** again.
- **Your own links**: pick a result, then **+ It uses…** or **+ Used in…** and
  pick the other result on the map (every result shows while you do, linked or
  not). Your links are drawn in a dashed accent line and count everywhere a
  link counts: "What does this use?", **Uses**, previews and pins. **Remove…**
  puts a **×** by each link to take it away (the paper's links come back with
  **Restore**).
- **Lock** (checkbox above the map) stops dragging, hiding and link changes
  until you untick it; it is remembered for every paper.

### Everything pinned in one place

The **pin** in the toolbar (web viewer, browser extension and the Overleaf
panel; in VS Code it floats at the top right of the preview once something is
pinned) shows how many things are pinned, and a click lists them all, grouped:

- **Results** and **Equations** pinned on the map, from the text, or with the
  pin on a reference's preview (a result pinned with what it uses says so);
- **Proofs**: rest on a proof and click the pin at its top right; under
  **Show only these** a pinned proof shows in full, not folded;
- **Figures** (and tables with a caption): rest on one and click the pin at its
  top right, or the pin on its reference's preview;
- **Notation**: symbols and macros pinned in the **Notation** tab or with the
  pin on a notation preview;
- **Text**: passages pinned with the pin on the bar that appears when you
  select text (see [Your own highlights and notes](#your-own-highlights-and-notes)).

Click an item to jump to it, **×** to unpin it. **Show only these** shows only
the pinned results, proofs, equations and figures (as **Show pinned** does) and the
paragraphs holding pinned text, and prints just that. With nothing pinned
the list says how to pin. <kbd>Esc</kbd> or a click outside closes it; on a phone
it opens as a sheet at the bottom, from **Pinned** in the **…** menu. Pins are
kept with your notes, so they sync with them (in the Overleaf panel they stay in
this browser).

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
- **Uses** in the Navigate bar: the same, chosen by name, with what a result
  uses and what uses it as two lists; or every result that uses a given
  lemma, assumption or equation, and not another; see
  [Uses](#finding-your-way-navigate-go-to-uses).
- **Step through a proof.** The **Step through** button by a proof's heading
  shows the proof one sentence at a time, like a slide reveal (a list item
  is a piece of its own too). Works on any paper; the author changes
  nothing.
  - <kbd>→</kbd>, <kbd>Space</kbd>, **Next** or a click (a tap) on the proof's
    text shows the next piece; <kbd>←</kbd> or **Back** goes back. The bar
    under the proof stays in view and counts the pieces ("5 / 20").
  - The piece just shown is highlighted; the rest of the proof is hidden until
    you get there.
  - **Nested parts** open while you step through them and fold to their first
    line once you are past them: a claim with its own proof, a proof inside
    the proof, a paragraph starting "Case 1.", "Step 2:", "Part (ii)." and
    what follows it, a long list item. **▸ 3 more** opens a folded part
    again; **▾ fold** folds it.
  - References and citations show their usual previews while you step
    (on hover, or a bottom sheet when you tap one on a phone), so you can
    look up a lemma without leaving your place. <kbd>Esc</kbd> closes an open
    preview first.
  - **Show all**, <kbd>Esc</kbd>, **Stop** on the heading, or **Done** after
    the last piece ends it and shows the whole proof again. Folding the proof
    ends it too. Proofs with fewer than three pieces have no button.
  - A piece ends only at a full stop (or ! or ?), never at a comma or a
    formula: a displayed equation stays with the sentence it belongs to, and
    so does the text after it ("…, where …") until the full stop, which may
    be the one ending the equation. Full stops after "e.g.", "Lemma 2.",
    initials and the like don't count. An author using `texglass.sty` can
    mark the pieces with `\tgstep`; a proof with such marks is cut only
    there.
  - Settings: **Step through proofs**. VS Code: `texglass.stepThroughProofs`.
- **Show pinned results**: see only the results and numbered equations you
  pinned (see [Pins and your own map](#pins-and-your-own-map)). Start it from
  the map's **Show pinned**, the … menu (web viewer) or **TeXglass: Show
  Pinned Results…** (VS Code, also in the preview's `…` menu).
  - With nothing pinned yet, every result and numbered equation gets a tick
    box; click one to pin it, again to unpin it. **Show pinned** shows only
    those, with the headings of their sections and the paper's title.
  - The proof of a shown result comes along folded to its first line. Click
    it to open it; its fold arrow folds it again.
  - **Print** on the bar prints exactly that view, to a printer or as a PDF:
    the pinned results and equations, and only the proofs you opened. For
    example, pin Theorem 1 with what it uses and (3.4), open the proof of
    Theorem 1, and print. <kbd>Ctrl+P</kbd> (web viewer) and **TeXglass:
    Print / Save as PDF** print the view too.
  - **Change** goes back to ticking; **Done** or <kbd>Esc</kbd> shows the
    whole document again.
- **Hypothesis checker** and **cited theorems**: see
  [Previews on hover](#previews-on-hover).
- **Reading progress**: see [Reading a paper](#reading-a-paper).

## Comparing versions

See what changed between two versions of a paper, block by block: theorems,
proofs, equations, headings and paragraphs are matched by their `\label`, their
heading or their place in the text, not line by line, so a result that moved
or was renumbered is still the same result.

- **Web viewer**: **… → Compare versions…**. For an arXiv paper, pick two
  versions (v1, v2, … with their dates); the newer one opens and what changed
  since the older one is marked. For any document, **choose the earlier
  file** to compare with a `.tex` file from your computer, such as an earlier
  draft. A link like `?arxiv=2106.10340v2&compare=v1` opens a comparison
  straight away.
- **Browser extension**: *Compare v1 → v2* on arXiv abstract pages of papers
  with more than one version (the version shown against the one before it).
- **VS Code**: **TeXglass: Compare with Last Commit** compares the preview
  with the document (and its `\input` files) as it was in git `HEAD`, and
  **TeXglass: Compare with Another Version…** with any `.tex` file. The marks
  follow your edits as you type; **TeXglass: Stop Comparing** ends it.

What you see:

- **Changed** blocks get an amber bar, with the new words and formulas marked
  in green. The tag on them (*Changed · show v1*) opens the old version
  underneath, its removed words struck through in red.
- **New** blocks get a green bar; **removed** ones stay where they were, as a
  folded red box: click its tag to read it. **Moved** blocks (the same label
  somewhere else) get a purple bar.
- The **bar at the bottom** counts the changes; **‹ ›** step through them,
  the list jumps to one by name (*Theorem 2.3 (changed)*, *Proof of Lemma 4.1
  (changed)*, *Equation (3.2) (new)*, *Text in §2 (removed)*), **Only
  changes** hides everything that did not change (headings stay), and **×**
  stops comparing.

## Your own highlights and notes

In the web viewer, the browser extension's viewer and VS Code (not the
Overleaf panel).

- **Highlight**: select text and pick a colour (yellow, green, pink, blue)
  from the bar that appears below the selection; click a highlight to recolour
  or remove it. The bar stays clear of the system's own menu (copy, look up,
  share), which opens above the selection; on a phone or tablet it also sits
  below the selection handles, and appears once a long press has selected.
- **Pin**: the pin on that bar pins the selected text (it is highlighted
  yellow unless it already has a colour), so it shows under **Text** in the
  toolbar's **Pinned** list; click there to come back to it. Click a pinned
  highlight and the pin again to unpin it (the highlight stays). Pinned text
  syncs with your notes.
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
| | Step through proofs | The **Step through** button by each proof. |
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

- **Open** (the folder button, <kbd>Ctrl+K</kbd>) is one dialog for everything:
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
- **OAI preprints…** (at the top of the **…** menu) lists the manuscripts in
  [openai/math](https://github.com/openai/math), searchable and filtered by
  discipline.
- **Take the tour**: on the welcome page, at the end of the **…** menu, or
  `?tour`. It opens [`examples/tour.tex`](../examples/tour.tex), a short paper
  on Grönwall's inequality whose **Try it** notes say what to try at each step:
  previews, the hypothesis checker, stepping through proofs, What does this
  use?, the map, notation, cited theorems, margin notes and the
  `texglass.sty` hints. It also compiles with pdfLaTeX, without the notes.
- **Links**: `?arxiv=2301.00001` (add `&goto=Theorem 4.1` to land on a
  result), a bare `?arxiv` for the search dialog, `?gh=<GitHub link>`,
  `?preprint=<folder>`, `?tour`. A **bookmarklet** in the Open dialog opens the GitHub
  page you are on.

**Sharing a paper**

- **Share** (in the toolbar) gives a link that opens the paper in the
  [web viewer](https://klepo0.github.io/TeXglass/), at the section you are
  reading: `?arxiv=2301.00001&goto=§2.3`. On a computer it is copied to the
  clipboard; on a phone or tablet the system share sheet opens, to send it by
  message, mail or any app.
- It works for papers from arXiv and GitHub, also when opened from a saved copy
  or in the browser extension's own viewer (the link always points at the
  website). A file from this computer has no public link, so the button is
  greyed out.
- **Share what you see.** When a view is on, the link opens the paper with the
  same view instead of at a section: **Show only these** with your pinned
  results, equations, figures and text passages (and the proofs you opened in
  it), **What does this use?** (or what uses it), with **Hide the rest** or
  without, or a search by use. The bar of **Show only these** has its own
  **Share** button too. The view rides along in the link as `&view=…`.
- Whoever opens such a link sees a **Shared view** bar. Their own pins stay as
  they are: **Keep these pins** adds the shared ones to theirs, **Dismiss** (or
  <kbd>Esc</kbd>) goes back to the whole paper. Sharing again from a shared view
  passes it on unchanged. If the paper has changed so much that nothing in the
  view is found, the whole paper opens.

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

**The … menu**, in groups:

- **Papers**: **OAI preprints…**, **Saved papers…**, **Save for offline** (see
  above) and **Compare versions…** (see [Comparing versions](#comparing-versions)).
- **Save and export**: **Save** (<kbd>Ctrl+S</kbd>, back to the file, with live
  reload when it changes on disk in Chrome and Edge), **Print or save as PDF**
  (<kbd>Ctrl+P</kbd>; prints what the page shows, so pinned results or **Hide the
  rest** prints as shown), **Export as HTML** (one standalone page that works
  offline), **Export with reading tools** (the same page with reference previews,
  notation on hover, the side panel and Navigate; see [Command line](#command-line)
  for what it holds) and **Export as EPUB** (an e-book for e-readers; see
  [E-books (EPUB)](#e-books-epub)).
- **Reading**: **Show pinned results…** (see
  [Understanding the logic](#understanding-the-logic)), **Highlights and notes**
  and **Reading progress**.
- **Your notes**: **Sync notes with GitHub…** (**Syncing with GitHub…** once
  signed in), **Export notes** and **Import notes…**.
- **For authors**: **Copy AI prompt for authors** (see
  [Let an AI chatbot suggest the hints](#let-an-ai-chatbot-suggest-the-hints)).
- At the very end, **Take the tour** (see above).

**☕ Support** beside the TeXglass name in the toolbar opens its
[Buy Me a Coffee](https://buymeacoffee.com/texglass) page (on a phone, where the
name is hidden, it is **Support TeXglass ☕** at the end of the **…** menu).

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
- **On arxiv.org**: *View in TeXglass* on abstract pages (and *Compare v1 →
  v2* when the paper has more than one version, see
  [Comparing versions](#comparing-versions)), a *texglass* link in listings,
  and a floating button on HTML papers.
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
- Click a formula to copy it, hover previews, folding and **Hide proofs**,
  **Contents** (left or right), the **pin** with everything pinned (see
  [Everything pinned in one place](#everything-pinned-in-one-place)), **Navigate** (<kbd>Ctrl+F</kbd>,
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
  (`texglass.exportEmbedFonts`). **Export to EPUB**: an e-book (see
  [E-books (EPUB)](#e-books-epub)). **Print / Save as PDF**, laid out like a paper.
- Title-bar buttons: Navigate, Contents, Hide/Show proofs, handwriting,
  Settings (gear), light/dark, scroll sync; the `…` menu has the rest. Once
  something is pinned, a **pin** at the top right of the preview lists it all
  (see [Everything pinned in one place](#everything-pinned-in-one-place)).

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
| Compare with Last Commit | Mark what changed since git `HEAD` (see [Comparing versions](#comparing-versions)). |
| Compare with Another Version… | Mark what changed since another `.tex` file. |
| Stop Comparing | Remove the marks. |
| Go Back in Preview | Back to where the preview was before a jump (<kbd>Alt+Left</kbd>). |
| Go Forward in Preview | Forward again (<kbd>Alt+Right</kbd>). |
| Show Notation Index | The Notation tab. |
| Show Dependency Map of the Results | The Map tab. |
| Show Larger Dependency Map | <kbd>M</kbd> in the preview. |
| Show Pinned Results… | Show (and print) only the pinned results and equations; with none pinned, tick some first. |
| Export to HTML | A standalone page. |
| Export to EPUB | An e-book for e-readers; with the preview open, its diagrams and PDF and EPS figures come along everywhere. |
| Print / Save as PDF | Laid out like a paper, in the browser; prints what the preview shows (pinned results, or **Hide the rest**). |
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
| `texglass.stepThroughProofs` | `true` | The "Step through" button by each proof. |
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
`-h` or `--help` prints the usage. `npx texglass --sty` copies
[`texglass.sty`](#hints-for-texglass-in-your-own-papers) into the current
folder, and `npx texglass --ai-prompt` prints the
[prompt for an AI chatbot](#let-an-ai-chatbot-suggest-the-hints) that suggests
its hints.

`--reader` (or **Export with reading tools** in the web viewer's **…** menu)
adds the reading tools to the page, about 650 KB more, still one file that
works offline:

- previews of references, citations and footnotes on hover (a sheet on touch
  screens), with what each result uses and where it is used;
- notation on hover and **What does this use?** by each result;
- the side panel with **Contents**, **Map** and **Notation**;
- **Navigate**: <kbd>Ctrl+F</kbd> to find, <kbd>Ctrl+G</kbd> to go to a
  number, **Uses** (what a result uses and what uses it, or search by what results use); **Back** and **Forward** after a jump;
- click a formula to copy its LaTeX; light and dark.

Cited papers' titles and abstracts show when the page is online. Your own
highlights and notes, saved papers, cited-theorem previews and the hypothesis
checker stay in the viewer. The page remembers only the side panel's choices,
in the browser that opens it.

## E-books (EPUB)

**Export as EPUB** (web viewer, **…** menu), **TeXglass: Export to EPUB** (VS
Code) and `npx texglass paper.tex --epub` (command line, writes `paper.epub`)
make an EPUB 3 e-book for Apple Books, Kobo, Thorium, Calibre, Google Play
Books or a Kindle (send it with Send to Kindle).

- Formulas are MathML, which is text: they grow with the e-reader's font size
  and stay sharp. Letters in `\mathbb`, `\mathcal`, `\mathbf` and the like
  become Unicode's maths letters, which every reader has.
- Each top-level section is a chapter, and the e-reader's contents list the
  sections. References, citations and footnotes stay links; footnotes open as
  pop-ups in readers that do that.
- Figures go inside the book (PNG, JPEG, GIF, SVG and WebP; PDF and EPS ones
  are drawn as images first, in the web viewer and in VS Code with the preview
  open).
- Diagrams (`tikzcd`, `xymatrix`, TikZ) are drawn as in the viewer and scale
  with the text. The web viewer, and VS Code with the preview open, draw them
  before they go in, so they show in any reader; the command line and VS Code
  without the preview leave the drawing to a script, which Apple Books,
  Thorium and Calibre run.
- Colours are left to the e-reader, so its day, sepia and night modes work.

MathML shows best in Apple Books, Thorium, Calibre and most EPUB 3 apps.
E-ink readers (Kobo, Kindle) have weaker MathML support, so formulas may look
plainer there; try a short paper first.

## On phones and tablets

The web viewer adapts to a phone or a tablet. Nothing needs switching on.

**Install it like an app.** On an iPhone or iPad, open the site in Safari, tap
Share, then **Add to Home Screen**. On Android, or in Chrome or Edge, choose
**Install TeXglass as an app** in the **…** menu when it appears there. Opened
from the home screen it has no browser bars and works offline after the first
visit, like the web viewer anywhere.

**Sharing.** **Share** in the toolbar opens the phone's share sheet with a link
that opens the paper in TeXglass, at the section you are reading, or with the
view you have on (**Show only these**, **What does this use?**).

**Papers to read offline.** Before a trip, open each paper and tap the bookmark
in the toolbar (**Save offline**). The **Open** dialog lists the recent ones and
**Saved papers…** in the **…** menu lists them all; they open with no connection, figures included (see [Saving papers for
offline reading](#web-viewer)).

**A compact toolbar (windows up to 760px wide).** The toolbar is one row of
large buttons: **Open**, the side panel (the three lines), **Navigate** (the
magnifier), **Save offline** (the bookmark), **Share**, the theme toggle
and **…**. The mode switch (Preview, Edit, Split), zoom, **Hide proofs**,
**Pinned**, **Edit on GitHub**, **Settings** and **Handwritten notes** move to the top of the
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
citations, footnotes, notation and the map's results. When you step through a
proof, tap its text to show the next piece; a tap on a reference opens its
preview instead.

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
  [Settings](#settings-switching-features-on-or-off) to stop that. Notes sync goes only to your own GitHub gist. **Compare
  versions** asks DataCite for the list of a paper's arXiv versions when you
  open its dialog.
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
  paper's own `.sty` files when imported from arXiv. Shortcuts for half an
  environment (`\def\be{\begin{equation}}` … `\ee`) work, and TeX
  conditionals in macros (`\ifx`, `\ifmmode`, `\ifnum`, flags made with
  `\newif`, `\iffalse … \fi` around text) show only the branch TeX would
  take. A paper that redefines a standard symbol with low-level TeX keeps the
  usual symbol.
- **Text in formulas**: `\mbox`, `\text`, `\parbox`, `\textsc` and
  `\footnote` inside maths, with `$…$` of their own.
- **Plain TeX**: `\eqno` and `\leqno`, `\buildrel … \over`, `\eqalign`,
  `\displaylines`, `\centerline`, `\romannumeral`, names made with
  `\csname … \endcsname`; page sizes and spacing (`\textwidth 16cm`,
  `\vskip 2pt plus 1pt`) are skipped without leaving their sizes in the text.
- **Theorems**: `\newtheorem` in all its forms, `\theoremstyle`, `proof` ∎.
- **Numbering and references**: sections, `\appendix`, `\numberwithin`,
  enumerate and enumitem labels, figures, tables; `\ref`, `\eqref`, `\cref`
  (capitalised with cleveref's `capitalise` option), `\Cref`, `\autoref`,
  `\nameref`.
- **Structure**: `\maketitle`, abstract (placed under the title in `amsart`, as LaTeX does), lists, footnotes, `tabular`,
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

## Hints for TeXglass in your own papers

TeXglass reads any paper as it is. If you write papers, lecture notes or
notes for a reading group, the optional package `texglass.sty` lets you tell
it a little more. Ordinary LaTeX (pdfLaTeX, LuaLaTeX, XeLaTeX) ignores every
command in it, so your PDF comes out exactly as without the package.

To use it, put [`texglass.sty`](../latex/texglass.sty) next to your `.tex` file
(`npx texglass --sty` copies it into the current folder) and add
`\usepackage{texglass}`. When you post to arXiv, upload it with the paper;
TeXglass reads the commands itself either way.

| Command | In TeXglass | In LaTeX |
| --- | --- | --- |
| `\tgdefine{L^p}{the space of $p$-integrable functions}` | What a symbol means: notation on hover shows it (as **The author's description**) and the **Notation** tab lists it, searchable by its words. It comes before what TeXglass reads from the text. In the preamble it holds for the whole paper; in the text, from that point on (inside a proof, for that proof). The symbol is TeX, with or without `$…$`. | Nothing |
| `\tguses{lem:key}` or `\tguses{lem:a,thm:b}` | Links on the **Map** that the text doesn't state: put it in a result's statement or proof, and that result uses the labelled ones (also in **Uses** searches). | Nothing |
| `\tgstep` or `\tgstep[title]` | Marks where a new step of a proof starts, with an optional title, for stepping through the proof: a proof with these marks is split at them (and at displayed equations, list items and claims) rather than at sentences. | Nothing |
| `\tghide{…}`, `\begin{tghide}…\end{tghide}` | Left out. | Shown |
| `\tgonly{…}`, `\begin{tgonly}…\end{tgonly}` | Shown. | Left out, unread (so it may hold commands LaTeX doesn't know; a `tgonly` can't hold another) |
| `\iftexglass … \else … \fi` | The first branch. | The `\else` branch |
| `\tgparam[start]{p}{1}{4}`, `\tgvalue{p}` | A parameter readers may vary between 1 and 4 with a slider: see [Live parameters](#live-parameters). | `\p` and `\tgvalue{p}` print the start value |

The package is free to share under the LaTeX Project Public License, so it can
go into your paper's sources and onto arXiv with them.

[`examples/tour.tex`](../examples/tour.tex), the paper behind **Take the
tour**, uses every command above: its **Try it** notes are `tgonly`, its
pointer to the viewer is `tghide`, and it has `\tgdefine`, `\tguses`,
`\tgstep` and `\tgparam` in place.

### Live parameters

Declare a parameter with `\tgparam[start]{name}{min}{max}`, for example
`\tgparam[2]{p}{1}{4}`, and TeXglass shows a slider for it by every
paragraph, formula and TikZ picture that uses it. Dragging it changes the
value everywhere at once and redraws those formulas and pictures; works in
the web viewer, the VS Code preview and the Overleaf panel.

- **Using the value**: write `\p` (`\tgparam` defines it as the start value
  at `\begin{document}` unless you define `\p` yourself), or `\tgvalue{p}`,
  which always works, also in `\pgfmathsetmacro` and TikZ coordinates.
  Macros of yours built on them count too: with
  `\newcommand\norm[1]{\|#1\|_{L^{\p}}}`, every `\norm{f}` follows the slider.
- **TikZ pictures** that use `\p` are drawn again as you drag, including
  `\pgfmathsetmacro{\b}{2*\p}`, `plot` functions and node labels. A
  picture's own `\def\p{1.5}` sets where the slider starts; the slider then
  overrides it.
- **Options**: `\tgparam[start=2, step=0.5, label={$p$}]{p}{1}{4}` sets the
  slider's step (by default about a hundredth of the range) and its label
  (by default the name, in maths).
- **Reset** on a row of sliders puts the paper's values back. Moved values
  stay while you edit the document.
- **In the PDF** every use shows the start value (the minimum if there is
  none), the same as TeXglass before you touch a slider. Pick a name LaTeX
  doesn't already use (not `\a`, `\r`, `\alpha` …), or use `\tgvalue`.
- Exported HTML pages, EPUB and print show the start values, without sliders.

### Let an AI chatbot suggest the hints

[`latex/AI-PROMPT.md`](../latex/AI-PROMPT.md) holds a ready-made prompt: paste
it into an AI chatbot (Claude, ChatGPT, Gemini, …) with your `.tex` file, and
it answers with a block of `\tgdefine` lines for your preamble and a numbered
list of `\tguses` and `\tgstep` commands, each with the exact place it goes
("right after `\label{lem:young}`"). It is told not to touch your maths or
wording and to leave out anything it would have to guess, so your PDF stays
the same; read its suggestions before you paste them. Get the prompt from
**Copy AI prompt for authors** in the web viewer's **…** menu, from that page,
or with `npx texglass --ai-prompt`.

## Render dashboard

Every night the [render dashboard](https://klepo0.github.io/TeXglass/dashboard/)
opens about 200 arXiv papers in the web viewer and lists what broke: maths
KaTeX could not render, missing figures, undrawn diagrams, papers that froze,
and slow loads, with what changed since the night before. See [dashboard/README.md](../dashboard/README.md).
