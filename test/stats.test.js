'use strict';
// The visitor counter (src/stats.js) only runs on the public site, sends only
// the site's path, and stays out of the arXiv browser extension.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const code = fs.readFileSync(path.join(ROOT, 'src/stats.js'), 'utf8');

function run({ href, referrer = '', dnt, gpc }) {
  const sent = [];
  const loc = new URL(href);
  const ctx = {
    URL, URLSearchParams, Math, String,
    location: loc,
    document: { referrer },
    screen: { width: 1440 },
    navigator: { doNotTrack: dnt, globalPrivacyControl: gpc, sendBeacon: (u) => { sent.push(u); return true; } },
    Image: function () {},
  };
  vm.runInNewContext(code, ctx);
  return sent.map((u) => new URL(u));
}

test('counts a visit to the public site with the path only', () => {
  const [u, ...rest] = run({
    href: 'https://texglass.js.org/?arxiv=2301.00001#thm-3',
    referrer: 'https://arxiv.org/abs/2301.00001?context=math',
  });
  assert.strictEqual(rest.length, 0);
  assert.strictEqual(u.hostname, 'texglass.goatcounter.com');
  assert.strictEqual(u.searchParams.get('p'), '/');
  assert.strictEqual(u.searchParams.get('r'), 'https://arxiv.org');
  assert.strictEqual(u.searchParams.get('t'), 'TeXglass');
  assert.ok(!u.href.includes('2301'), u.href);
});

test('the old github.io address still counts (offline copies)', () => {
  const [u] = run({ href: 'https://klepo0.github.io/TeXglass/' });
  assert.strictEqual(u.searchParams.get('p'), '/TeXglass/');
});

test('a same-site referrer is not sent', () => {
  const [u] = run({ href: 'https://texglass.js.org/', referrer: 'https://texglass.js.org/?gh=x' });
  assert.strictEqual(u.searchParams.get('r'), '');
});

test('counts nothing anywhere else, or with Do Not Track / GPC', () => {
  for (const href of ['http://localhost:8000/', 'chrome-extension://abc/index.html', 'file:///C:/paper.html', 'vscode-webview://x/index.html']) {
    assert.strictEqual(run({ href }).length, 0, href);
  }
  assert.strictEqual(run({ href: 'https://texglass.js.org/', dnt: '1' }).length, 0);
  assert.strictEqual(run({ href: 'https://texglass.js.org/', gpc: true }).length, 0);
});

test('the arXiv browser extension bundles no counter', () => {
  const { viewerHtml } = require('../browser/build.js');
  assert.ok(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').includes('src/stats.js'));
  assert.ok(!viewerHtml().includes('stats.js'));
  assert.ok(!fs.readFileSync(path.join(ROOT, 'browser/build.js'), 'utf8').includes("copyDir(path.join(ROOT, 'src'), path.join(out, 'src'), (name) => name.endsWith('.js'));"));
});
