'use strict';
// Tests for the live preview on Overleaf in the browser extension
// (browser/src/overleaf*.js): composing the open file with the project's
// files, reading Overleaf's zip, the manifests and the toolbar button.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { manifest, zipDir, OVERLEAF_MATCHES } = require('../browser/build.js');
const { compose, unzip, sortFiles, locate, inputsOf, wanted } = require('../browser/src/overleaf-project.js');

const ROOT = path.join(__dirname, '..');

const MAIN = [
  '\\documentclass{article}',
  '\\input{macros}',
  '\\begin{document}',
  '\\section{One}',
  '\\input{sections/intro} % the introduction',
  '% \\input{sections/old}',
  'After the input, see \\cite{knuth}.',
  '\\bibliographystyle{plain}',
  '\\bibliography{refs}',
  '\\end{document}',
  '',
].join('\n');
const PROJECT = {
  texts: {
    'main.tex': MAIN,
    'macros.tex': '\\newcommand{\\R}{\\mathbb{R}}\n',
    'sections/intro.tex': '\\subsection{Intro}\nLet $x \\in \\R$.\n',
    'refs.bib': '@book{knuth, author={Donald E. Knuth}, title={The TeXbook}, publisher={Addison-Wesley}, year={1984}}\n',
  },
};

test('without project files the open file is rendered as it is', () => {
  const c = compose({ text: 'Hello $x$.', name: 'main.tex' }, null);
  assert.strictEqual(c.text, 'Hello $x$.');
  assert.strictEqual(c.toOpen(3), 3);
  assert.strictEqual(c.fromOpen(3), 3);
});

test('the main file gets its \\input files and its bibliography; offsets map back to it', () => {
  const live = MAIN.replace('After the input', 'After the input (typed just now)');
  const c = compose({ text: live, name: 'main.tex' }, PROJECT);
  assert.strictEqual(c.path, 'main.tex');
  assert.deepStrictEqual(c.inlined, ['macros.tex', 'sections/intro.tex']);
  assert.match(c.text, /\\newcommand\{\\R\}/);
  assert.match(c.text, /Let \$x \\in \\R\$/);
  assert.match(c.text, /typed just now/, 'the editor is newer than the zip');
  assert.match(c.text, /\\begin\{thebibliography\}[\s\S]*TeXbook/);
  assert.doesNotMatch(c.text, /\\bibliography\{refs\}/);
  assert.match(c.text, /% \\input\{sections\/old\}/, 'commented-out inputs stay as they are');

  // Text of the open file maps both ways.
  const at = live.indexOf('After the input');
  assert.strictEqual(c.text.slice(c.fromOpen(at), c.fromOpen(at) + 15), 'After the input');
  assert.strictEqual(c.toOpen(c.fromOpen(at)), at);
  // Text pulled in from another file maps to the command that pulled it in.
  assert.strictEqual(c.toOpen(c.text.indexOf('Let $x')), live.indexOf('\\input{sections/intro}'));
  assert.strictEqual(c.toOpen(c.text.indexOf('TeXbook')), live.indexOf('\\bibliography{refs}'));
  assert.strictEqual(c.toOpen(c.text.indexOf('\\end{document}')), live.indexOf('\\end{document}'));
});

test('a chapter gets the main file\'s preamble, for its macros', () => {
  const live = '\\subsection{Intro}\nLet $x \\in \\R$, as in \\cite{knuth}.\n';
  const c = compose({ text: live, name: 'sections/intro.tex' }, PROJECT);
  assert.strictEqual(c.path, 'sections/intro.tex');
  assert.strictEqual(c.main, 'main.tex');
  assert.match(c.text, /^\\documentclass\{article\}\n\\newcommand\{\\R\}/);
  assert.ok(c.text.indexOf('\\begin{document}') < c.text.indexOf('Let $x'));
  assert.match(c.text, /TeXbook[\s\S]*\\end\{document\}\n$/);
  // Not the main file's body: only this chapter.
  assert.doesNotMatch(c.text, /\\section\{One\}/);
  const at = live.indexOf('Let');
  assert.strictEqual(c.toOpen(c.fromOpen(at)), at);
  assert.strictEqual(c.text.slice(c.fromOpen(at), c.fromOpen(at) + 3), 'Let');
  // Before the chapter (the preamble) maps to its start.
  assert.strictEqual(c.toOpen(5), 0);
  // A chapter that cites nothing gets no empty bibliography.
  assert.doesNotMatch(compose({ text: 'No citations.', name: 'sections/intro.tex' }, PROJECT).text, /thebibliography/);
});

test('text pulled in from another file knows its file and place there, through nested inputs', () => {
  const texts = {
    'main.tex': '\\documentclass{article}\n\\begin{document}\nA\n\\input{ch/one}\nB\n\\end{document}\n',
    'ch/one.tex': 'One start\n\\input{ch/two}\nOne end\n',
    'ch/two.tex': 'Two body\n',
  };
  const c = compose({ text: texts['main.tex'], name: 'main.tex' }, { texts });
  assert.deepStrictEqual(c.inlined, ['ch/one.tex', 'ch/two.tex']);
  const at = (w) => c.sourceAt(c.text.indexOf(w));
  assert.deepStrictEqual(at('One start'), { file: 'ch/one.tex', at: 0 });
  assert.deepStrictEqual(at('Two body'), { file: 'ch/two.tex', at: 0 });
  assert.deepStrictEqual(at('One end'), { file: 'ch/one.tex', at: texts['ch/one.tex'].indexOf('One end') });
  assert.deepStrictEqual(at('B\n'), { file: null, at: texts['main.tex'].indexOf('B\n') });
  // In the open file, all of it maps to the \input line.
  assert.strictEqual(c.toOpen(c.text.indexOf('Two body')), texts['main.tex'].indexOf('\\input{ch/one}'));
});

