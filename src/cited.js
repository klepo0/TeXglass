/*
 * Cited results: resting on "[12, Theorem 4.1]" shows Theorem 4.1 of
 * reference 12 itself, rendered, under the citation's preview.
 *
 * The citation says which result it means, in its note ("\cite[Thm.~4.1]{key}",
 * shown as "[12, Thm. 4.1]") or just before it ("Theorem 4.1 of [12]",
 * "Lemmas 2.1 and 2.3 in [12]"). Once src/cite.js has found the cited paper
 * on arXiv, its LaTeX source is fetched and converted like any arXiv import
 * (the caller's loadPaper), and the result is found by its kind and number
 * among the paper's numbered things (TeXglassFind.collectTargets, the same list
 * Go to uses). A result numbered with another kind ("Proposition 4.1" where
 * the citation says "Theorem 4.1": a shared counter, or a renamed result) is
 * shown, and says so. A converted paper is kept for the visit; the statements
 * shown are kept in localStorage, so they come back at once, and offline.
 *
 *   const results = TeXglassCited.create({
 *     loadPaper(id) { ... },     // Promise of the HTML of arXiv paper `id`, converted
 *     storage,                   // optional: a localStorage-like object (default: localStorage, if it works)
 *   });
 *   const pins = TeXglassCited.pinpointsOf(link);  // the <a> of a citation -> [{ kind, num, name }]
 *   results.statements(id, pins)   // Promise of [{ pin, html, name, found, other }]
 *   results.stored(id, pins)       // the same, from storage only, or null
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./find.js'));
  else root.TeXglassCited = factory(root.TeXglassFind);
})(typeof self !== 'undefined' ? self : this, function (Find) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Which result a citation points at
  // ---------------------------------------------------------------------------

  // Kind words as papers write them, full or abbreviated, singular or plural.
  const KINDS = [
    ['theorem', /^(theorems?|thms?|th)$/],
    ['lemma', /^(lemmas?|lemmata|lems?|lma)$/],
    ['proposition', /^(propositions?|props?)$/],
    ['corollary', /^(corollar(y|ies)|cors?|coro|corr)$/],
    ['definition', /^(definitions?|defs?|defn|dfn)$/],
    ['remark', /^(remarks?|rems?|rmks?)$/],
    ['example', /^(examples?|exs?|exa|exm)$/],
    ['conjecture', /^(conjectures?|conjs?)$/],
    ['claim', /^claims?$/],
    ['assumption', /^(assumptions?|asm|assump)$/],
    ['hypothesis', /^(hypothes[ie]s|hyp)$/],
    ['condition', /^(conditions?|cond)$/],
    ['fact', /^facts?$/],
    ['observation', /^(observations?|obs)$/],
    ['problem', /^problems?$/],
    ['question', /^questions?$/],
    ['exercise', /^exercises?$/],
    ['notation', /^notations?$/],
    ['algorithm', /^algorithms?$/],
    ['equation', /^(equations?|eqs?|eqns?|formulas?|formulae|display)$/],
    ['section', /^(sections?|secs?|sect|§§?)$/],
    ['appendix', /^(appendix|appendices|app|apx)$/],
  ];
  const NAMES = { section: 'Section', appendix: 'Appendix', equation: 'Equation' };

  function kindOf(word) {
    const w = word.toLowerCase().replace(/\.$/, '');
    for (const [k, re] of KINDS) if (re.test(w)) return k;
    return null;
  }

  // 4.1, 2.3.5, 3a, A.2, A (Theorem A), 4.1'
  const NUM = /^(?:[A-Z]?\d+(?:\.\d+)*[a-z]?|[A-Z](?:\.\d+)*)['′]?$/;
  const MAX_PINS = 3;

  const label = (kind, num) =>
    kind === 'equation' ? `Equation (${num})` : `${NAMES[kind] || kind[0].toUpperCase() + kind.slice(1)} ${num}`;

  /**
   * The results a piece of text names, in groups of adjacent mentions:
   * "Theorem 4.1 and Lemma 2.3(ii)" -> one group of two; "Theorem 4.1, p. 5"
   * -> Theorem 4.1. Each pin is { kind, num, name }.
   */
  function scan(text) {
    const groups = [];
    let group = null;
    let kind = null;
    let last = null; // 'kind', 'num', 'join'
    const tokens = String(text || '').replace(/\s+/g, ' ').match(/§§?|\([^()]*\)|[A-Z](?:\.\d+)+['′]?|\d+(?:\.\d+)*[a-z]?['′]?|[\p{L}]+\.?|[,;&–—-]/gu) || [];
    const push = (k, num) => {
      num = num.replace(/\.$/, '');
      if (!group) groups.push((group = []));
      if (!group.some((p) => p.kind === k && p.num === num)) group.push({ kind: k, num, name: label(k, num) });
    };
    const stop = () => { group = null; kind = null; last = null; };
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t[0] === '(') {
        const inner = t.slice(1, -1).trim();
        // "(3.2)": an equation, unless it follows a result's number ("Lemma 2.3(ii)", "Theorem 4.1 (b)")
        if (last === 'num' && kind !== 'equation') continue;
        if (/^\d+(?:\.\d+)*[a-z]?$|^[A-Z]\.\d+(?:\.\d+)*$/.test(inner) && (!kind || kind === 'equation')) {
          if (!kind && last !== 'join') stop();
          push('equation', inner);
          kind = 'equation';
          last = 'num';
          continue;
        }
        stop();
        continue;
      }
      if (/^[,;&–—-]$/.test(t) || /^(and|or|to)$/i.test(t)) {
        if (t === ';') { stop(); continue; }
        if (kind) last = 'join';
        continue;
      }
      const k = /^[\p{L}§]/u.test(t) && !(last && last !== 'num' && kind && NUM.test(t)) ? kindOf(t) : null;
      if (k) {
        if (last !== 'join' && last !== 'num') group = null;
        kind = k;
        last = 'kind';
        continue;
      }
      if (kind && (last === 'kind' || last === 'join') && NUM.test(t.replace(/\.$/, ''))) {
        push(kind, t);
        last = 'num';
        continue;
      }
      stop();
    }
    return groups;
  }

  /** The results named in a citation's note, "[12, Theorem 4.1]": all of them, up to three. */
  function pinpointsInNote(note) {
    return [].concat(...scan(note)).slice(0, MAX_PINS);
  }

  /**
   * The results named just before a citation: "Theorem 4.1 of", "Lemmas 2.1
   * and 2.3 in", "see Section 3 from". Only the mentions that run up to the
   * "of"/"in"; "Lemma 2 holds by Theorem 4.1 of" names Theorem 4.1 only.
   */
  function pinpointsBefore(text) {
    const m = /^(.*?)[\s,]*\b(?:of|in|from)(?:\s+(?:the\s+)?(?:paper|book|monograph|article|preprint|work|notes|survey|thesis|ref\.?|reference))?\s*$/i.exec(String(text || '').replace(/\s+/g, ' ').slice(-160));
    if (!m) return [];
    const head = m[1];
    const groups = scan(head);
    if (!groups.length) return [];
    // the last group must reach the end of the text: nothing but its numbers and parts after it
    const tail = head.replace(/(\s*\([^()]*\))+\s*$/, '').trim();
    const g = groups[groups.length - 1];
    const lastPin = g[g.length - 1];
    if (!tail.endsWith(lastPin.num) && !tail.endsWith(lastPin.num + ')')) return [];
    return g.slice(0, MAX_PINS);
  }

  /** The text of a node, without KaTeX's MathML copy of each formula. */
  function textOf(node) {
    if (!node) return '';
    if (node.nodeType === 3) return node.nodeValue;
    if (node.nodeType !== 1) return '';
    if (node.classList && (node.classList.contains('katex-mathml') || node.classList.contains('bib-open'))) return '';
    if (node.classList && node.classList.contains('math') && node.getAttribute('data-tex')) return node.getAttribute('data-tex');
    let s = '';
    for (const c of node.childNodes) s += textOf(c);
    return s;
  }

  /**
   * The results a citation link points at: from its note when the citation
   * has one key ("[12, Theorem 4.1]"), else from the words just before it
   * ("Theorem 4.1 of [12]"). [] when it names none.
   */
  function pinpointsOf(link) {
    if (!link || !link.closest) return [];
    const cite = link.closest('.cite');
    if (!cite) return [];
    const keys = cite.querySelectorAll('a[href^="#"]');
    let note = '';
    let after = false;
    for (const c of cite.childNodes) {
      if (c === link || (c.contains && c.contains(link))) { after = true; continue; }
      if (after) note += textOf(c);
    }
    note = note.replace(/^[\s,;]+|[\s\]]+$/g, '');
    if (note && keys.length === 1) {
      const pins = pinpointsInNote(note);
      if (pins.length) return pins;
    }
    // the words before the citation, in its paragraph (or list item, theorem, cell)
    let before = '';
    const block = cite.parentElement && cite.parentElement.closest('p, li, td, dd, blockquote, .theorem, .proof, .env, div');
    if (block) {
      for (let n = cite; n && n !== block; n = n.parentElement) {
        for (let s = n.previousSibling; s && before.length < 200; s = s.previousSibling) before = textOf(s) + before;
        if (before.length >= 200) break;
      }
    }
    return pinpointsBefore(before);
  }

  // ---------------------------------------------------------------------------
  // Finding a result in a converted paper
  // ---------------------------------------------------------------------------

  const kindIs = (t, kind) => t.kinds.some((w) => w === kind || w.startsWith(kind));

  /**
   * The target in `targets` (TeXglassFind.collectTargets) that a pin names:
   * { target, other } where other is true for a result with this number but
   * another kind. null when there is none.
   */
  function match(targets, pin) {
    const num = pin.num.toLowerCase();
    const same = (t) => (t.num || '').toLowerCase() === num;
    if (pin.kind === 'equation') {
      const t = targets.find((x) => x.type === 'equation' && same(x));
      return t ? { target: t, other: false } : null;
    }
    if (pin.kind === 'section' || pin.kind === 'appendix') {
      const t = targets.find((x) => x.type === 'section' && same(x) && (pin.kind === 'section' || x.kinds.includes('appendix')));
      return t ? { target: t, other: false } : null;
    }
    let t = targets.find((x) => x.type === 'theorem' && same(x) && kindIs(x, pin.kind));
    if (t) return { target: t, other: false };
    t = targets.find((x) => x.type === 'theorem' && same(x));
    return t ? { target: t, other: true } : null;
  }

  const BLOCK_LIMIT = 4; // a section's preview: its heading and this many blocks
  const HTML_LIMIT = 120000;

  /** A result's HTML for the preview: no ids, its links to the cited paper's own parts as plain text, figures left out. */
  function statementHtml(target) {
    const doc = target.block.ownerDocument;
    const box = doc.createElement('div');
    if (target.type === 'section') {
      box.appendChild(target.block.cloneNode(true));
      let n = target.block.nextElementSibling;
      for (let k = 0; n && k < BLOCK_LIMIT && !/^H[1-6]$/.test(n.tagName) && !n.querySelector('h1, h2, h3, h4, h5, h6'); k++, n = n.nextElementSibling) {
        box.appendChild(n.cloneNode(true));
      }
    } else {
      box.appendChild(target.block.cloneNode(true));
    }
    box.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
    box.querySelectorAll('button, script, style, .fold-toggle, .uses-btn, .margin-note, .tg-margin').forEach((el) => el.remove());
    box.querySelectorAll('a[href]').forEach((a) => {
      if (/^https?:/i.test(a.getAttribute('href'))) {
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener');
        a.classList.add('cite-out');
        return;
      }
      const span = doc.createElement('span');
      span.className = 'cited-ref';
      while (a.firstChild) span.appendChild(a.firstChild);
      a.replaceWith(span);
    });
    box.querySelectorAll('img').forEach((img) => {
      if (/^(https?:|data:)/i.test(img.getAttribute('src') || '')) return;
      const ph = doc.createElement('span');
      ph.className = 'graphic-placeholder';
      ph.textContent = '[figure]';
      img.replaceWith(ph);
    });
    const html = box.innerHTML;
    return html.length > HTML_LIMIT ? null : html;
  }

  /** The numbered things of a converted paper (its HTML), to look results up in. */
  function indexHtml(html, parse) {
    const body = parse(html);
    return Find.collectTargets(body);
  }

  function defaultParse(html) {
    return new DOMParser().parseFromString(`<!doctype html><body><article class="document">${html}</article></body>`, 'text/html').body;
  }

  // ---------------------------------------------------------------------------
  // Keeping what was found
  // ---------------------------------------------------------------------------

  const STORE_KEY = 'texglass:cited-results';
  const STORE_VERSION = 1;
  const STORE_MAX = 1000000; // characters: room for many statements, never crowding out notes
  const PAPERS_KEPT = 4; // converted papers kept in memory

  function defaultStorage() {
    try {
      const s = root.localStorage;
      return s && typeof s.getItem === 'function' ? s : null;
    } catch (e) {
      return null;
    }
  }

  const pinKey = (id, pin) => `${id}|${pin.kind} ${pin.num}`;

  function create(opts) {
    opts = opts || {};
    const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
    const parse = opts.parse || defaultParse;
    const papers = new Map(); // id -> Promise of targets, most recent last

    function readStore() {
      if (!storage) return {};
      try {
        const v = JSON.parse(storage.getItem(STORE_KEY) || 'null');
        return v && v.v === STORE_VERSION && v.items ? v.items : {};
      } catch (e) {
        return {};
      }
    }
    function writeStore(add) {
      if (!storage) return;
      const items = Object.assign(readStore(), add);
      // the oldest go first when over the limit
      const keys = Object.keys(items).sort((a, b) => (items[b].t || 0) - (items[a].t || 0));
      let size = 0;
      const kept = {};
      for (const k of keys) {
        size += k.length + JSON.stringify(items[k]).length;
        if (size > STORE_MAX) break;
        kept[k] = items[k];
      }
      try {
        storage.setItem(STORE_KEY, JSON.stringify({ v: STORE_VERSION, items: kept }));
      } catch (e) {
        try { storage.removeItem(STORE_KEY); } catch (e2) { /* storage unusable */ }
      }
    }

    /** The statements of `pins` in paper `id` from storage, or null unless all are there. */
    function stored(id, pins) {
      if (!id || !pins || !pins.length) return null;
      const items = readStore();
      const out = [];
      for (const pin of pins) {
        const it = items[pinKey(id, pin)];
        if (!it) return null;
        out.push({ pin, html: it.h, name: it.n, found: true, other: !!it.o });
      }
      return out;
    }

    /** The numbered things of paper `id`, converting it on first use. */
    function paper(id) {
      let p = papers.get(id);
      if (p) {
        papers.delete(id);
        papers.set(id, p);
        return p;
      }
      p = Promise.resolve().then(() => opts.loadPaper(id)).then((html) => indexHtml(html, parse));
      papers.set(id, p);
      p.catch(() => { if (papers.get(id) === p) papers.delete(id); }); // try again next time
      while (papers.size > PAPERS_KEPT) papers.delete(papers.keys().next().value);
      return p;
    }

    /**
     * The statements of `pins` in arXiv paper `id`: [{ pin, html, name, found, other }]
     * in the pins' order. found is false for a result the paper does not have
     * (html null); name is the result as the paper numbers it ("Proposition 4.1").
     * Rejects when the paper could not be fetched or converted.
     */
    async function statements(id, pins) {
      const kept = stored(id, pins);
      if (kept) return kept;
      const targets = await paper(id);
      const out = [];
      const add = {};
      for (const pin of pins) {
        const m = match(targets, pin);
        const html = m ? statementHtml(m.target) : null;
        if (!m || !html) {
          out.push({ pin, html: null, name: pin.name, found: false, other: false });
          continue;
        }
        const name = Find.displayName(m.target);
        out.push({ pin, html, name, found: true, other: m.other });
        add[pinKey(id, pin)] = { h: html, n: name, o: m.other ? 1 : 0, t: Date.now() };
      }
      if (Object.keys(add).length) writeStore(add);
      return out;
    }

    /** Start converting paper `id` now, so a statement is ready sooner. */
    function prefetch(id) {
      if (id) paper(id).catch(() => {});
    }

    return { statements, stored, prefetch };
  }

  return { create, pinpointsOf, pinpointsInNote, pinpointsBefore, scan, match, statementHtml, indexHtml, label };
});
