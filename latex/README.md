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
\tgparam[2]{p}{1}{4}            % a parameter for live sliders (to come)
```

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
