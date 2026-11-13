#!/usr/bin/env node
/* Bundle the extension for VS Code in the browser (github.dev, vscode.dev)
 * into dist/web.js: one file, with KaTeX and the converter inside, Node's
 * path module swapped for path-browserify, and TEXGLASS_WEB set so the code
 * reads files through vscode.workspace.fs and converts without a thread. */
'use strict';
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
require('./copy-shared.js');

esbuild
  .build({
    entryPoints: [path.join(root, 'extension.js')],
    outfile: path.join(root, 'dist', 'web.js'),
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2020',
    minify: process.argv.includes('--minify'),
    sourcemap: false,
    // Only reached on the desktop, never in the browser.
    external: ['vscode', 'fs', 'worker_threads'],
    alias: { path: 'path-browserify' },
    define: { TEXGLASS_WEB: 'true' },
    logLevel: 'info',
  })
  .catch(() => process.exit(1));
