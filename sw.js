/*
 * Offline cache for the web viewer. After one visit the viewer opens and
 * renders without a connection: its own files and KaTeX (served from
 * vendor/katex) are kept in the browser's cache.
 *
 * The viewer's files are fetched from the network first, so a new version of
 * the site shows up on the next visit; the cache is only the fallback. KaTeX
 * never changes for a given version, so it comes from the cache first.
 * Requests to other sites (arXiv, GitHub) are left alone.
 */
'use strict';

const CACHE = 'texglass-v1';

const KATEX_FONTS = [
  'AMS-Regular', 'Caligraphic-Bold', 'Caligraphic-Regular', 'Fraktur-Bold', 'Fraktur-Regular',
  'Main-Bold', 'Main-BoldItalic', 'Main-Italic', 'Main-Regular', 'Math-BoldItalic', 'Math-Italic',
  'SansSerif-Bold', 'SansSerif-Italic', 'SansSerif-Regular', 'Script-Regular', 'Size1-Regular',
  'Size2-Regular', 'Size3-Regular', 'Size4-Regular', 'Typewriter-Regular',
].map((f) => `vendor/katex/fonts/KaTeX_${f}.woff2`);

const PRECACHE = [
  './',
  'index.html',
  'app.js',
  'styles.css',
  // the handwritten-notes look, shared with the VS Code extension (Kalam is the web viewer's hand)
  'vscode/media/notes.css',
  'vscode/ink.js',
  ...['kalam-latin-400-normal', 'kalam-latin-ext-400-normal', 'kalam-latin-700-normal', 'kalam-latin-ext-700-normal']
    .map((f) => `vscode/media/fonts/${f}.woff2`),
  'vendor/katex/katex.min.js',
  'vendor/katex/katex.min.css',
  ...KATEX_FONTS,
  ...['arxiv', 'bib', 'cite', 'copytex', 'diagrams', 'editor', 'eps', 'export', 'find', 'github', 'insight', 'local', 'openai-math',
    'margin', 'render-worker', 'scroll', 'stats', 'texglass', 'tikz', 'zoom'].map((f) => `src/${f}.js`),
];

if (typeof module === 'object' && module.exports) module.exports = { CACHE, PRECACHE };

if (typeof self !== 'undefined' && self.registration) {
  self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      caches.keys()
        .then((keys) => Promise.all(keys.filter((k) => k.startsWith('texglass-') && k !== CACHE).map((k) => caches.delete(k))))
        .then(() => self.clients.claim())
    );
  });

  self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    if (url.pathname.includes('/vendor/katex/')) {
      event.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => keep(req, res))));
      return;
    }

    event.respondWith(
      fetch(req)
        .then((res) => keep(req, res))
        .catch(() =>
          caches.match(req, { ignoreSearch: req.mode === 'navigate' })
            .then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined))
            .then((hit) => hit || Response.error())
        )
    );
  });
}

function keep(req, res) {
  if (res && res.ok && res.type === 'basic') {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy));
  }
  return res;
}
