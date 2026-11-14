'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Z = require('../src/zoom.js');

test('zoom steps through the levels and stops at the ends', () => {
  assert.strictEqual(Z.next(1, 1), 1.1);
  assert.strictEqual(Z.next(1, -1), 0.9);
  assert.strictEqual(Z.next(1.17, 1), 1.25); // after Ctrl + wheel, the next level up
  assert.strictEqual(Z.next(1.17, -1), 1.1);
  assert.strictEqual(Z.next(Z.MAX, 1), Z.MAX);
  assert.strictEqual(Z.next(Z.MIN, -1), Z.MIN);
});

test('stored zoom levels are read back safely', () => {
  assert.strictEqual(Z.parse('1.25'), 1.25);
  assert.strictEqual(Z.parse(null), 1);
  assert.strictEqual(Z.parse('abc'), 1);
  assert.strictEqual(Z.parse('40'), Z.MAX);
  assert.strictEqual(Z.label(1.25), '125%');
});

test('Ctrl/Cmd with +, - and 0 are the zoom keys', () => {
  assert.strictEqual(Z.keyStep({ ctrlKey: true, key: '=' }), 1);
  assert.strictEqual(Z.keyStep({ metaKey: true, key: '+' }), 1);
  assert.strictEqual(Z.keyStep({ ctrlKey: true, key: '-' }), -1);
  assert.strictEqual(Z.keyStep({ ctrlKey: true, key: '0' }), 0);
  assert.strictEqual(Z.keyStep({ key: '=' }), null);
  assert.strictEqual(Z.keyStep({ ctrlKey: true, key: 'f' }), null);
});
