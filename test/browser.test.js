'use strict';
// Tests for the arXiv browser extension in browser/: the build and the
// background script, run against a fake WebExtension API (as in Firefox,
// where the background script is an event page with src/arxiv.js loaded first).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { manifest, viewerHtml } = require('../browser/build.js');

const ROOT = path.join(__dirname, '..');

function fakeBrowser(stored = {}) {
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
  const menus = [];
  const tabs = [];
  const browser = {
    runtime: { getURL: (p) => 'moz-extension://abc/' + p, onInstalled: on('installed'), onStartup: on('startup'), onMessage: on('message') },
    action: { onClicked: on('action') },
    contextMenus: { removeAll: (cb) => { menus.length = 0; cb(); }, create: (m) => menus.push(m), onClicked: on('menu') },
    tabs: { create: async (props) => { tabs.push(props); } },
    storage: { sync: { get: async (defaults) => Object.assign({}, defaults, stored) } },
  };
  return { browser, listeners, menus, tabs };
}

function loadBackground(fake) {
  const context = vm.createContext({ browser: fake.browser, URL, TextDecoder, console });
  context.globalThis = context;
  context.self = context;
  for (const f of ['src/arxiv.js', 'browser/src/background.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), context, { filename: f });
  }
  return context;
}

const settle = () => new Promise((r) => setTimeout(r, 10));

test('manifests: service worker for Chrome, event page with gecko id for Firefox', () => {
  const chrome = manifest('chrome');
  const firefox = manifest('firefox');
  assert.strictEqual(chrome.manifest_version, 3);
  assert.strictEqual(chrome.background.service_worker, 'background.js');
  assert.ok(!chrome.browser_specific_settings);
  assert.deepStrictEqual(firefox.background.scripts, ['src/arxiv.js', 'background.js']);
  assert.ok(firefox.browser_specific_settings.gecko.id);
  for (const m of [chrome, firefox]) {
    for (const icon of Object.values(m.icons)) assert.ok(fs.existsSync(path.join(ROOT, 'browser/src', icon)), icon);
    assert.ok(m.permissions.includes('contextMenus'));
  }
});

test('the bundled viewer loads KaTeX from the extension, not a CDN', () => {
  const html = viewerHtml();
  assert.match(html, /src="vendor\/katex\/katex\.min\.js"/);
  assert.match(html, /href="vendor\/katex\/katex\.min\.css"/);
  assert.doesNotMatch(html, /https?:\/\/cdn/);
});

test('arxivId accepts abs, pdf and html links on arxiv.org only', () => {
  const ctx = loadBackground(fakeBrowser());
  const cases = {
    'https://arxiv.org/abs/2301.00001': '2301.00001',
    'https://arxiv.org/pdf/2301.00001v2': '2301.00001v2',
    'https://arxiv.org/pdf/2301.00001v2.pdf': '2301.00001v2',
    'https://arxiv.org/html/2411.01234v1/': '2411.01234v1',
    'https://arxiv.org/abs/math/0211159': 'math/0211159',
    'http://export.arxiv.org/abs/hep-th/9901001v3': 'hep-th/9901001v3',
    'https://www.arxiv.org/abs/2301.00001#comments': '2301.00001',
    'https://arxiv.org/list/math.PR/new': null,
    'https://example.com/abs/2301.00001': null,
    'not a url': null,
  };
  for (const [url, id] of Object.entries(cases)) assert.strictEqual(ctx.arxivId(url), id, url);
});

test('menus are created on install and the toolbar button opens the paper next to the tab', async () => {
  const fake = fakeBrowser();
  loadBackground(fake);
  fake.listeners.installed();
  assert.deepStrictEqual(fake.menus.map((m) => m.id), ['texglass-link', 'texglass-page']);
  assert.ok(fake.menus[0].targetUrlPatterns.includes('*://*.arxiv.org/abs/*'));

  fake.listeners.action({ id: 7, index: 2, url: 'https://arxiv.org/pdf/2102.13459v3' });
  await settle();
  assert.deepStrictEqual({ ...fake.tabs[0] }, { url: 'moz-extension://abc/index.html?arxiv=2102.13459v3', index: 3, openerTabId: 7 });

  fake.listeners.action({ id: 8, index: 0, url: 'https://example.com/' });
  await settle();
  assert.strictEqual(fake.tabs[1].url, 'moz-extension://abc/index.html');
});

test('the right-click menu and page links open the paper; the web viewer can be chosen instead', async () => {
  const fake = fakeBrowser({ viewer: 'web', webUrl: 'https://klepo0.github.io/TeXglass/' });
  loadBackground(fake);
  fake.listeners.menu({ menuItemId: 'texglass-link', linkUrl: 'https://arxiv.org/abs/math/0211159' }, { id: 1, index: 0 });
  fake.listeners.menu({ menuItemId: 'texglass-link', linkUrl: 'https://example.com/' }, { id: 1, index: 0 });
  fake.listeners.message({ type: 'texglass-open', id: '2301.00001' }, { tab: { id: 2, index: 4 } });
  await settle();
  assert.deepStrictEqual(fake.tabs.map((t) => t.url), [
    'https://klepo0.github.io/TeXglass/?arxiv=math%2F0211159',
    'https://klepo0.github.io/TeXglass/?arxiv=2301.00001',
  ]);
});
