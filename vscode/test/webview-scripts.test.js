'use strict';
// Every script the preview webview loads must parse: one syntax error (such as a
// name declared twice in media/preview.js) leaves the whole preview blank.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');

test('the scripts the preview webview loads all parse', () => {
  const ext = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
  const scripts = [...ext.matchAll(/<script nonce="\$\{nonce\}" src="\$\{res\(([^)]*)\)\}"><\/script>/g)]
    .map((m) => path.join(root, ...m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''))));
  assert.ok(scripts.length > 10, 'found the webview scripts in extension.js');
  assert.ok(scripts.some((f) => f.endsWith(path.join('media', 'preview.js'))));
  for (const file of scripts) {
    assert.ok(fs.existsSync(file), `${path.relative(root, file)} exists`);
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file }), `${path.relative(root, file)} parses`);
  }
});
