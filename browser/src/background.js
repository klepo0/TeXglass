/*
 * TeXglass for arXiv: background script.
 *
 * Opens arXiv papers in the TeXglass viewer from three places:
 *   - the toolbar button, on an arXiv abs/pdf/html page;
 *   - the right-click menu, on a link to an arXiv paper or on an arXiv page;
 *   - the "View in TeXglass" links that content.js adds to arXiv pages.
 *
 * The viewer is either the copy bundled with the extension (default) or the
 * hosted web viewer; both take ?arxiv=<id> and download the LaTeX source from
 * arxiv.org/src/<id> themselves, unpack it, find the main file and inline its
 * \input/\include files.
 *
 * Runs as a service worker in Chrome and Edge and as an event page in Firefox.
 */
/* global importScripts, TeXglassArxiv */
'use strict';

if (typeof importScripts === 'function' && typeof TeXglassArxiv === 'undefined') {
  importScripts('src/arxiv.js');
}

const api = globalThis.browser || globalThis.chrome;

const DEFAULTS = { viewer: 'builtin', webUrl: 'https://klepo0.github.io/TeXglass/' };

const ARXIV_PATHS = ['abs', 'pdf', 'html', 'src', 'e-print'];
const LINK_PATTERNS = ARXIV_PATHS.map((p) => `*://*.arxiv.org/${p}/*`);
const PAGE_PATTERNS = ['abs', 'pdf', 'html'].map((p) => `*://*.arxiv.org/${p}/*`);

/** The arXiv id in a link to an arXiv paper, or null for any other link. */
function arxivId(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return null;
  }
  if (!/(^|\.)arxiv\.org$/i.test(u.hostname)) return null;
  const first = u.pathname.split('/')[1];
  if (!ARXIV_PATHS.includes(first)) return null;
  return TeXglassArxiv.parseId(u.origin + u.pathname);
}

async function settings() {
  try {
    return Object.assign({}, DEFAULTS, await api.storage.sync.get(DEFAULTS));
  } catch (e) {
    return DEFAULTS;
  }
}

/** The viewer URL that opens paper `id` (or the viewer alone when id is null). */
async function viewerUrl(id) {
  const s = await settings();
  const query = id ? `?arxiv=${encodeURIComponent(id)}` : '';
  if (s.viewer === 'web' && /^https?:\/\//i.test(s.webUrl)) {
    const base = new URL(s.webUrl);
    base.search = query;
    base.hash = '';
    return base.href;
  }
  return api.runtime.getURL('index.html') + query;
}

async function openViewer(id, tab) {
  const props = { url: await viewerUrl(id) };
  if (tab && tab.id != null && tab.id >= 0) {
    props.index = tab.index + 1;
    props.openerTabId = tab.id;
  }
  try {
    await api.tabs.create(props);
  } catch (e) {
    // openerTabId is refused for some tabs (e.g. Firefox private windows); try plainly.
    await api.tabs.create({ url: props.url });
  }
}

// --- toolbar button ------------------------------------------------------------

api.action.onClicked.addListener((tab) => {
  openViewer(tab && tab.url ? arxivId(tab.url) : null, tab);
});

// --- right-click menu ----------------------------------------------------------

function createMenus() {
  api.contextMenus.removeAll(() => {
    api.contextMenus.create({
      id: 'texglass-link',
      title: 'Open arXiv paper in TeXglass',
      contexts: ['link'],
      targetUrlPatterns: LINK_PATTERNS,
    });
    api.contextMenus.create({
      id: 'texglass-page',
      title: 'View this paper in TeXglass',
      contexts: ['page', 'frame'],
      documentUrlPatterns: PAGE_PATTERNS,
    });
  });
}

api.runtime.onInstalled.addListener(createMenus);
if (api.runtime.onStartup) api.runtime.onStartup.addListener(createMenus);

api.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.menuItemId === 'texglass-link' ? info.linkUrl : info.frameUrl || info.pageUrl;
  const id = url && arxivId(url);
  if (id) openViewer(id, tab);
});

// --- links added to arXiv pages --------------------------------------------------

api.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'texglass-open' && typeof msg.id === 'string') {
    const id = TeXglassArxiv.parseId(msg.id);
    if (id) openViewer(id, sender.tab);
  }
  return false;
});

if (typeof module === 'object' && module.exports) module.exports = { arxivId, viewerUrl };
