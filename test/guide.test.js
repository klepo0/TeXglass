'use strict';
// docs/GUIDE.md lists every feature, keyboard shortcut, VS Code command and
// setting. This test fails when one found in the code is missing from it, so a
// pull request that adds a shortcut, command or setting updates the guide too.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const guide = read('docs/GUIDE.md');
const pkg = JSON.parse(read('vscode/package.json')).contributes;

// Every <kbd>…</kbd> in the guide, as written.
const kbds = new Set([...guide.matchAll(/<kbd>([^<]+)<\/kbd>/g)].map((m) => m[1]));
// The last key of each: "Ctrl+Shift+O" -> "O", "Ctrl+K V" -> "V".
const lastKeys = new Set([...kbds].map((k) => (k.split(/[ +]/).filter(Boolean).pop() || k).toUpperCase()));

/** "ctrl+shift+numpad_add" -> "Ctrl+Shift+Numpad +", the way the guide writes keys. */
function keyName(binding) {
  const part = (p) => ({ numpad_add: 'Numpad +', numpad_subtract: 'Numpad -' })[p] ||
    p.replace(/^numpad(\d)$/, 'Numpad $1').replace(/^([a-z])([a-z0-9]*)$/, (m, a, b) => a.toUpperCase() + b);
  return binding.split(' ').map((chord) => chord.split('+').map(part).join('+')).join(' ');
}

test('every VS Code keybinding is in the guide', () => {
  for (const kb of pkg.keybindings) {
    assert.ok(kbds.has(keyName(kb.key)), `${kb.command}: <kbd>${keyName(kb.key)}</kbd> is missing from docs/GUIDE.md`);
  }
});

test('every VS Code command is in the guide', () => {
  for (const c of pkg.commands) assert.ok(guide.includes(c.title), `command "${c.title}" (${c.command}) is missing from docs/GUIDE.md`);
});

test('every VS Code setting is in the guide', () => {
  const cfg = [].concat(pkg.configuration);
  for (const g of cfg) {
    for (const k of Object.keys(g.properties)) assert.ok(guide.includes('`' + k + '`'), `setting \`${k}\` is missing from docs/GUIDE.md`);
  }
});

test('the browser extension shortcut is in the guide', () => {
  const m = /const SHORTCUT = '([^']+)'/.exec(read('browser/build.js'));
  assert.ok(m, 'SHORTCUT not found in browser/build.js');
  assert.ok(kbds.has(m[1]), `<kbd>${m[1]}</kbd> is missing from docs/GUIDE.md`);
});

test('shortcuts named in the toolbars are in the guide', () => {
  const re = /\b(?:Ctrl|Alt|Shift)(?:\+(?:Ctrl|Shift|Alt))*\+[A-Z0-9]\b/g;
  for (const f of ['index.html', 'browser/src/overleaf.html']) {
    for (const [k] of read(f).matchAll(re)) assert.ok(kbds.has(k), `${f} mentions ${k}; <kbd>${k}</kbd> is missing from docs/GUIDE.md`);
  }
});

test('letter and digit keys the code listens for are in the guide', () => {
  const files = ['app.js', 'vscode/media/preview.js']
    .concat(fs.readdirSync(path.join(root, 'src')).filter((f) => f.endsWith('.js') && f !== 'texglass.js').map((f) => 'src/' + f))
    .concat(fs.readdirSync(path.join(root, 'browser/src')).filter((f) => f.endsWith('.js')).map((f) => 'browser/src/' + f));
  for (const f of files) {
    for (const m of read(f).matchAll(/\bkey [!=]== '([a-zA-Z0-9])'/g)) {
      const k = m[1].toUpperCase();
      assert.ok(lastKeys.has(k), `${f} handles the key "${m[1]}"; no <kbd>…${k}</kbd> in docs/GUIDE.md`);
    }
  }
});
