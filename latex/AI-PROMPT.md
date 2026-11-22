# A prompt for adding texglass.sty hints with an AI chatbot

[`texglass.sty`](texglass.sty) lets you tell TeXglass what your symbols mean
(`\tgdefine`), which results a result uses when the text doesn't cite them
(`\tguses`) and where the steps of a long proof start (`\tgstep`). Writing
these by hand for a whole paper takes a while, so here is a prompt that asks
an AI chatbot (Claude, ChatGPT, Gemini, …) to suggest them for you.

1. Copy the prompt below (the copy button on the code block, the **Copy AI
   prompt for authors** item in the web viewer's **…** menu, or
   `npx texglass --ai-prompt`).
2. Paste it into the chatbot and attach or paste your `.tex` file under it.
3. The chatbot answers with a block for your preamble and a numbered list of
   commands to insert, each with the exact place it goes ("right after
   `\label{lem:young}`"). Copy them into your file.
4. Put `texglass.sty` next to your `.tex` file (`npx texglass --sty`) and
   compile. The PDF looks exactly as before; open the file in TeXglass to see
   the hints at work: notation on hover, the **Notation** tab, the **Map**,
   and **Step through** on proofs.

Read the suggestions before you paste them: you know your paper and the
chatbot doesn't. They only add commands that LaTeX ignores, so the worst a bad
one can do is give a hover a poor description or the map a wrong link. If you
let the chatbot edit the file itself, compare the result with your original
(for example `git diff` or `latexdiff`): the only changes should be added
`\usepackage{texglass}` and `\tg…` lines.

See the [guide](../docs/GUIDE.md#hints-for-texglass-in-your-own-papers) for
what each command does.

## The prompt

<!-- ai-prompt:start -->
````text
You are helping the author of a LaTeX paper add hints for TeXglass, a viewer
that shows LaTeX papers as interactive web pages. The hints come from the
package texglass.sty. LaTeX ignores every one of its commands, so the PDF
stays exactly the same; TeXglass reads them. My .tex file is attached or
pasted below this prompt.

THE COMMANDS (use only these three)

1. \tgdefine{SYMBOL}{MEANING}
   Says what a symbol means. TeXglass shows the meaning when a reader hovers
   over the symbol in any formula, and lists it in its notation index.
   - SYMBOL is the TeX of the symbol written EXACTLY as the paper's formulas
     write it, with the paper's own macros (\R if the paper writes \R, not
     \mathbb{R}). TeXglass finds the symbol by matching this TeX against the
     formulas, so a different spelling matches nothing. No $ signs needed.
   - Leave out arguments: \tgdefine{\Gamma_\epsilon}{...}, not
     \Gamma_\epsilon(x,y). A one-letter subscript stands for any subscript:
     X_t also covers X_s and X_{t+1}.
   - MEANING is a short noun phrase of at most about 15 words, taken from
     the paper's own definition, with maths in $...$, e.g.
     \tgdefine{\norm{f}_p}{the $L^p$ norm of $f$, $(\int_X |f|^p\,d\mu)^{1/p}$}
     Do not put \ref, \cite, \label or footnotes in it.
   - Put a \tgdefine in the preamble when the symbol means the same thing
     in the whole paper: it then holds everywhere. One in the body holds
     from that point on, and one inside a proof only in that proof; use
     those for notation that is local or changes meaning.
   Define: notation the paper introduces and then uses later (spaces, norms,
   operators, constants, special functions, sets, recurring objects), and
   the paper's own macros for mathematical objects. Do NOT define standard
   notation every reader of the field knows (\R, \sum, \int, \nabla,
   \mathbb{E}, \log, ...), bound variables, or symbols used only once
   right where they are defined.

2. \tguses{LABEL} or \tguses{LABEL1,LABEL2}
   Adds links to TeXglass's dependency map ("this result uses that one").
   TeXglass already links every \ref, \eqref, \cref, \autoref inside a
   result and inside the proof environment that follows it, so add \tguses
   ONLY where a result or its proof relies on another labelled result that
   TeXglass cannot see:
   - the dependency has no \ref: "by the previous lemma", "as in the proof
     above", "by Lemma 2.3" typed as plain text, a step that clearly needs
     an earlier result without naming it;
   - or the proof is not a proof environment right after the result (for
     example a later "Proof of Theorem 3" section or paragraph): then the
     results that proof cites belong to the result itself.
   Rules for \tguses:
   - Each LABEL must be the key of an existing \label on a theorem, lemma,
     proposition, corollary, definition or similar environment in this
     file, copied exactly. The key is the part in braces:
     \label[lemma]{lem:x} has the key lem:x. Never invent a label.
   - Put it right after the \label of the result that does the using, or
     right after \begin{proof} of its proof.

3. \tgstep or \tgstep[TITLE]
   Marks where a new step of a proof starts, for TeXglass's "step through"
   mode. A proof that has any \tgstep is cut ONLY at the marks, so mark the
   start of EVERY step of that proof, the first one included (right after
   \begin{proof}).
   - Only for proofs of about 15 lines or more with a clear structure:
     "Step 1", "First", "Next", "Finally", "Case 1", "Claim", a reduction
     followed by an estimate, and so on. Leave short proofs alone.
   - TITLE: optional, at most 6 plain words (no maths), from the paper's
     wording where possible, e.g. \tgstep[Reduce to balls]. If the title
     contains ] put it in braces: \tgstep[{Bound on the interval [0,1]}].
   - Put it right before the first words of the sentence that begins the
     step, never inside maths, an equation or an align.
   - If the proof already has headings such as \textbf{Step 1.} or
     \emph{Case 2:}, put \tgstep[...] right before each of them.

RULES
- Do not change, fix, reword or reformat anything in the paper: no maths, no
  wording, no labels, no macros, no layout. You only ADD commands.
- Be conservative: a hint you are not sure about is worse than no hint.
  Leave out anything you would have to guess.
- Every argument must have balanced braces and no blank line in it. Write %
  as \% and # as \#.
- Ignore commented-out text (after %) and anything inside \iffalse ... \fi.
- Do not use \tgparam, \tghide, \tgonly or \iftexglass.
- If the paper already uses \usepackage{texglass} or some \tg... commands,
  keep them and do not repeat them.
- If the file is too long for one answer, stop after a complete item, say
  where you stopped, and continue when I write "continue".

OUTPUT (exactly this, nothing else)

Part A, the preamble block, to paste on the lines right before
\begin{document}:

```latex
\usepackage{texglass}
\tgdefine{...}{...}
...
```

Part B, a numbered list of insertions in the order they appear in the file.
For each one give:
  - Where: "right after" or "right before", then an ANCHOR: an exact piece
    of ONE line of the file, copied character for character, that occurs
    only once in the file (a \label{...} is ideal; for a step, the first
    words of its sentence). The insertion goes on the same line, directly
    after or before the anchor.
  - What: the command(s) to insert, in a ```latex block.
  - Why: one short sentence.
For example:
  3. Where: right after \label{thm:main}
     What:
     ```latex
     \tguses{lem:young}
     ```
     Why: the proof applies Young's inequality without referring to it.

Part C, at most five lines: anything you chose to leave out and would like
me to decide.
````
<!-- ai-prompt:end -->
