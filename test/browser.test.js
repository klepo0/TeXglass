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

test('arxivId also reads alphaXiv addresses; HAL and ResearchGate pages need a lookup', () => {
  const ctx = loadBackground(fakeBrowser());
  const cases = {
    'https://www.alphaxiv.org/abs/2301.00001': '2301.00001',
    'https://alphaxiv.org/overview/2411.01234v2': '2411.01234v2',
    'https://www.alphaxiv.org/abs/math/0211159': 'math/0211159',
    'https://www.alphaxiv.org/abs/2301.00001/comments': '2301.00001',
    'https://www.alphaxiv.org/explore': null,
    'https://hal.science/hal-00877723v3': null,
  };
  for (const [url, id] of Object.entries(cases)) assert.strictEqual(ctx.arxivId(url), id, url);
  assert.ok(ctx.isLookupPage('https://hal.science/hal-00877723v3'));
  assert.ok(ctx.isLookupPage('https://inria.hal.science/inria-00000001/document'));
  assert.ok(ctx.isLookupPage('https://hal.archives-ouvertes.fr/hal-00001718'));
  assert.ok(ctx.isLookupPage('https://www.researchgate.net/publication/123456789_A_Title'));
  assert.ok(!ctx.isLookupPage('https://www.researchgate.net/profile/Someone'));
  assert.ok(!ctx.isLookupPage('https://example.com/hal-00877723'));
});

test('arXiv DOIs, titles and arXiv API answers are read', () => {
  const ctx = loadBackground(fakeBrowser());
  assert.strictEqual(ctx.arxivIdFromDoi('10.48550/arXiv.2301.00001'), '2301.00001');
  assert.strictEqual(ctx.arxivIdFromDoi('https://doi.org/10.48550/ARXIV.math/0211159'), 'math/0211159');
  assert.strictEqual(ctx.arxivIdFromDoi('10.1007/s00440-013-0512-3'), null);
  assert.strictEqual(ctx.normalizeTitle('The glassy phase of complex  Brownian motion.'), ctx.normalizeTitle('The Glassy Phase of Complex Brownian Motion'));
  assert.strictEqual(ctx.normalizeTitle('Sur les équations de $\\mathbb{R}^n$'), 'sur les equations de r n');
  const feed = `<feed><title>arXiv Query</title><entry><id>http://arxiv.org/abs/1310.7775v3</id>
    <title>The glassy phase of complex
      branching Brownian motion &amp; more</title></entry></feed>`;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.parseArxivFeed(feed))), [
    { id: '1310.7775', title: 'The glassy phase of complex branching Brownian motion & more' },
  ]);
});

function fakeFetch(routes, log = []) {
  return async (url) => {
    log.push(url);
    const hit = Object.keys(routes).find((k) => url.startsWith(k));
    if (!hit) return { ok: false, status: 404 };
    const body = routes[hit];
    return { ok: true, status: 200, json: async () => body, text: async () => body };
  };
}

test('resolvePaper: metadata first, then the HAL API, then an exact title match on arXiv', async () => {
  const ctx = loadBackground(fakeBrowser());
  const HAL = 'https://api.archives-ouvertes.fr/search/';
  const ARXIV = 'https://export.arxiv.org/api/query';
  const feed = (id, title) => `<feed><entry><id>http://arxiv.org/abs/${id}</id><title>${title}</title></entry></feed>`;

  // An arXiv DOI in the page's metadata needs no lookup; other DOIs are ignored.
  const log = [];
  assert.strictEqual(await ctx.resolvePaper({ ids: ['10.1007/s1234567', '10.48550/arXiv.2301.00001'] }, fakeFetch({}, log)), '2301.00001');
  assert.deepStrictEqual(log, []);

  // HAL knows the arXiv id.
  const hal = { response: { docs: [{ arxivId_s: '1310.7775', title_s: ['The glassy phase'] }] } };
  assert.strictEqual(await ctx.resolvePaper({ halId: 'hal-00877723' }, fakeFetch({ [HAL]: hal })), '1310.7775');

  // HAL does not: search arXiv for its title, and accept only the same title.
  const noArxiv = { response: { docs: [{ title_s: ['Branching random walks in random environment'] }] } };
  const log2 = [];
  assert.strictEqual(await ctx.resolvePaper({ halId: 'hal-01234567' }, fakeFetch({
    [HAL]: noArxiv,
    [ARXIV]: feed('2001.00002v4', 'Branching Random Walks in Random Environment'),
  }, log2)), '2001.00002');
  assert.match(decodeURIComponent(log2[1]), /search_query=ti:"branching random walks in random environment"/);
  assert.strictEqual(await ctx.resolvePaper({ title: 'Branching random walks in random environment' }, fakeFetch({
    [ARXIV]: feed('2001.00003', 'Branching random walks in random environments and their scaling limits'),
  })), null);

  // Too short a title to trust; nothing to go on; network errors.
  assert.strictEqual(await ctx.resolvePaper({ title: 'Introduction' }, fakeFetch({}, log)), null);
  assert.strictEqual(await ctx.resolvePaper({}, fakeFetch({})), null);
  assert.strictEqual(await ctx.resolvePaper({ halId: 'hal-01234567', title: 'A long enough paper title' }, async () => { throw new Error('offline'); }), null);
});

test('on HAL and ResearchGate pages the toolbar button and page menu ask the page for its paper', async () => {
  const fake = fakeBrowser();
  const sent = [];
  fake.browser.tabs.sendMessage = async (tabId, msg) => { sent.push([tabId, msg.type]); return { ok: true }; };
  loadBackground(fake);
  fake.listeners.installed();
  assert.ok(fake.menus[1].documentUrlPatterns.includes('*://hal.science/*'));
  assert.ok(fake.menus[0].targetUrlPatterns.includes('*://*.alphaxiv.org/abs/*'));

  fake.listeners.action({ id: 3, index: 0, url: 'https://hal.science/hal-00877723v3' });
  fake.listeners.menu({ menuItemId: 'texglass-page', pageUrl: 'https://www.researchgate.net/publication/1_X' }, { id: 4, index: 0 });
  fake.listeners.action({ id: 5, index: 1, url: 'https://www.alphaxiv.org/overview/2301.00001' });
  await settle();
  assert.deepStrictEqual(sent, [[3, 'texglass-toolbar'], [4, 'texglass-toolbar']]);
  assert.strictEqual(fake.tabs[0].url, 'moz-extension://abc/index.html?arxiv=2301.00001');

  // No script in the tab (it was open before the extension was installed): open the viewer.
  fake.browser.tabs.sendMessage = async () => { throw new Error('no receiver'); };
  fake.listeners.action({ id: 6, index: 2, url: 'https://hal.science/hal-00877723' });
  await settle();
  assert.strictEqual(fake.tabs[1].url, 'moz-extension://abc/index.html');
});

test('the manifests run sites.js on alphaXiv, HAL and ResearchGate and may ask the HAL API', () => {
  for (const target of ['chrome', 'firefox']) {
    const m = manifest(target);
    const sites = m.content_scripts.find((c) => c.js.includes('sites.js'));
    assert.ok(sites, target);
    for (const host of ['alphaxiv.org', 'hal.science', 'researchgate.net']) {
      assert.ok(sites.matches.some((p) => p.includes(host)), host);
    }
    assert.ok(m.host_permissions.includes('https://api.archives-ouvertes.fr/*'));
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'browser/src/sites.js')));
});
