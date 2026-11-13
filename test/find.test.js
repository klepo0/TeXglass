'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const F = require('../src/find.js');

test('findRegex escapes the query and lets spaces match any whitespace', () => {
  const re = F.findRegex('  L(p) +  norm ');
  assert.ok(re.test('the L(p) +\n norm'));
  assert.equal(F.findRegex('   '), null);
  assert.ok(F.findRegex('Banach').test('BANACH space'));
});

test('parseJump reads kinds and numbers the way people type them', () => {
  assert.deepEqual(F.parseJump('Lemma 4.1').kinds, ['lemma']);
  assert.equal(F.parseJump('Lemma 4.1').num, '4.1');
  assert.deepEqual(F.parseJump('(3.2)'), { kinds: ['equation'], num: '3.2', words: ['3', '2'] });
  assert.equal(F.parseJump('(3.2').num, '3.2');
  assert.deepEqual(F.parseJump('§2').kinds, ['section']);
  assert.equal(F.parseJump('§ 2.1').num, '2.1');
  assert.deepEqual(F.parseJump('thm3.2'), { kinds: ['thm'], num: '3.2', words: ['thm3', '2'] });
  assert.equal(F.parseJump('3.2').num, '3.2');
  assert.deepEqual(F.parseJump('3.2').kinds, []);
  assert.equal(F.parseJump('Theorem A').num, 'A');
  assert.equal(F.parseJump('eq. (5)').num, '5');
  assert.deepEqual(F.parseJump('eq. (5)').kinds, ['eq']);
  assert.equal(F.parseJump('hahn banach').num, '');
});

const T = (type, label, num, title) => ({
  type, label, num, title: title || '',
  kinds: type === 'equation' ? ['equation'] : type === 'section' ? [label.toLowerCase(), 'section'] : label.toLowerCase().split(' '),
});
const targets = [
  T('section', 'Section', '1', 'Introduction'),
  T('theorem', 'Theorem', '1.1', 'Hahn–Banach'),
  T('equation', 'Equation', '1.1'),
  T('section', 'Section', '3', 'Main results'),
  T('section', 'Subsection', '3.1', 'Estimates'),
  T('theorem', 'Lemma', '3.2'),
  T('equation', 'Equation', '3.2'),
  T('theorem', 'Main Theorem', '3.12'),
  T('theorem', 'Theorem', 'A', 'Unnumbered-looking'),
  T('figure', 'Figure', '3'),
];
const names = (q) => F.rankTargets(targets, q).map(F.displayName);

test('rankTargets finds a theorem, equation or section by its number', () => {
  assert.deepEqual(names('Lemma 3.2'), ['Lemma 3.2']);
  assert.deepEqual(names('lem 3.2'), ['Lemma 3.2']);
  assert.deepEqual(names('(3.2)'), ['Equation (3.2)']);
  assert.deepEqual(names('eq 1.1'), ['Equation (1.1)']);
  assert.deepEqual(names('thm 1.1'), ['Theorem 1.1']);
  // A bare number lists everything with it, exact ones first.
  assert.deepEqual(names('3.2'), ['Lemma 3.2', 'Equation (3.2)']);
  assert.deepEqual(names('3'), ['Section 3', 'Figure 3', 'Subsection 3.1', 'Lemma 3.2', 'Equation (3.2)', 'Main Theorem 3.12']);
  // "Section 3.1" finds the subsection; "Theorem 3.12" the main theorem.
  assert.deepEqual(names('Section 3.1'), ['Subsection 3.1']);
  assert.deepEqual(names('§3.1'), ['Subsection 3.1']);
  assert.deepEqual(names('Theorem 3.12'), ['Main Theorem 3.12']);
  assert.deepEqual(names('Theorem A'), ['Theorem A']);
  assert.deepEqual(names('fig 3'), ['Figure 3']);
  assert.deepEqual(names('Lemma 9'), []);
});

test('rankTargets also finds things by kind or by title', () => {
  assert.deepEqual(names('lemma'), ['Lemma 3.2']);
  assert.deepEqual(names('intro'), ['Section 1']);
  assert.deepEqual(names('hahn'), ['Theorem 1.1']);
  assert.deepEqual(names('main'), ['Main Theorem 3.12', 'Section 3']);
  assert.equal(names('').length, targets.length);
});
