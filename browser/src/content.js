/*
 * TeXglass for arXiv: adds "View in TeXglass" links to arXiv pages.
 *
 *   - abstract pages (arxiv.org/abs/<id>): a button under "Access Paper";
 *   - listing pages (arxiv.org/list/...): a "texglass" link next to pdf/html/other;
 *   - HTML papers (arxiv.org/html/<id>): a small floating button.
 *
 * A click asks the background script to open the paper, so the viewer opens
 * in a new tab next to this one whichever viewer is chosen in the options.
 * Each link also points at the paper in the hosted web viewer, which is what
 * it opens when the extension can no longer be reached: after the extension
 * is updated or reloaded, scripts in pages that were already open are cut off
 * from it, and their links used to do nothing until the page was reloaded.
 */
(function () {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  if (document.documentElement.dataset.texglass) return;
  document.documentElement.dataset.texglass = '1';

  const TITLE = 'Render the LaTeX source of this paper in TeXglass';

  const WEB_VIEWER = 'https://klepo0.github.io/TeXglass/';

  const webUrl = (id, compare) => `${WEB_VIEWER}?arxiv=${encodeURIComponent(id)}` + (compare ? `&compare=${encodeURIComponent(compare)}` : '');

  /** Whether this script can still talk to the extension (not after an update or reload). */
  const connected = () => {
    try {
      return !!(api && api.runtime && api.runtime.id);
    } catch (e) {
      return false;
    }
  };

  /** Asks the background script to open paper `id`; false when the extension can't be reached. */
  function open(id, compare) {
    if (!connected()) return false;
    try {
      const p = api.runtime.sendMessage(compare ? { type: 'texglass-open', id, compare } : { type: 'texglass-open', id });
      // Lost on the way (the extension went away just now): use the web viewer.
      if (p && p.catch) p.catch(() => window.open(webUrl(id, compare), '_blank', 'noopener'));
      return true;
    } catch (e) {
      return false;
    }
  }

  function link(id, text, className, compare) {
    const a = document.createElement('a');
    a.href = webUrl(id, compare);
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = text;
    a.title = compare ? `Show what changed in this paper since ${compare}, in TeXglass` : TITLE;
    a.className = className;
    a.dataset.arxivId = id;
    const go = (e) => {
      if (e.type === 'auxclick' && e.button !== 1) return;
      // Without the extension the link itself opens the paper in the web viewer.
      if (open(id, compare)) e.preventDefault();
    };
    a.addEventListener('click', go);
    a.addEventListener('auxclick', go);
    return a;
  }

  const idFromPath = (path) => {
    const m = path.match(/^\/(?:abs|html|pdf)\/((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?)/i);
    return m ? m[1] : null;
  };

  /** The version this abstract page shows: from its address, or else the latest in the submission history. */
  function versionShown(id) {
    const m = /v(\d+)$/.exec(id);
    if (m) return Number(m[1]);
    let n = 0;
    for (const el of document.querySelectorAll('.submission-history a, .submission-history strong')) {
      const v = /^\[v(\d+)\]$/.exec(el.textContent.trim());
      if (v) n = Math.max(n, Number(v[1]));
    }
    return n;
  }

  const page = location.pathname.split('/')[1];

  if (page === 'abs') {
    const id = idFromPath(location.pathname);
    const list = document.querySelector('.full-text ul');
    if (id && list) {
      const li = document.createElement('li');
      li.appendChild(link(id, 'View in TeXglass', 'abs-button texglass-abs'));
      list.appendChild(li);
      // More than one version: compare the one shown with the one before it.
      const shown = versionShown(id);
      if (shown > 1) {
        const cmp = document.createElement('li');
        cmp.appendChild(link(id.replace(/v\d+$/, '') + 'v' + shown, `Compare v${shown - 1} → v${shown}`, 'abs-button texglass-abs texglass-compare', 'v' + (shown - 1)));
        list.appendChild(cmp);
      }
    }
  } else if (page === 'list' || page === 'catchup') {
    for (const other of document.querySelectorAll('dt a[title="Other formats"]')) {
      const id = (other.id || '').replace(/^oth-/, '') || idFromPath(other.pathname.replace(/^\/format/, '/abs'));
      if (!id) continue;
      other.after(document.createTextNode(', '), link(id, 'texglass', 'texglass-list'));
    }
  } else if (page === 'html') {
    const id = idFromPath(location.pathname);
    if (id && document.body) {
      const a = link(id, 'View in TeXglass', 'texglass-float');
      document.body.appendChild(a);
    }
  }
})();