test('missing \\input files are named, and the open file is found by path, text or name', () => {
  const c = compose({ text: '\\input{nowhere}\nText.', name: 'main.tex' }, { texts: { 'main.tex': 'old' } });
  assert.deepStrictEqual(c.missing, ['nowhere']);
  assert.deepStrictEqual(inputsOf('\\input{a}\n% \\input{b}\n\\include{c}\\import{d/}{e}'), ['a', 'c', 'd/e']);
  const texts = { 'main.tex': 'A', 'ch/one.tex': 'B', 'ch/two.tex': 'C' };
  assert.strictEqual(locate(texts, 'changed', 'ch/one.tex'), 'ch/one.tex');
  assert.strictEqual(locate(texts, 'C', ''), 'ch/two.tex');
  assert.strictEqual(locate(texts, 'changed', 'one.tex'), 'ch/one.tex');
  assert.strictEqual(locate(texts, 'changed', 'other.tex'), null);
});

test('unzip reads Overleaf-style zips, stored and deflated, picking the files it wants', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'texglass-zip-'));
  fs.mkdirSync(path.join(dir, 'figs'));
  fs.writeFileSync(path.join(dir, 'main.tex'), MAIN);
  fs.writeFileSync(path.join(dir, 'figs/plot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  fs.writeFileSync(path.join(dir, 'figs/plot.pdf'), '%PDF-1.4 not wanted');
  const zip = zipDir(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  const raw = await unzip(new Uint8Array(zip).buffer, wanted);
  assert.deepStrictEqual(Object.keys(raw).sort(), ['figs/plot.png', 'main.tex']);
  const { texts, images } = sortFiles(raw);
  assert.strictEqual(texts['main.tex'], MAIN);
  assert.strictEqual(images['figs/plot.png'].type, 'image/png');
  assert.strictEqual(images['figs/plot.png'].size, 7);
  await assert.rejects(unzip(new Uint8Array(100)), /not a zip/);
});

test('the manifests add the preview to Overleaf projects, reading the editor from the page itself', () => {
  for (const target of ['chrome', 'firefox']) {
    const m = manifest(target);
    const page = m.content_scripts.find((c) => c.js.includes('overleaf-page.js'));
    const panel = m.content_scripts.find((c) => c.js.includes('overleaf.js'));
    assert.strictEqual(page.world, 'MAIN', target);
    assert.strictEqual(page.run_at, 'document_start', 'before Overleaf makes its editor');
    assert.deepStrictEqual(page.matches, OVERLEAF_MATCHES);
    assert.deepStrictEqual(panel.css, ['overleaf.css']);
    assert.ok(OVERLEAF_MATCHES.every((p) => p.endsWith('/project/*')));
    const war = m.web_accessible_resources[0];
    assert.deepStrictEqual(war.resources, ['overleaf.html']);
    assert.ok(war.matches.every((p) => p.endsWith('/*') && p.includes('overleaf.com')));
  }
  assert.strictEqual(manifest('chrome').minimum_chrome_version, '111');
  assert.strictEqual(manifest('firefox').browser_specific_settings.gecko.strict_min_version, '128.0');
});

test('overleaf.html loads only files that the extension ships', () => {
  const html = fs.readFileSync(path.join(ROOT, 'browser/src/overleaf.html'), 'utf8');
  const refs = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 8);
  for (const r of refs) {
    assert.doesNotMatch(r, /^(https?:)?\/\//, r);
    const where = r.startsWith('src/') || r.startsWith('vendor/') || r.startsWith('vscode/') || r === 'styles.css' ? path.join(ROOT, r) : path.join(ROOT, 'browser/src', r);
    assert.ok(fs.existsSync(where), r);
  }
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'extension pages refuse inline scripts');
});

test('on an Overleaf project the toolbar button shows or hides the preview', async () => {
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
  const tabs = [];
  const sent = [];
  const browser = {
    runtime: { getURL: (p) => 'moz-extension://abc/' + p, onInstalled: on('installed'), onStartup: on('startup'), onMessage: on('message') },
    action: { onClicked: on('action') },
    contextMenus: { removeAll: (cb) => cb(), create: () => {}, onClicked: on('menu') },
    tabs: { create: async (props) => { tabs.push(props); }, sendMessage: async (id, msg) => { sent.push([id, msg.type]); return { open: true }; } },
    storage: { sync: { get: async (d) => d } },
  };
  const context = vm.createContext({ browser, URL, TextDecoder, console });
  context.globalThis = context;
  for (const f of ['src/arxiv.js', 'browser/src/background.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), context, { filename: f });
  }
  assert.ok(context.isOverleafProject('https://www.overleaf.com/project/64a1b2c3d4e5f60718293a4b'));
  assert.ok(!context.isOverleafProject('https://www.overleaf.com/project'));
  assert.ok(!context.isOverleafProject('https://overleaf.com.evil.example/project/64a1b2c3d4e5f60718293a4b'));
  listeners.action({ id: 7, index: 0, url: 'https://www.overleaf.com/project/64a1b2c3d4e5f60718293a4b' });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepStrictEqual(sent, [[7, 'texglass-overleaf-toggle']]);
  assert.strictEqual(tabs.length, 0);
  // A tab opened before the extension was installed has no panel: open the viewer instead.
  browser.tabs.sendMessage = async () => { throw new Error('no receiver'); };
  listeners.action({ id: 8, index: 0, url: 'https://www.overleaf.com/project/64a1b2c3d4e5f60718293a4b' });
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(tabs[0].url, 'moz-extension://abc/index.html?arxiv');
});
