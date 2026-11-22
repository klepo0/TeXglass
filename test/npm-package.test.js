'use strict';
// The npm package "texglass" (root package.json "files") holds what the
// converter and the CLI need, including the reader page's scripts, and no
// more: not the web viewer, the extensions or the tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');
const TeXglassExport = require('../src/export.js');

const ROOT = path.join(__dirname, '..');
const pkg = require('../package.json');

function packed() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const out = execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  return JSON.parse(out)[0].files.map((f) => f.path);
}

test('the package holds the CLI, the converter and the reader page scripts', () => {
  const files = packed();
  const needed = [
    pkg.main, pkg.bin.texglass, 'styles.css',
    'src/bib.js', 'src/tikz.js', 'src/export.js', 'src/diagrams.js',
    ...TeXglassExport.READER_SCRIPTS.filter((f) => f.startsWith('src/')),
  ];
  for (const f of needed) assert.ok(files.includes(f), f + ' is in the package');
  for (const f of files) assert.ok(!/^(test|browser|vscode|dashboard|vendor|docs)\/|^index\.html$|^app\.js$/.test(f), f + ' should not be in the package');
});

test('every relative require in the packaged scripts is packaged too', () => {
  const fs = require('fs');
  const files = packed();
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/require\('(\.{1,2}\/[^']+)'\)/g)) {
      const dep = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
      // optional modules are loaded inside try/catch (src/cite.js -> cited.js)
      const optional = new RegExp(`try \\{[^}]*require\\('${m[1].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}'\\)`).test(src);
      assert.ok(files.includes(dep) || optional, `${f} needs ${dep}`);
    }
  }
});
