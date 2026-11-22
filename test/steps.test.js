'use strict';
// Stepping through a proof (src/steps.js): where sentences end, and which
// paragraphs open a nested part ("Case 1.", "Step 2:").
const test = require('node:test');
const assert = require('node:assert/strict');
const Steps = require('../src/steps.js');

/** Cut `text` at the sentence ends found. */
function cut(text, more) {
  const out = [];
  let at = 0;
  for (const e of Steps.sentenceEnds(text, more)) { out.push(text.slice(at, e)); at = e; }
  out.push(text.slice(at));
  return out.filter(Boolean);
}

test('sentences end at full stops, question and exclamation marks', () => {
  assert.deepEqual(cut('Fix a point. Then it moves! Does it stop? Yes.'), ['Fix a point. ', 'Then it moves! ', 'Does it stop? ', 'Yes.']);
  assert.deepEqual(cut('It is small (as shown). Next we bound it.'), ['It is small (as shown). ', 'Next we bound it.']);
});

test('abbreviations, initials and numbered headers do not end a sentence', () => {
  assert.deepEqual(cut('By e.g. the bound, cf. Thm. 3, it holds. Done.'), ['By e.g. the bound, cf. Thm. 3, it holds. ', 'Done.']);
  assert.deepEqual(cut('As J. Smith noted, i.e. here, it works.'), ['As J. Smith noted, i.e. here, it works.']);
  assert.deepEqual(cut('This is Step 2. Then more.'), ['This is Step 2. Then more.']);
  assert.deepEqual(cut('This is done in Section 2. Then more.'), ['This is done in Section 2. ', 'Then more.']);
});

test('a lower-case word after a full stop continues the sentence', () => {
  assert.deepEqual(cut('the map x. then y.'), ['the map x. then y.']);
});

test('a full stop at the end of a text run ends a sentence only before a capital', () => {
  assert.deepEqual(Steps.sentenceEnds('It holds. ', 'Then'), [10]);
  assert.deepEqual(Steps.sentenceEnds('It holds. ', 'then'), []);
  assert.deepEqual(Steps.sentenceEnds('It holds. '), []);
  // just after a formula: ". By Lemma"
  assert.deepEqual(Steps.sentenceEnds('. By Lemma ', 'x'), [2]);
});

test('nested-part headers', () => {
  assert.equal(Steps.partHeader('Case 1. x < 1'), 'case');
  assert.equal(Steps.partHeader('Case (ii): the rest'), 'case');
  assert.equal(Steps.partHeader('Subcase 2a. more'), 'case');
  assert.equal(Steps.partHeader('Step 3: conclude'), 'step');
  assert.equal(Steps.partHeader('Second case: y'), 'case');
  assert.equal(Steps.partHeader('Inductive step. Assume'), 'step');
  assert.equal(Steps.partHeader('Claim. It is'), 'claim');
  assert.equal(Steps.partHeader('Part a) first'), 'part');
  assert.equal(Steps.partHeader('Casey said'), '');
  assert.equal(Steps.partHeader('Steps of the argument'), '');
  assert.equal(Steps.partHeader('We split into cases.'), '');
});

test('a formula ends a sentence only with a full stop of its own', () => {
  assert.equal(Steps.texTail('x^2 > 0. \\tag{1}'), 'x^2 > 0.');
  assert.equal(Steps.texTail('a = b, \\label{eq:a}'), 'a = b,');
  assert.equal(Steps.texTail('\\begin{aligned} a &= b \\\\ &= c. \\end{aligned}'), '\\begin{aligned} a &= b \\\\ &= c.');
  assert.equal(Steps.texTail('a = b \\text{.}'), 'a = b .');
  assert.equal(Steps.texTail('a = b\\quad'), 'a = b');
  // \right. draws nothing: not a full stop
  assert.ok(!/\.$/.test(Steps.texTail('\\left\\{ x \\right.')));
});
