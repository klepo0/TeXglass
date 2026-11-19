#!/usr/bin/env node
/*
 * Packages a dev build of the extension without touching its version:
 *
 *   npm run package:dev      (inside vscode/)
 *
 * writes texglass-<version>-dev.<commit>.vsix next to package.json, so a test
 * build can't be mistaken for (or overwrite) the released .vsix of the same
 * version. Releases are packaged by the Release workflow instead.
 */
'use strict';
const { execSync } = require('child_process');
const path = require('path');

const dir = path.join(__dirname, '..');
const { version } = require('../package.json');
let commit = 'local';
try {
  commit = execSync('git rev-parse --short HEAD', { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch {}
const out = `texglass-${version}-dev.${commit}.vsix`;
execSync(`npx vsce package -o ${out}`, { cwd: dir, stdio: 'inherit' });
console.log('Dev build:', out);
