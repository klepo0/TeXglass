#!/usr/bin/env node
/* Copy the converter and the stylesheet from the web viewer into the extension,
 * so both stay one source. Runs before packaging (vscode:prepublish). */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const out = path.join(__dirname, '..', 'shared');
fs.mkdirSync(out, { recursive: true });
for (const [from, to] of [
  ['src/texglass.js', 'texglass.js'],
  ['styles.css', 'styles.css'],
  ['src/find.js', 'find.js'],
]) {
  const src = path.join(root, from);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(out, to));
}
console.log('Copied the shared files into', path.relative(process.cwd(), out) || '.');
