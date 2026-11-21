# Render dashboard

Every night `.github/workflows/render-dashboard.yml` opens each paper in
[papers.json](papers.json) in the web viewer (`index.html?arxiv=<id>`, the same
import path people use) in headless Chromium and records:

- maths KaTeX could not render (undefined macros, parse errors),
- figures that are missing or did not load,
- diagrams shown as a placeholder and TikZ pictures only partly drawn,
- text commands the converter does not know (listed, but they do not make a paper fail),
- papers that never finished rendering (2 minutes) or took longer than 20 seconds.

The results go to the `render-dashboard` branch as `results.json`, and
[the dashboard page](https://klepo0.github.io/TeXglass/dashboard/) reads them
from there: the clean-render rate and median load time over time, newly broken
and newly fixed papers since the last run, how many papers have each kind of
failure, the macros, commands, figure types and packages affecting the most
papers, the slowest papers, and the clean-render rate by field and by year. The page can read another
results file with `?data=<url>`.

Paper sources are kept in the Actions cache, so arXiv sees each paper once. New
papers are downloaded one at a time, three seconds apart.

## Running it yourself

```sh
npm install --no-save playwright && npx playwright install chromium
node dashboard/run.js --only 1907.00578,2609.02755 --shots /tmp/shots
```

Options: `--out <dir>` (default `dashboard/out`), `--prev <results.json>` to
compare with an earlier run, `--only <id,id>`, `--limit <n>`, `--timeout <seconds>`,
and `--shots <dir>` for a screenshot of each paper. Sources are cached in
`.dashboard-cache/` (or `$DASHBOARD_CACHE`). To view local results, serve the repository
(`npm start`) and open `/dashboard/index.html?data=out/results.json`.

## The papers

`papers.json` holds the papers that rendered badly when someone opened them,
plus, for each of 38 arXiv categories in maths, physics and computer science and
each of the years 2004, 2011, 2017, 2022 and 2026, the first paper submitted in
March that has a LaTeX source. `node dashboard/pick-corpus.js > dashboard/papers.json`
rebuilds the list, but keep it fixed so nights compare like with like; add a paper
that renders badly by hand, with a `note`.
