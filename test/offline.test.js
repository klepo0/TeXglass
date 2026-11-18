'use strict';
// The web viewer works offline after one visit: everything index.html loads is
// served from the site itself and kept by the service worker (sw.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { PRECACHE } = require('../sw.js');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

test('index.html loads nothing from another site', () => {
  const refs = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 5);
  for (const r of refs) assert.doesNotMatch(r, /^(https?:)?\/\//, r);
});

test('the service worker caches every file the viewer loads, and they exist', () => {
  const refs = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  for (const r of refs) assert.ok(PRECACHE.includes(r), `${r} is not in sw.js PRECACHE`);
  for (const f of fs.readdirSync(path.join(ROOT, 'src')).filter((n) => n.endsWith('.js'))) {
    if (refs.includes(`src/${f}`) || f === 'render-worker.js') assert.ok(PRECACHE.includes(`src/${f}`), f);
  }
  for (const f of PRECACHE) if (f !== './') assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is missing`);
});

test('every KaTeX font is cached', () => {
  const fonts = fs.readdirSync(path.join(ROOT, 'vendor/katex/fonts')).filter((n) => n.endsWith('.woff2'));
  assert.strictEqual(fonts.length, 20);
  for (const f of fonts) assert.ok(PRECACHE.includes(`vendor/katex/fonts/${f}`), f);
});

test('vendor/katex is the KaTeX that package.json pins', () => {
  const pinned = require('../package.json').dependencies.katex;
  const js = fs.readFileSync(path.join(ROOT, 'vendor/katex/katex.min.js'), 'utf8');
  assert.ok(js.includes(`"${pinned}"`) || js.includes(`'${pinned}'`), `vendor/katex is not KaTeX ${pinned}`);
  const installed = path.join(ROOT, 'node_modules/katex/dist/katex.min.js');
  if (fs.existsSync(installed)) assert.strictEqual(js, fs.readFileSync(installed, 'utf8'));
});
