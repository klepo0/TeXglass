/*
 * Share: a link that opens the paper being read in the public TeXglass viewer.
 *
 * A paper from arXiv is shared as https://texglass.js.org/?arxiv=<id>,
 * one from GitHub as ...?gh=<link>. Where the reader is (the section at the top
 * of the page) rides along as &goto=§2.3, which the viewer already follows
 * (the same name the Go to box takes). The link always points at the public
 * viewer, also from the browser extension's own copy or a local server, so
 * whoever gets it can open it.
 *
 * On a phone or tablet the system share sheet opens (navigator.share); on a
 * computer the link is copied to the clipboard.
 *
 * Works in browsers; link() also in Node (tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeXglassShare = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PUBLIC = 'https://texglass.js.org/';

  /** What Go to takes for a section numbered `num`: "§2.3", or "Section A" for an appendix letter. */
  function sectionName(num) {
    const n = String(num || '').trim();
    if (!n) return '';
    return /\d/.test(n) ? '§' + n : 'Section ' + n;
  }

  /**
   * The link to share, or null when the paper has no public home.
   * { arxiv, gh, goto }: an arXiv id, or a GitHub link; goto: where to open it.
   */
  function link(where) {
    const w = where || {};
    const params = new URLSearchParams();
    if (w.arxiv) params.set('arxiv', String(w.arxiv).replace(/^arxiv:/i, ''));
    else if (w.gh && /^https:\/\/github\.com\//.test(w.gh)) params.set('gh', w.gh);
    else return null;
    if (w.goto) params.set('goto', w.goto);
    // keep it readable: § and / need no escaping in a query
    return PUBLIC + '?' + params.toString().replace(/%C2%A7/g, '§').replace(/%2F/gi, '/').replace(/%3A/gi, ':');
  }

  /** Touch-first devices get the share sheet; computers get the clipboard. */
  function prefersSheet(win) {
    const w = win || (typeof window !== 'undefined' ? window : null);
    if (!w || !w.navigator || typeof w.navigator.share !== 'function') return false;
    return !!(w.matchMedia && w.matchMedia('(pointer: coarse)').matches);
  }

  async function copy(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall back below */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) {
      return false;
    }
  }

  /**
   * Share `url` (with `title`): 'shared', 'copied', 'cancelled' or 'failed'.
   */
  async function share(url, title) {
    if (prefersSheet()) {
      try {
        await navigator.share({ title: title || 'TeXglass', text: title ? `${title} (in TeXglass)` : undefined, url });
        return 'shared';
      } catch (e) {
        if (e && e.name === 'AbortError') return 'cancelled';
        // not allowed here: copy instead
      }
    }
    return (await copy(url)) ? 'copied' : 'failed';
  }

  return { PUBLIC, link, sectionName, prefersSheet, share };
});
