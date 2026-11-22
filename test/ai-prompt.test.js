'use strict';
// latex/AI-PROMPT.md: the prompt authors give an AI chatbot with their .tex
// file to get texglass.sty hints. These tests keep it in step with the
// package and the converter: it names only commands texglass.sty defines,
// its own examples convert cleanly, and an answer in the format it asks for
// can be applied to a paper and is read by the converter. The paper is
// examples/sample.tex; the answer is made up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const TeXglass = require('../src/texglass.js');

const ROOT = path.join(__dirname, '..');
const MD = fs.readFileSync(path.join(ROOT, 'latex/AI-PROMPT.md'), 'utf8');
const STY = fs.readFileSync(path.join(ROOT, 'latex/texglass.sty'), 'utf8');
const PROMPT = /<!-- ai-prompt:start -->\s*````text\n([\s\S]*?)\n````/.exec(MD)[1];
const plain = (tex) => `<span class="m">${tex}</span>`;

test('the prompt names only what texglass.sty defines, and asks for the three hints', () => {
  const defined = new Set(Array.from(STY.matchAll(/\\newcommand\*?\\(tg[A-Za-z]+)/g)).map((m) => m[1]));
  for (const [, name] of PROMPT.matchAll(/\\(tg[a-z]+)/g)) assert.ok(defined.has(name), `\\${name} is not in texglass.sty`);
  for (const c of ['tgdefine', 'tguses', 'tgstep']) assert.match(PROMPT, new RegExp(`^\\d\\. \\\\${c}`, 'm'));
  assert.match(PROMPT, /Do not change, fix, reword or reformat anything/);
  assert.match(PROMPT, /\\begin\{document\}/); // where Part A goes
});

test('the examples in the prompt convert without warnings', () => {
  const lines = [
    '\\tgdefine{\\norm{f}_p}{the $L^p$ norm of $f$, $(\\int_X |f|^p\\,d\\mu)^{1/p}$}',
    '\\tgdefine{\\Gamma_\\epsilon}{a made-up meaning}',
    '\\tguses{lem:young}',
    '\\tgstep[Reduce to balls]',
    '\\tgstep[{Bound on the interval [0,1]}]',
  ];
  for (const l of lines) if (!/made-up/.test(l)) assert.ok(PROMPT.includes(l), l);
  const doc = ['\\newcommand{\\norm}[1]{\\lVert #1\\rVert}', '\\begin{document}',
    '\\begin{lemma}\\label{lem:young}Y\\end{lemma}', '\\begin{theorem}\\label{thm:main}T', '\\end{theorem}',
    '\\begin{proof}', ...lines, 'Done.', '\\end{proof}', '\\end{document}'].join('\n');
  const r = TeXglass.render(doc, { renderMath: plain });
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.unknownCommands, []);
  assert.match(r.html, /class="tg-stepmark" data-tg-step="Bound on the interval \[0,1\]"/);
});

/** Applies an answer in the prompt's output format to a .tex file. */
function applyAnswer(tex, answer) {
  const blocks = Array.from(answer.matchAll(/```latex\n([\s\S]*?)```/g)).map((m) => m[1].trimEnd());
  for (const [, side, anchor, code] of answer.matchAll(/Where: right (after|before) (.+)\n\s*What:\s*\n\s*```latex\n([\s\S]*?)```/g)) {
    assert.equal(tex.split(anchor).length, 2, `anchor occurs once: ${anchor}`);
    tex = tex.replace(anchor, side === 'after' ? anchor + code.trim() : `${code.trim()} ${anchor}`);
  }
  const at = tex.indexOf('\\begin{document}');
  return tex.slice(0, at) + blocks[0] + '\n' + tex.slice(at);
}

test('an answer in the asked-for format applies to a paper, adds only hints, and the converter reads them', () => {
  const answer = `Part A

\`\`\`latex
\\usepackage{texglass}
\\tgdefine{\\norm{f}_p}{the $L^p$ norm of $f$, $\\left(\\int_X |f|^p \\, d\\mu\\right)^{1/p}$}
\\tgdefine{L^p}{the measurable functions $f$ on $X$ with $\\norm{f}_p < \\infty$}
\`\`\`

Part B

1. Where: right after \\label{prop:list}
   What:
   \`\`\`latex
   \\tguses{thm:main}
   \`\`\`
   Why: the text after the proposition says item (ii) follows from Hölder's inequality.

2. Where: right before The logarithm is concave, so
   What:
   \`\`\`latex
   \\tgstep[Concavity of the logarithm]
   \`\`\`
   Why: example of a step mark.

3. Where: right before Exponentiating \\eqref{eq:concave}
   What:
   \`\`\`latex
   \\tgstep[Exponentiate]
   \`\`\`
   Why: the last step.

Part C
- Left out $X$ and $\\mu$: single letters reused elsewhere.
`;
  const original = fs.readFileSync(path.join(ROOT, 'examples/sample.tex'), 'utf8');
  const hinted = applyAnswer(original, answer);
  // taking the hints out gives back the paper, character for character
  const stripped = hinted.replace(/\\usepackage\{texglass\}\n/, '').replace(/^\\tgdefine\{.*\}\n/gm, '')
    .replace(/\\tguses\{[^}]*\}/g, '').replace(/\\tgstep(\[[^\]]*\])? /g, '');
  assert.equal(stripped, original);

  const r = TeXglass.render(hinted, { renderMath: plain });
  assert.equal((r.html.match(/class="tg-define"/g) || []).length, 2);
  assert.match(r.html, /data-label="prop:list">[\s\S]*?<a class="ref tg-uses" href="#thm-\d+" data-label="thm:main"/);
  assert.equal((r.html.match(/class="tg-stepmark"/g) || []).length, 2);
  assert.ok(!r.warnings.some((w) => /tg/.test(w)), r.warnings.join('\n'));
});

test('the CLI prints the prompt; the viewer, the npm package and the offline cache carry it', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'bin/texglass.js'), '--ai-prompt'], { encoding: 'utf8' });
  assert.equal(out, PROMPT + '\n');
  assert.ok(require('../package.json').files.includes('latex/AI-PROMPT.md'));
  assert.ok(require('../sw.js').PRECACHE.includes('latex/AI-PROMPT.md'));
  assert.match(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), /id="ai-prompt"[^>]*>Copy AI prompt for authors</);
  assert.match(fs.readFileSync(path.join(ROOT, 'browser/build.js'), 'utf8'), /latex\/AI-PROMPT\.md/);
  assert.match(fs.readFileSync(path.join(ROOT, 'docs/GUIDE.md'), 'utf8'), /Copy AI prompt for authors/);
});
