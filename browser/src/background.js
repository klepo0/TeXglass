/*
 * TeXglass for arXiv: background script.
 *
 * Opens arXiv papers in the TeXglass viewer from three places:
 *   - the toolbar button, on an arXiv or alphaXiv paper page, or on a HAL or
 *     ResearchGate page of a paper that is also on arXiv;
 *   - the right-click menu, on a link to an arXiv or alphaXiv paper or on
 *     one of those pages;
 *   - the "View in TeXglass" links that content.js adds to arXiv pages and
 *     sites.js to alphaXiv, HAL and ResearchGate pages.
 *
 * HAL and ResearchGate pages do not carry the paper's arXiv id in their
 * address, so sites.js sends what it finds on the page (a HAL id, a DOI, the
 * title) and resolvePaper() looks it up: the HAL API knows the arXiv id of
 * deposits that came from arXiv, and otherwise arXiv's API is searched for a
 * paper with exactly the same title.
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
const ALPHAXIV_PATHS = ['abs', 'overview', 'pdf'];
const LINK_PATTERNS = [
  ...ARXIV_PATHS.map((p) => `*://*.arxiv.org/${p}/*`),
  ...ALPHAXIV_PATHS.map((p) => `*://*.alphaxiv.org/${p}/*`),
];
const PAGE_PATTERNS = [
  ...['abs', 'pdf', 'html'].map((p) => `*://*.arxiv.org/${p}/*`),
  ...ALPHAXIV_PATHS.map((p) => `*://*.alphaxiv.org/${p}/*`),
];
/** Pages whose paper sites.js has to find (see resolvePaper). */
const LOOKUP_PATTERNS = [
  '*://hal.science/*', '*://*.hal.science/*', '*://*.archives-ouvertes.fr/*', '*://hal.inrae.fr/*',
  '*://*.researchgate.net/publication/*',
];

function parseUrl(url) {
  try {
    return new URL(url);
  } catch (e) {
    return null;
  }
}

/** The arXiv id in a link to an arXiv or alphaXiv paper, or null for any other link. */
function arxivId(url) {
  const u = parseUrl(url);
  if (!u) return null;
  const first = u.pathname.split('/')[1];
  if (/(^|\.)arxiv\.org$/i.test(u.hostname)) {
    if (!ARXIV_PATHS.includes(first)) return null;
  } else if (/(^|\.)alphaxiv\.org$/i.test(u.hostname)) {
    if (!ALPHAXIV_PATHS.includes(first)) return null;
    // alphaxiv.org/abs/<id>, /overview/<id>, /pdf/<id>, sometimes with more after the id.
    const rest = u.pathname.split('/').slice(1, 4).join('/');
    return TeXglassArxiv.parseId(rest) || TeXglassArxiv.parseId(u.pathname.split('/').slice(1, 3).join('/'));
  } else return null;
  return TeXglassArxiv.parseId(u.origin + u.pathname);
}

