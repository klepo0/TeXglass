# texglass: hints for TeXglass that LaTeX ignores

`texglass.sty` is an optional LaTeX package for authors whose papers or notes
will also be read in [TeXglass](https://klepo0.github.io/TeXglass/), which
shows LaTeX documents as interactive web pages. TeXglass works on any paper
as it is; this package only lets you tell it a little more. Ordinary LaTeX
(pdfLaTeX, LuaLaTeX, XeLaTeX) ignores every command, so the PDF comes out
exactly as without the package.

```latex
\usepackage{texglass}

\tgdefine{L^p}{the space of $p$-integrable functions}  % notation hovers and index
\tguses{lem:key}                % a dependency-map link the text doesn't state (Map, Uses search)
\tgstep[Reduce to balls]        % a step of a proof, for step-through mode
\tghide{PDF only} \tgonly{web only}
\begin{tgonly} ... \end{tgonly} % also: tghide environment, \iftexglass ... \else ... \fi
\tgparam[2]{p}{1}{4}            % a parameter readers vary with a slider
\tgvalue{p}                     % its value; \p holds it too, unless you define \p
```

With `\tgparam`, TeXglass shows a slider by every formula and TikZ picture
that uses `\p`, `\tgvalue{p}` or a macro of yours built on them, and redraws
them as the reader drags. `\tgparam[start=2, step=0.5, label={$p$}]{p}{1}{4}`
sets the step and the slider's label too. LaTeX prints the start value (the
minimum if there is none), so the PDF shows what TeXglass starts at. If you
define `\p` yourself (`\def\p{2}` or `\pgfmathsetmacro`, also inside a
picture), that definition counts, and the slider overrides it. Pick a name
LaTeX doesn't already use (not `\a`, `\r`, `\alpha` …), or use `\tgvalue`.
The package loads `keyval`, which every LaTeX installation has.

To have an AI chatbot suggest these hints for a whole paper, give it the
prompt in [AI-PROMPT.md](AI-PROMPT.md) with your `.tex` file
(`npx texglass --ai-prompt` prints it).

The full description is in the
[TeXglass guide](https://github.com/klepo0/TeXglass/blob/main/docs/GUIDE.md#hints-for-texglass-in-your-own-papers).

Get the file by putting `texglass.sty` next to your `.tex` file (or running
`npx texglass --sty` there). When you post to arXiv, upload it with your
paper.

## Licence

`texglass.sty` and this README may be distributed and/or modified under the
conditions of the LaTeX Project Public License, version 1.3c or later
(https://www.latex-project.org/lppl.txt). The rest of TeXglass has its own
licence (see `LICENSE` at the top of the repository).
