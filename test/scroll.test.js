'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../src/scroll.js');

global.requestAnimationFrame = (f) => setTimeout(f, 16);
global.cancelAnimationFrame = (id) => clearTimeout(id);

// A pane whose content above the target grows once it has been scrolled past,
// as off-screen blocks with estimated heights get their real ones.
function fakePane() {
  const pane = {
    scrollTop: 0,
    clientHeight: 800,
    grown: false,
    get scrollHeight() { return 20000 + (this.grown ? 1500 : 0); },
    getBoundingClientRect: () => ({ top: 50 }),
    scrollTo({ top }) {
      this.scrollTop = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, top));
      if (this.scrollTop > 2000) this.grown = true;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const el = {
    getBoundingClientRect: () => {
      const top = 50 + 5000 + (pane.grown ? 1500 : 0) - pane.scrollTop;
      return { top, height: 40 };
    },
  };
  return { pane, el };
}

test('ends with the element at the top even when the page grows on the way', async () => {
  const { pane, el } = fakePane();
  S.to(pane, el, { smooth: false });
  await new Promise((r) => setTimeout(r, 600));
  assert.strictEqual(el.getBoundingClientRect().top - 50, 16);
});

test('centres the element when asked', async () => {
  const { pane, el } = fakePane();
  S.to(pane, el, { align: 'center', smooth: false });
  await new Promise((r) => setTimeout(r, 600));
  const r = el.getBoundingClientRect();
  assert.strictEqual(r.top + r.height / 2 - 50, 400);
});
