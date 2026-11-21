'use strict';
// Settings (src/features.js): the list of reading aids, how they are kept, and
// which ones work through another.
const test = require('node:test');
const assert = require('node:assert/strict');
const Features = require('../src/features.js');

function memory(init) {
  const m = new Map(Object.entries(init || {}));
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), map: m };
}

test('everything but the handwritten look is on by default', () => {
  const prefs = Features.read(memory());
  for (const f of Features.LIST) assert.equal(prefs[f.id], f.id !== 'handwriting', f.id);
});

test('earlier choices under the old keys carry over', () => {
  const prefs = Features.read(memory({
    'texglass:notationHover': 'off',
    'texglass:study': '0',
    'texglass:progress': '0',
    'texglass:look': 'notes',
  }));
  assert.equal(prefs.notationHover, false);
  assert.equal(prefs.notes, false);
  assert.equal(prefs.progress, false);
  assert.equal(prefs.handwriting, true);
});

test('write keeps the old keys and texglass:feature-<id> for the new ones', () => {
  const store = memory();
  Features.write(store, 'notationHover', false);
  Features.write(store, 'citeLookup', false);
  Features.write(store, 'handwriting', true);
  assert.equal(store.get('texglass:notationHover'), 'off');
  assert.equal(store.get('texglass:feature-citeLookup'), '0');
  assert.equal(store.get('texglass:look'), 'notes');
  const prefs = Features.read(store);
  assert.equal(prefs.citeLookup, false);
  assert.equal(prefs.handwriting, true);
});

test('a feature is off while one it works through is off', () => {
  const prefs = Features.read(memory({ 'texglass:feature-citePreviews': '0' }));
  assert.equal(prefs.citedResults, true);
  assert.equal(Features.on(prefs, 'citeLookup'), false);
  assert.equal(Features.on(prefs, 'citedResults'), false);
  assert.equal(Features.on(Object.assign({}, prefs, { citePreviews: true }), 'citedResults'), true);
  assert.equal(Features.on({}, 'hypotheses'), true);
  assert.equal(Features.on({}, 'handwriting'), false);
});

test('every feature has a VS Code setting', () => {
  const pkg = require('../vscode/package.json');
  const props = pkg.contributes.configuration.properties || Object.assign({}, ...[].concat(pkg.contributes.configuration).map((c) => c.properties));
  for (const f of Features.LIST) {
    assert.ok(f.vscode, f.id);
    assert.ok(props['texglass.' + f.vscode], 'texglass.' + f.vscode);
  }
});

test('the parts handed to insight and the side panel', () => {
  const prefs = { dependencyMap: false, notationIndex: true, usesButtons: false, proseDefinitions: true };
  assert.deepEqual(Features.insightParts(prefs), { map: false, notation: true, uses: false, words: true });
  assert.deepEqual(Features.sideTabs(prefs), { deps: false, notation: true });
});
