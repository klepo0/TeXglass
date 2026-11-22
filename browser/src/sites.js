/*
 * TeXglass for arXiv: a "View in TeXglass" button on pages of other sites
 * that show arXiv papers.
 *
 *   - alphaXiv (alphaxiv.org/abs/<id>, /overview/<id>): the arXiv id is in the
 *     address. alphaXiv changes pages without reloading, so the address is
 *     watched and the button follows it.
 *   - HAL (hal.science and its portals): the page's HAL id is looked up in the
 *     HAL API, which records the arXiv id of deposits that are also on arXiv.
 *   - ResearchGate (researchgate.net/publication/...): an arXiv DOI in the
 *     page's metadata, or else arXiv is searched for the page's exact title.
 *
 * The lookups run in the background script (see resolvePaper there); the
 * button appears only once the paper is found on arXiv, since TeXglass needs
 * the LaTeX source that arXiv keeps. The toolbar button asks this script for
 * the paper too and, when there is none, gets a short note on the page.
 */
(function () {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  if (document.documentElement.dataset.texglass) return;
  document.documentElement.dataset.texglass = '1';

  const TITLE = 'Render the LaTeX source of this paper (from arXiv) in TeXglass';
  const host = location.hostname;
  const site = /(^|\.)alphaxiv\.org$/.test(host) ? 'alphaxiv'
    : /(^|\.)researchgate\.net$/.test(host) ? 'researchgate'
      : 'hal';

  const ID = '(?:\\d{4}\\.\\d{4,5}|[a-z-]+(?:\\.[A-Z]{2})?\\/\\d{7})(?:v\\d+)?';

  const WEB_VIEWER = 'https://texglass.js.org/';

  /** Whether this script can still talk to the extension (not after an update or reload). */
  const connected = () => {
    try {
      return !!(api && api.runtime && api.runtime.id);
    } catch (e) {
      return false;
    }
  };

  function send(msg) {
    try {
      return Promise.resolve(api.runtime.sendMessage(msg));
    } catch (e) {
      // The extension was updated or removed since this page loaded.
      return Promise.resolve(null);
    }
  }

  // --- what the page says about its paper -----------------------------------------

  const meta = (...names) => {
    for (const n of names) {
      const el = document.querySelector(`meta[name="${n}"], meta[property="${n}"]`);
      const v = el && el.getAttribute('content');
      if (v && v.trim()) return v.trim();
    }
    return '';
  };

  function alphaxivId() {
    const m = location.pathname.match(new RegExp(`^/(?:abs|overview|pdf)/(${ID})(?:[/?#.]|$)`, 'i'));
    return m ? m[1] : null;
  }

  function halHints() {
    // hal.science/hal-00877723v3, /tel-01234567/document, inria.hal.science/inria-00000001 ...
    const m = location.pathname.match(/^\/([a-z][a-z0-9_]*(?:-[a-z0-9_]+)*-\d{8})(?:v\d+)?(?:[/?#]|$)/i);
    if (!m) return null;
    return { halId: m[1], title: meta('citation_title', 'DC.title') || undefined };
  }

  function researchgateHints() {
    if (!/^\/publication\//.test(location.pathname)) return null;
    const ids = [meta('citation_arxiv_id'), meta('citation_doi', 'DC.identifier')].filter(Boolean);
    let title = meta('citation_title', 'og:title') ||
      (document.querySelector('h1') || {}).textContent ||
      document.title;
    title = (title || '').replace(/^\s*\((?:PDF|DOC|PPT)\)\s*/i, '').replace(/\s*\|\s*ResearchGate\s*$/i, '').trim();
    if (!title) {
      // researchgate.net/publication/123456789_Title_of_the_Paper
      const m = location.pathname.match(/^\/publication\/\d+_(.+)$/);
      if (m) title = decodeURIComponent(m[1]).replace(/_/g, ' ');
    }
    return { ids, title: title || undefined };
  }

  /** The arXiv id of this page's paper, or null. */
  async function find() {
    if (site === 'alphaxiv') return alphaxivId();
    const hints = site === 'hal' ? halHints() : researchgateHints();
    if (!hints) return null;
    const answer = await send({ type: 'texglass-resolve', hints });
    return (answer && answer.id) || null;
  }

  // --- the button --------------------------------------------------------------------

  let button = null;
  let current = null; // the promise of the arXiv id for the current address

  function show(id) {
    if (!document.body) return;
    if (!button) {
      button = document.createElement('a');
      button.target = '_blank';
      button.rel = 'noopener';
      button.className = 'texglass-float';
      button.textContent = 'View in TeXglass';
      const go = (e) => {
        if (e.type === 'auxclick' && e.button !== 1) return;
        // When the extension was updated or reloaded since this page loaded, it
        // can't be reached and the link opens the paper in the web viewer instead.
        if (!button.dataset.arxivId || !connected()) return;
        e.preventDefault();
        send({ type: 'texglass-open', id: button.dataset.arxivId });
      };
      button.addEventListener('click', go);
      button.addEventListener('auxclick', go);
    }
    button.dataset.arxivId = id;
    button.href = `${WEB_VIEWER}?arxiv=${encodeURIComponent(id)}`;
    button.title = `${TITLE}: arXiv:${id}`;
    if (!button.isConnected) document.body.appendChild(button);
  }

  function hide() {
    if (button) button.remove();
  }

  function note(text) {
    if (!document.body) return;
    const n = document.createElement('div');
    n.className = 'texglass-note';
    n.setAttribute('role', 'status');
    n.textContent = text;
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 4000);
  }

  function update() {
    const p = find().catch(() => null);
    current = p;
    p.then((id) => {
      if (current !== p) return; // the address changed meanwhile
      if (id) show(id);
      else hide();
    });
  }

  update();

  if (site === 'alphaxiv') {
    let last = location.href;
    setInterval(() => {
      if (location.href !== last) {
        last = location.href;
        update();
      }
    }, 800);
  }

  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'texglass-toolbar') {
      sendResponse({ ok: true });
      (current || Promise.resolve(null)).then((id) => {
        if (id) send({ type: 'texglass-open', id });
        else note('TeXglass found no arXiv version of a paper on this page.');
      });
    }
    return false;
  });
})();
