'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// A stray brace makes the browser drop the rule after it without a word: it once
// hid the find bar's own rule, so the bar sat unpositioned under the zoom box.
for (const file of ['styles.css', 'vscode/media/preview.css']) {
  test(`${file} has balanced braces`, () => {
    const css = fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
    let depth = 0;
    css.split('\n').forEach((line, k) => {
      for (const ch of line) {
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        assert.ok(depth >= 0, `unmatched } on line ${k + 1}`);
      }
    });
    assert.equal(depth, 0, 'unclosed {');
  });
}