/** Whether `url` is a HAL or ResearchGate page, whose paper sites.js finds. */
function isLookupPage(url) {
  const u = parseUrl(url);
  return !!u && /^https?:$/.test(u.protocol) &&
    (/(^|\.)hal\.science$|\.archives-ouvertes\.fr$|^hal\.inrae\.fr$/i.test(u.hostname) ||
      (/(^|\.)researchgate\.net$/i.test(u.hostname) && /^\/publication\//.test(u.pathname)));
}

/** The arXiv id in a DOI that arXiv assigned (10.48550/arXiv.<id>), or null. */
function arxivIdFromDoi(doi) {
  const m = String(doi || '').trim().match(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?10\.48550\/arxiv\.(.+)$/i);
  return m ? TeXglassArxiv.parseId(m[1]) : null;
}

/** A title reduced to lowercase letters and digits, for comparing titles from different sites. */
function normalizeTitle(t) {
  return String(t || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\\[a-z]+|[$^_{}]/gi, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => XML_ENTITIES[e]);

/** The papers in an arXiv API (Atom) answer, as [{ id, title }]; the id has no version. */
function parseArxivFeed(xml) {
  const papers = [];
  for (const [, entry] of String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const idTag = entry.match(/<id>\s*([^<]+?)\s*<\/id>/);
    const titleTag = entry.match(/<title>([\s\S]*?)<\/title>/);
    const id = idTag && TeXglassArxiv.parseId(idTag[1]);
    if (!id || !titleTag) continue;
    papers.push({ id: id.replace(/v\d+$/, ''), title: unescapeXml(titleTag[1]).replace(/\s+/g, ' ').trim() });
  }
  return papers;
}

/** The arXiv paper whose title is `title` (ignoring case, accents, punctuation and TeX), or null. */
async function searchArxivTitle(title, fetchFn = fetch) {
  const want = normalizeTitle(title);
  // Short titles ("Introduction", "Preface") would match unrelated papers.
  if (want.split(' ').length < 3 || want.length < 15) return null;
  const query = `ti:"${want}"`;
  const res = await fetchFn(`https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&max_results=10`);
  if (!res.ok) return null;
  const hit = parseArxivFeed(await res.text()).find((p) => normalizeTitle(p.title) === want);
  return hit ? hit.id : null;
}

/** The arXiv id and title that the HAL API records for HAL deposit `halId` (e.g. hal-00877723). */
async function lookupHal(halId, fetchFn = fetch) {
  const q = `halId_s:${halId.replace(/v\d+$/, '')}`;
  const res = await fetchFn(`https://api.archives-ouvertes.fr/search/?q=${encodeURIComponent(q)}&fl=arxivId_s,doiId_s,title_s&wt=json`);
  if (!res.ok) return {};
  const doc = ((await res.json()).response || {}).docs || [];
  const d = doc[0] || {};
  return {
    arxiv: TeXglassArxiv.parseId(d.arxivId_s || '') || arxivIdFromDoi(d.doiId_s),
    title: Array.isArray(d.title_s) ? d.title_s[0] : d.title_s,
  };
}

/**
 * The arXiv id of the paper described by `hints`, which sites.js gathers on a
 * page: { ids: [arXiv ids or DOIs named in the page's metadata], halId, title }.
 * Null when the paper is not found on arXiv.
 */
async function resolvePaper(hints, fetchFn = fetch) {
  hints = hints || {};
  for (const s of hints.ids || []) {
    const isDoi = /^\s*(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?10\./i.test(s);
    const id = isDoi ? arxivIdFromDoi(s) : TeXglassArxiv.parseId(s);
    if (id) return id;
  }
  let title = hints.title;
  if (hints.halId) {
    try {
      const hal = await lookupHal(hints.halId, fetchFn);
      if (hal.arxiv) return hal.arxiv;
      title = title || hal.title;
    } catch (e) {
      // HAL unreachable: try the title.
    }
  }
  if (!title) return null;
  try {
    return await searchArxivTitle(title, fetchFn);
  } catch (e) {
    return null;
  }
}

// Lookups already made, so revisiting a page or clicking twice asks nobody again.
const resolved = new Map();
function resolveCached(hints) {
  const key = JSON.stringify(hints || {});
  if (!resolved.has(key)) {
    const p = resolvePaper(hints).then((id) => {
      if (!id) resolved.delete(key); // a later visit may find it (e.g. after a network error)
      return id;
    });
    resolved.set(key, p);
    if (resolved.size > 200) resolved.delete(resolved.keys().next().value);
  }
  return resolved.get(key);
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

/** Asks the tab's sites.js to open its paper; it shows a note on the page when there is none. */
function openFromPage(tab) {
  try {
    const p = api.tabs.sendMessage(tab.id, { type: 'texglass-toolbar' });
    if (p && p.catch) p.catch(() => openViewer(null, tab));
  } catch (e) {
    openViewer(null, tab);
  }
}

api.action.onClicked.addListener((tab) => {
  const url = tab && tab.url;
  const id = url ? arxivId(url) : null;
  if (!id && url && isLookupPage(url) && tab.id != null) openFromPage(tab);
  else openViewer(id, tab);
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
      documentUrlPatterns: [...PAGE_PATTERNS, ...LOOKUP_PATTERNS],
    });
  });
}

api.runtime.onInstalled.addListener(createMenus);
if (api.runtime.onStartup) api.runtime.onStartup.addListener(createMenus);

api.contextMenus.onClicked.addListener((info, tab) => {
  const url = info.menuItemId === 'texglass-link' ? info.linkUrl : info.frameUrl || info.pageUrl;
  const id = url && arxivId(url);
  if (id) openViewer(id, tab);
  else if (info.menuItemId === 'texglass-page' && tab && tab.id != null && isLookupPage(url)) openFromPage(tab);
});

// --- links added to pages ------------------------------------------------------------

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'texglass-open' && typeof msg.id === 'string') {
    const id = TeXglassArxiv.parseId(msg.id);
    if (id) openViewer(id, sender.tab);
  } else if (msg && msg.type === 'texglass-resolve') {
    resolveCached(msg.hints).then((id) => sendResponse({ id }), () => sendResponse({ id: null }));
    return true; // answers asynchronously
  }
  return false;
});

if (typeof module === 'object' && module.exports) {
  module.exports = { arxivId, viewerUrl, isLookupPage, arxivIdFromDoi, normalizeTitle, parseArxivFeed, resolvePaper };
}
