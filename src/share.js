/*
 * Share: a link that opens the paper being read in the public TeXglass viewer.
 *
 * A paper from arXiv is shared as https://klepo0.github.io/TeXglass/?arxiv=<id>,
 * one from GitHub as ...?gh=<link>. Where the reader is (the section at the top
 * of the page) rides along as &goto=§2.3, which the viewer already follows
 * (the same name the Go to box takes). The link always points at the public
 * viewer, also from the browser extension's own copy or a local server, so
 * whoever gets it can open it.
 *
 * The view on screen rides along too, as &view=…, so that whoever opens the
 * link sees the same thing: "Show only these" with the pinned results,
 * equations, figures and text (and the proofs opened in it), "What does this
 * use?" (or what uses it) with or without "Hide the rest", or a search by use.
 * The view is a small object (see encodeView), written as JSON, squeezed with
 * deflate where the browser can, in base64url. It names things by the keys the
 * map's pins use ("label:thm:main", "eq:(3.4)", "fig:Figure 2"), and pinned
 * text by its words, so it does not depend on how the page was drawn.
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

  const PUBLIC = 'https://klepo0.github.io/TeXglass/';

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
    if (w.view) params.set('view', w.view);
    // keep it readable: § and / need no escaping in a query
    return PUBLIC + '?' + params.toString().replace(/%C2%A7/g, '§').replace(/%2F/gi, '/').replace(/%3A/gi, ':');
  }

  // --- the view, in a link --------------------------------------------------------
  //
  // A view: { m: 'p' | 'u' | 's', ... }
  //   'p' Show only these: p: [[key, d]] the map's pins (d: 'self', 'uses',
  //       'usedBy', 'both'), t: [{ q, a, b }] pinned text (quote, before, after),
  //       o: [key] results whose proof was opened
  //   'u' What does this use?: f: the result's key, d: 'uses' | 'usedBy' | 'both', h: 1 with Hide the rest
  //   's' search by use: s: { inc: [key], exc: [key], any, direct }, h: 1 with Hide the rest

  const MODES = { p: 1, u: 1, s: 1 };
  const DIRS = { self: 1, uses: 1, usedBy: 1, both: 1 };

  function toB64url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromB64url(str) {
    const bin = atob(String(str).replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  async function pipe(bytes, Stream) {
    const res = new Response(new Blob([bytes]).stream().pipeThrough(new Stream('deflate-raw')));
    return new Uint8Array(await res.arrayBuffer());
  }
  const canSqueeze = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function' && typeof Response === 'function' && typeof Blob === 'function';

  /** Keep only what a view may hold, so a link can't carry anything else. */
  function clean(v) {
    if (!v || typeof v !== 'object' || !MODES[v.m]) return null;
    const str = (x, max) => (typeof x === 'string' && x && x.length <= (max || 300) ? x : null);
    const keys = (xs) => (Array.isArray(xs) ? xs.map((x) => str(x)).filter(Boolean).slice(0, 200) : []);
    const out = { m: v.m };
    if (v.m === 'p') {
      out.p = (Array.isArray(v.p) ? v.p : []).map((e) => (typeof e === 'string' ? [e, 'self'] : e))
        .filter((e) => Array.isArray(e) && str(e[0]) && DIRS[e[1]]).map((e) => [e[0], e[1]]).slice(0, 200);
      out.t = (Array.isArray(v.t) ? v.t : []).filter((t) => t && str(t.q, 400))
        .map((t) => ({ q: t.q, a: typeof t.a === 'string' ? t.a.slice(-16) : '', b: typeof t.b === 'string' ? t.b.slice(0, 16) : '' })).slice(0, 100);
      out.o = keys(v.o);
      if (!out.p.length && !out.t.length) return null;
    } else if (v.m === 'u') {
      if (!str(v.f) || !DIRS[v.d] || v.d === 'self') return null;
      out.f = v.f;
      out.d = v.d;
    } else {
      const s = v.s || {};
      out.s = { inc: keys(s.inc), exc: keys(s.exc), any: !!s.any, direct: !!s.direct };
      if (!out.s.inc.length && !out.s.exc.length) return null;
    }
    if (v.m !== 'p' && v.h) out.h = 1;
    return out;
  }

  /** The view as it goes in a link: '1' + base64url(JSON), or '2' + the same squeezed. Null for no view. */
  async function encodeView(view) {
    const v = clean(view);
    if (!v) return null;
    // a pin with nothing brought along is just its key
    if (v.m === 'p') {
      v.p = v.p.map((e) => (e[1] === 'self' ? e[0] : e));
      for (const k of ['t', 'o']) if (!v[k].length) delete v[k];
    }
    const bytes = new TextEncoder().encode(JSON.stringify(v));
    const plain = '1' + toB64url(bytes);
    if (!canSqueeze()) return plain;
    try {
      const small = '2' + toB64url(await pipe(bytes, CompressionStream));
      return small.length < plain.length ? small : plain;
    } catch (e) {
      return plain;
    }
  }

  /** The view a link carries, or null if it is missing or can't be read. */
  async function decodeView(str) {
    try {
      const s = String(str || '');
      let bytes;
      if (s[0] === '1') bytes = fromB64url(s.slice(1));
      else if (s[0] === '2' && canSqueeze()) bytes = await pipe(fromB64url(s.slice(1)), DecompressionStream);
      else return null;
      return clean(JSON.parse(new TextDecoder().decode(bytes)));
    } catch (e) {
      return null;
    }
  }

  /** How the status line names a view: "the 4 pinned items", "what Lemma 2 uses". */
  function describeView(v, nameOf) {
    const name = (k) => (nameOf ? nameOf(k) : String(k).replace(/^(label|name|eq|fig):/, ''));
    if (!v) return '';
    if (v.m === 'p') {
      const n = v.p.length + v.t.length;
      return `${n} pinned item${n === 1 ? '' : 's'}`;
    }
    if (v.m === 'u') return v.d === 'usedBy' ? `what uses ${name(v.f)}` : v.d === 'both' ? `what ${name(v.f)} uses and what uses it` : `what ${name(v.f)} uses`;
    return 'a search by use';
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

  return { PUBLIC, link, sectionName, prefersSheet, share, encodeView, decodeView, describeView };
});
