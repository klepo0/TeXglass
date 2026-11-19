/*
 * Reading aids built from the rendered page, in the web viewer and the VS Code
 * preview:
 *
 *   - notation on hover: resting the pointer on a formula shows where its
 *     notation comes from (the paper's own macros, and symbols defined with :=);
 *   - a dependency map: which results each theorem's statement and proof refer to;
 *   - a notation index: the paper's macros and defined symbols, with first uses.
 *
 * None of this runs while a document renders. Everything is read from the
 * page the first time it is needed, kept until the page changes
 * (invalidate()), and read again on the next use.
 *
 *   const insight = TeXglassInsight.attach({
 *     root: preview,                       // the rendered document
 *     jump(el) { ... },                    // show an element of the page
 *     renderTex(texs) { ... },             // optional: Promise of HTML for small formulas
 *     hover: true,                         // notation on hover
 *     onHoverChange(on) { ... },           // the panel's checkbox changed it
 *   });
 *   insight.setDefinitions(result.defs);   // after each render: the paper's macros
 *   insight.invalidate();                  // after the page changed
 *   insight.open('notation' | 'deps');     // the panel
 *   insight.usedByNote(target);            // "Used in …" for the reference popover, or null
 */
(function (root) {
  'use strict';

  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ---------------------------------------------------------------------------
  // Reading the page
  // ---------------------------------------------------------------------------

  const INSIDE_POPOVER = '.ref-popover, .insight-popover, .insight-dialog';

  /** The formulas of the page, in document order (not the copies inside popovers). */
  function formulas(doc) {
    return Array.from(doc.querySelectorAll('.math[data-tex]')).filter((el) => !el.closest(INSIDE_POPOVER));
  }

  /** Command names (without the backslash) a formula's source uses. */
  function commandsIn(tex) {
    const out = new Set();
    const re = /\\([A-Za-z@]+)/g;
    let m;
    while ((m = re.exec(tex))) out.add(m[1]);
    return out;
  }

  const DEF_OPS = /:=|\\coloneqq|\\coloneq|\\eqqcolon|=:|\\triangleq|\\stackrel\s*\{\s*(?:\\text\s*\{\s*def\s*\}|\\mathrm\s*\{\s*def\s*\}|def)\s*\}\s*\{?=\}?|\\overset\s*\{\s*(?:\\text\s*\{\s*def\s*\}|\\mathrm\s*\{\s*def\s*\}|def)\s*\}\s*\{?=\}?/;

  /** Where a top-level piece of a formula ends before i (separators: , ; & \\ \quad and the like). */
  function pieceStart(tex, i) {
    let depth = 0;
    for (let k = i - 1; k >= 0; k--) {
      const c = tex[k];
      if (c === '}' || c === ')' || c === ']') depth++;
      else if (c === '{' || c === '(' || c === '[') {
        if (depth === 0) return k + 1;
        depth--;
      } else if (depth === 0) {
        if (c === ',' || c === ';' || c === '&') return k + 1;
        if (c === '\\' && tex[k + 1] === '\\') return k + 2;
        const w = /^\\(quad|qquad|text|mbox|forall|for|where|and)\b/.exec(tex.slice(k));
        if (w && c === '\\') return k + w[0].length;
      }
    }
    return 0;
  }

  function pieceEnd(tex, i) {
    let depth = 0;
    for (let k = i; k < tex.length; k++) {
      const c = tex[k];
      if (c === '{' || c === '(' || c === '[') depth++;
      else if (c === '}' || c === ')' || c === ']') {
        if (depth === 0) return k;
        depth--;
      } else if (depth === 0) {
        if (c === ',' || c === ';' || c === '&' || c === '=') return k;
        if (c === '\\' && /^\\(\\|quad|qquad|text|mbox)/.test(tex.slice(k))) return k;
      }
    }
    return tex.length;
  }

  /** Strip a formula piece to the notation it names: no spacing or \left/\right, braces balanced. */
  function cleanSymbol(s) {
    s = s.replace(/\\(left|right|big|Big|bigg|Bigg)\b/g, '').replace(/\\[,;:! ]/g, '').replace(/~/g, ' ').trim();
    let depth = 0;
    for (const c of s) {
      if (c === '{') depth++;
      else if (c === '}' && --depth < 0) return '';
    }
    return depth === 0 ? s : '';
  }

  /** A key for matching a symbol inside other formulas: no spaces, no optional braces around one token. */
  const keyOf = (s) => s.replace(/\s+/g, '').replace(/\{(\\?[A-Za-z0-9]+)\}/g, '$1');

  /**
   * The symbol a formula defines, as in "A := B", "B =: A" or "A \coloneqq B",
   * or null.
   */
  function definedSymbol(tex) {
    const m = DEF_OPS.exec(tex);
    if (!m) return null;
    const reversed = m[0] === '=:' || /eqqcolon/.test(m[0]);
    const s = reversed ? cleanSymbol(tex.slice(m.index + m[0].length, pieceEnd(tex, m.index + m[0].length))) : cleanSymbol(tex.slice(pieceStart(tex, m.index), m.index));
    if (!s || s.length > 60 || /[=<>]|\\(le|ge|leq|geq|in|subset|to)\b/.test(s)) return null;
    return s;
  }

  /** The name a theorem-like block goes by on the page: "Lemma 2.3". */
  function thmName(el) {
    const n = el.querySelector(':scope > .thm-head .thm-name, :scope > p > .thm-head .thm-name, :scope > .thm-head-only .thm-name, .thm-name');
    return n ? n.textContent.trim() : 'Result';
  }

  function thmNote(el) {
    const n = el.querySelector('.thm-note');
    return n && n.closest('.theorem') === el ? n.textContent.trim().replace(/^\(|\)$/g, '') : '';
  }

  const kindOf = (el) => {
    const m = /\bthm-env-([\w-]+)/.exec(el.className);
    return m ? m[1] : 'theorem';
  };

  function styleOf(el) {
    if (el.classList.contains('thm-definition')) return 'definition';
    if (el.classList.contains('thm-remark')) return 'remark';
    return 'plain';
  }

  /** The page element a reference link points to. */
  function targetOf(a, doc) {
    const href = a.getAttribute('href') || '';
    if (!href.startsWith('#')) return null;
    let id = href.slice(1);
    try { id = decodeURIComponent(id); } catch (e) { /* keep it */ }
    return (doc.ownerDocument || doc).getElementById(id);
  }

  /**
   * Which results refer to which: { nodes, byEl }, each node being
   * { el, id, name, note, kind, style, uses: Set(node), usedBy: Set(node), order }.
   * A result uses whatever its statement and its proof refer to. A proof
   * belongs to the result its heading names ("Proof of Theorem 2"), else to
   * the result just before it.
   */
  function dependencyGraph(doc) {
    const byEl = new Map();
    const nodes = [];
    const nodeOf = (el) => {
      let n = byEl.get(el);
      if (!n) {
        n = { el, id: el.id, name: thmName(el), note: thmNote(el), kind: kindOf(el), style: styleOf(el), uses: new Set(), usedBy: new Set(), order: nodes.length };
        byEl.set(el, n);
        nodes.push(n);
      }
      return n;
    };
    const resultOf = (target) => {
      const t = target && target.closest('.theorem[id]');
      return t && !t.closest(INSIDE_POPOVER) ? t : null;
    };
    const addRefs = (owner, scope, skip) => {
      for (const a of scope.querySelectorAll('a.ref[href^="#"]')) {
        if (skip && skip(a)) continue;
        const t = resultOf(targetOf(a, doc));
        if (!t || t === owner.el) continue;
        const dep = nodeOf(t);
        owner.uses.add(dep);
        dep.usedBy.add(owner);
      }
    };
    let last = null;
    for (const el of doc.querySelectorAll('.theorem[id], .proof')) {
      if (el.closest(INSIDE_POPOVER)) continue;
      if (el.classList.contains('theorem')) {
        last = nodeOf(el);
        addRefs(last, el, (a) => {
          const p = a.closest('.proof, .theorem');
          return p !== el && el.contains(p); // a nested proof or result counts for itself
        });
        continue;
      }
      const head = el.querySelector('.proof-head');
      let owner = null;
      if (head && head.closest('.proof') === el) {
        for (const a of head.querySelectorAll('a.ref[href^="#"]')) {
          const t = resultOf(targetOf(a, doc));
          if (t) { owner = nodeOf(t); break; }
        }
      }
      if (!owner) owner = last;
      if (!owner) continue;
      addRefs(owner, el, (a) => head && head.contains(a));
    }
    nodes.sort((a, b) => (a.el.compareDocumentPosition(b.el) & 4 ? -1 : 1));
    nodes.forEach((n, k) => { n.order = k; });
    return { nodes, byEl };
  }

  /**
   * The paper's notation: { macros, symbols, byName }.
   * macros: [{ name, mac, first, count }] for the macros its formulas use;
   * symbols: [{ tex, key, el }] for the symbols defined with := and the like.
   */
  function notationIndex(doc, definitions) {
    const macros = (definitions && definitions.macros) || {};
    const byName = new Map();
    const symbols = [];
    const seen = new Set();
    for (const el of formulas(doc)) {
      const tex = el.dataset.tex;
      for (const name of commandsIn(tex)) {
        if (!Object.prototype.hasOwnProperty.call(macros, name) || /@|^the/.test(name)) continue;
        let e = byName.get(name);
        if (!e) {
          e = { name, mac: macros[name], first: el, count: 0 };
          byName.set(name, e);
        }
        e.count++;
      }
      if (tex.length < 400) {
        const s = definedSymbol(tex);
        if (s) {
          const key = keyOf(s);
          if (!seen.has(key)) {
            seen.add(key);
            symbols.push({ tex: s, key, el });
          }
        }
      }
    }
    // in the order a reader meets them
    return { macros: Array.from(byName.values()), symbols, byName };
  }

  /** "\name{·}{·}": a macro the way the index shows it, arguments as dots. */
  function sampleOf(e) {
    const n = e.mac.delims ? 0 : Math.max(0, (e.mac.nargs || 0) - (e.mac.def != null ? 1 : 0));
    if (e.mac.delims) return null; // \def\pair(#1,#2): no sample worth guessing
    return '\\' + e.name + '{\\cdot}'.repeat(n);
  }

  /** "\newcommand{\R}{\mathbb{R}}", shortened. */
  function definitionOf(e) {
    const n = e.mac.nargs ? `[${e.mac.nargs}]` : '';
    const d = e.mac.def != null ? `[${e.mac.def}]` : '';
    let body = String(e.mac.body || '');
    if (body.length > 120) body = body.slice(0, 117) + '…';
    return `\\${e.name}${n}${d} → ${body}`;
  }

  // ---------------------------------------------------------------------------
  // Where things are
  // ---------------------------------------------------------------------------

  function makeLocator(doc) {
    const heads = Array.from(doc.querySelectorAll('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id], strong.run-in[id]')).filter((h) => !h.closest(INSIDE_POPOVER));
    const before = (a, b) => !!(a.compareDocumentPosition(b) & 4);
    return function where(el, graph) {
      const thm = el.closest('.theorem[id]');
      if (thm) return thmName(thm);
      const proof = el.closest('.proof');
      if (proof && graph) {
        // the result this proof belongs to: the graph's owner is not kept, so name the result before it
        let owner = null;
        for (const n of graph.nodes) {
          if (before(n.el, proof)) owner = n;
          else break;
        }
        if (owner) return `Proof of ${owner.name}`;
      }
      let lo = 0;
      let hi = heads.length - 1;
      let found = null;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (before(heads[mid], el)) { found = heads[mid]; lo = mid + 1; } else hi = mid - 1;
      }
      if (!found) return el.closest('.abstract') ? 'the abstract' : 'the opening pages';
      const t = found.textContent.trim().replace(/\s+/g, ' ');
      const num = found.querySelector('.secnum');
      const label = num ? `§${num.textContent.trim()} ${t.slice(num.textContent.trim().length).trim()}` : t;
      return label.length > 48 ? label.slice(0, 46) + '…' : label;
    };
  }

  /** A copy of a rendered formula without ids, to show elsewhere. */
  function copyOf(el) {
    const c = el.cloneNode(true);
    c.removeAttribute('id');
    c.querySelectorAll('[id]').forEach((x) => x.removeAttribute('id'));
    return c;
  }

  // ---------------------------------------------------------------------------
  // The dependency map, as an SVG
  // ---------------------------------------------------------------------------

  /**
   * Lay the results that refer to one another out in columns, left to right:
   * a result sits one column right of everything it uses.
   */
  function layout(graph) {
    const nodes = graph.nodes.filter((n) => n.uses.size || n.usedBy.size);
    const col = new Map();
    const visiting = new Set();
    const colOf = (n) => {
      if (col.has(n)) return col.get(n);
      if (visiting.has(n)) return 0; // a cycle: break it here
      visiting.add(n);
      let c = 0;
      for (const d of n.uses) c = Math.max(c, colOf(d) + 1);
      visiting.delete(n);
      col.set(n, c);
      return c;
    };
    nodes.forEach(colOf);
    const cols = [];
    for (const n of nodes) (cols[col.get(n)] || (cols[col.get(n)] = [])).push(n);
    const ROW = 34;
    const H = 24;
    const width = (n) => Math.min(190, 18 + n.name.length * 7.2);
    const y = new Map();
    let x = 12;
    const xs = new Map();
    let height = 0;
    cols.forEach((list) => {
      if (!list) return;
      // order by where the results they use sit, then by document order
      const bary = (n) => {
        let s = 0;
        let k = 0;
        for (const d of n.uses) if (y.has(d)) { s += y.get(d); k++; }
        return k ? s / k : null;
      };
      const keyed = list.map((n) => ({ n, b: bary(n) }));
      keyed.sort((a, b) => (a.b == null || b.b == null ? a.n.order - b.n.order : a.b - b.b || a.n.order - b.n.order));
      let next = 12;
      let w = 0;
      for (const { n, b } of keyed) {
        const top = Math.max(next, b == null ? next : Math.round(b));
        y.set(n, top);
        xs.set(n, x);
        next = top + ROW;
        w = Math.max(w, width(n));
      }
      height = Math.max(height, next);
      x += w + 70;
    });
    return { nodes, x: xs, y, width, H, size: { w: Math.max(x - 58, 200), h: Math.max(height, 40) } };
  }

  function mapSvg(lay) {
    const parts = [];
    const { H } = lay;
    for (const n of lay.nodes) {
      for (const d of n.uses) {
        if (!lay.x.has(d)) continue;
        const x1 = lay.x.get(d) + lay.width(d);
        const y1 = lay.y.get(d) + H / 2;
        const x2 = lay.x.get(n);
        const y2 = lay.y.get(n) + H / 2;
        const back = x2 <= x1;
        const dx = back ? 40 : Math.max(24, (x2 - x1) / 2);
        parts.push(`<path class="dep-edge" data-from="${d.order}" data-to="${n.order}" d="M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2 - 4},${y2}" marker-end="url(#dep-arrow)"/>`);
      }
    }
    for (const n of lay.nodes) {
      const w = lay.width(n);
      const label = n.name.length > 24 ? n.name.slice(0, 23) + '…' : n.name;
      const main = /^(theorem|thm|maintheorem|mainthm|corollary|cor)$/i.test(n.kind) ? ' dep-main' : '';
      parts.push(
        `<g class="dep-node dep-${n.style}${main}" data-n="${n.order}" tabindex="0" role="button" aria-label="${esc(n.name + (n.note ? ' (' + n.note + ')' : ''))}">` +
          `<rect x="${lay.x.get(n)}" y="${lay.y.get(n)}" width="${w}" height="${H}" rx="5"/>` +
          `<text x="${lay.x.get(n) + w / 2}" y="${lay.y.get(n) + H / 2 + 4.5}" text-anchor="middle">${esc(label)}</text></g>`
      );
    }
    return (
      `<svg class="dep-map" width="${lay.size.w + 12}" height="${lay.size.h}" viewBox="0 0 ${lay.size.w + 12} ${lay.size.h}" xmlns="http://www.w3.org/2000/svg">` +
      '<defs><marker id="dep-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" class="dep-arrowhead"/></marker></defs>' +
      parts.join('') +
      '</svg>'
    );
  }

  /** Everything n uses, directly or not (dir 'uses'), or everything that uses it ('usedBy'). */
  function closure(n, dir) {
    const out = new Set();
    const stack = [n];
    while (stack.length) {
      for (const m of stack.pop()[dir]) if (!out.has(m) && m !== n) { out.add(m); stack.push(m); }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // The UI
  // ---------------------------------------------------------------------------

  function attach(opts) {
    const doc = opts.root;
    const document_ = doc.ownerDocument || document;
    let defs = null;
    let graph = null;
    let index = null;
    let locate = null;
    let hoverOn = opts.hover !== false;
    const symbolCache = new Map(); // tex -> html

    const getGraph = () => graph || (graph = dependencyGraph(doc));
    const getIndex = () => index || (index = notationIndex(doc, defs));
    const getLocate = () => locate || (locate = makeLocator(doc));
    const where = (el) => getLocate()(el, getGraph());

    let refreshViews = () => {};
    function invalidate() {
      graph = null;
      index = null;
      locate = null;
      hidePop();
      refreshViews();
    }

    function setDefinitions(d) {
      if (d !== defs) symbolCache.clear();
      defs = d || null;
      index = null;
    }

    /** Fill elements carrying data-sym with the rendered symbol, once rendered. */
    function renderSymbols(container) {
      const els = Array.from(container.querySelectorAll('[data-sym]'));
      const missing = Array.from(new Set(els.map((e) => e.dataset.sym).filter((t) => !symbolCache.has(t))));
      const put = () => {
        for (const e of els) {
          const h = symbolCache.get(e.dataset.sym);
          if (h) { e.innerHTML = h; e.removeAttribute('data-sym'); }
        }
      };
      if (!missing.length || !opts.renderTex) { put(); return; }
      Promise.resolve(opts.renderTex(missing, defs))
        .then((htmls) => {
          if (!htmls) return;
          missing.forEach((t, k) => { if (htmls[k] && !/math-error|katex-error/.test(htmls[k])) symbolCache.set(t, htmls[k]); });
          put();
        })
        .catch(() => {});
    }

    // --- notation on hover ------------------------------------------------------

    const pop = document_.createElement('div');
    pop.className = 'insight-popover ref-popover';
    pop.setAttribute('role', 'tooltip');
    pop.hidden = true;
    document_.body.appendChild(pop);
    let showTimer = null;
    let hideTimer = null;
    let popFor = null;
    let popView = null; // the map view whose node the popover previews
    let under = null; // the formula the pointer is on

    /** Hide the popover. A timer that hides it late leaves a pending show alone. */
    function hidePop(late) {
      if (late !== true) clearTimeout(showTimer);
      clearTimeout(hideTimer);
      pop.hidden = true;
      popFor = null;
      popView = null;
    }

    /** What to say about the notation in a formula: [{ kind, … }], rarest first. */
    function notesFor(el) {
      const tex = el.dataset.tex || '';
      const idx = getIndex();
      const out = [];
      const key = keyOf(tex);
      const own = definedSymbol(tex);
      for (const s of idx.symbols) {
        if (s.el === el || s.key.length < 2 || (own && keyOf(own) === s.key)) continue;
        if (!key.includes(s.key)) continue;
        // a one-letter command like \phi must not match inside \phi_n's neighbour \varphi
        const at = key.indexOf(s.key);
        const after = key[at + s.key.length];
        if (/^\\[A-Za-z]+$/.test(s.key) && after && /[A-Za-z]/.test(after)) continue;
        out.push({ kind: 'symbol', s });
      }
      const macros = [];
      for (const name of commandsIn(tex)) {
        const e = idx.byName.get(name);
        if (e) macros.push(e);
      }
      macros.sort((a, b) => a.count - b.count);
      for (const e of macros) out.push({ kind: 'macro', e });
      return out.slice(0, 5);
    }

    function noteHtml(n, el) {
      if (n.kind === 'symbol') {
        return `<div class="insight-note"><div class="insight-note-what"></div>` +
          `<div class="insight-note-where">Defined in <a href="#" data-go="s">${esc(where(n.s.el))}</a></div></div>`;
      }
      const e = n.e;
      const sample = sampleOf(e);
      const first = e.first === el ? 'first used here' : `first used in <a href="#" data-go="m">${esc(where(e.first))}</a>`;
      return `<div class="insight-note"><div class="insight-note-what">${sample ? `<span class="insight-sym" data-sym="${esc(sample)}"></span> ` : ''}<code>${esc(definitionOf(e))}</code></div>` +
        `<div class="insight-note-where">Macro, ${first}${e.count > 1 ? ` · ${e.count} formulas` : ''}</div></div>`;
    }

    function showNotes(el) {
      const notes = notesFor(el);
      if (!notes.length) return;
      const body = document_.createElement('div');
      body.className = 'ref-popover-body insight-pop-body';
      body.innerHTML = '<div class="insight-pop-title">Notation</div>' + notes.map((n) => noteHtml(n, el)).join('');
      const boxes = body.querySelectorAll('.insight-note');
      notes.forEach((n, k) => {
        const box = boxes[k];
        if (n.kind === 'symbol') box.querySelector('.insight-note-what').appendChild(copyOf(n.s.el));
        const go = box.querySelector('a[data-go]');
        if (go) go._target = n.kind === 'symbol' ? n.s.el : n.e.first;
      });
      renderSymbols(body);
      if (pop.parentNode !== document_.body) document_.body.appendChild(pop);
      pop.replaceChildren(body);
      pop.hidden = false;
      popFor = el;
      const r = el.getBoundingClientRect();
      const width = Math.min(520, window.innerWidth - 32);
      pop.style.width = width + 'px';
      pop.style.left = Math.max(16, Math.min(r.left, window.innerWidth - width - 16)) + 'px';
      const h = pop.offsetHeight;
      pop.style.top = (r.bottom + h > window.innerHeight && r.top - h > 0 ? r.top - h : r.bottom) + 'px';
    }

    doc.addEventListener('mouseover', (e) => {
      if (!hoverOn) return;
      const el = e.target.closest && e.target.closest('.math[data-tex]');
      if (!el || el.closest(INSIDE_POPOVER)) return;
      if (el === popFor) { clearTimeout(hideTimer); return; }
      clearTimeout(showTimer);
      under = el;
      showTimer = setTimeout(() => {
        if (under === el) {
          hidePop();
          showNotes(el);
        }
      }, opts.delay != null ? opts.delay : 500);
    });
    doc.addEventListener('mouseout', (e) => {
      const el = e.target.closest && e.target.closest('.math[data-tex]');
      if (!el || el.contains(e.relatedTarget)) return;
      if (under === el) under = null;
      clearTimeout(showTimer);
      if (el === popFor && !pop.contains(e.relatedTarget)) {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => hidePop(true), 250);
      }
    });
    pop.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    pop.addEventListener('mouseleave', (e) => {
      if (popFor && popFor.contains(e.relatedTarget)) return;
      hideTimer = setTimeout(() => hidePop(true), 250);
    });
    pop.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-go]');
      if (!a || !a._target) return;
      e.preventDefault();
      const t = a._target;
      hidePop();
      opts.jump(t);
    });
    document_.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !pop.hidden) hidePop();
    });
    doc.addEventListener('mousedown', () => { clearTimeout(showTimer); });
    (doc.closest('.pane') || window).addEventListener('scroll', () => { if (!pop.hidden) hidePop(); }, { passive: true });

    // --- previews of the results in the map ------------------------------------------
    //
    // Resting on a node of the map, in the side panel or in the larger map, shows the
    // result itself, as a reference link in the text does. The preview is a copy of
    // the rendered statement, made only when the pointer rests on a node.

    function showResult(g, view) {
      const n = view.body._nodes && view.body._nodes[Number(g.dataset.n)];
      if (!n || !n.el || !n.el.isConnected) return;
      const body = document_.createElement('div');
      body.className = 'ref-popover-body dep-preview';
      const text = document_.createElement('div');
      text.className = 'document dep-preview-text';
      text.appendChild(copyOf(n.el));
      body.appendChild(text);
      // a modal dialog sits above the page, so the preview goes inside it there
      const host = g.closest('dialog') || document_.body;
      if (pop.parentNode !== host) host.appendChild(pop);
      pop.replaceChildren(body);
      pop.hidden = false;
      popFor = g;
      popView = view;
      const r = g.getBoundingClientRect();
      let width = Math.min(560, window.innerWidth - 32);
      pop.style.width = width + 'px';
      let extra = 0;
      body.querySelectorAll('.math-display, .tg-diagram').forEach((el) => {
        extra = Math.max(extra, el.scrollWidth - el.clientWidth);
      });
      if (extra > 0) {
        width = Math.min(width + extra + 2, window.innerWidth - 32);
        pop.style.width = width + 'px';
      }
      pop.style.left = Math.max(16, Math.min(r.left, window.innerWidth - width - 16)) + 'px';
      const h = pop.offsetHeight;
      pop.style.top = (r.bottom + h > window.innerHeight && r.top - h > 0 ? r.top - h : r.bottom) + 'px';
    }

    function wirePreviews(view) {
      let over = null;
      view.body.addEventListener('mouseover', (e) => {
        const g = e.target.closest && e.target.closest('.dep-node');
        if (!g) return;
        if (g === popFor) { clearTimeout(hideTimer); return; }
        clearTimeout(showTimer);
        over = g;
        showTimer = setTimeout(() => {
          if (over === g && g.isConnected) {
            hidePop();
            showResult(g, view);
          }
        }, opts.nodeDelay != null ? opts.nodeDelay : 300);
      });
      view.body.addEventListener('mouseout', (e) => {
        const g = e.target.closest && e.target.closest('.dep-node');
        if (!g || g.contains(e.relatedTarget)) return;
        if (over === g) over = null;
        clearTimeout(showTimer);
        if (g === popFor && !pop.contains(e.relatedTarget)) {
          clearTimeout(hideTimer);
          hideTimer = setTimeout(() => hidePop(true), 250);
        }
      });
      view.body.addEventListener('mousedown', () => clearTimeout(showTimer));
      view.body.addEventListener('scroll', () => { if (popView === view) hidePop(); }, { passive: true, capture: true });
    }

    // a link inside a previewed result goes where it points, as in the text
    pop.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="#"]');
      if (!a || a.matches('[data-go]')) return;
      const t = document_.getElementById(decodeURIComponent(a.getAttribute('href').slice(1)));
      if (!t) return;
      e.preventDefault();
      const v = popView;
      hidePop();
      if (v) v.leave();
      opts.jump(t);
    });

    // --- "Used in" under a reference preview ---------------------------------------

    function usedByNote(target) {
      if (!target || !target.classList || !target.classList.contains('theorem')) return null;
      const n = getGraph().byEl.get(target);
      if (!n || (!n.usedBy.size && !n.uses.size)) return null;
      const div = document_.createElement('div');
      div.className = 'insight-usedby';
      const list = (set) => Array.from(set).sort((a, b) => a.order - b.order).slice(0, 8).map((m) => `<a href="#${esc(m.id)}">${esc(m.name)}</a>`).join(', ') + (set.size > 8 ? `, and ${set.size - 8} more` : '');
      const rows = [];
      if (n.uses.size) rows.push(`<span class="insight-usedby-k">Uses</span> ${list(n.uses)}`);
      if (n.usedBy.size) rows.push(`<span class="insight-usedby-k">Used in</span> ${list(n.usedBy)}`);
      div.innerHTML = rows.join('<br>');
      return div;
    }

    // --- views: the side panel's Notation and Map tabs, and the large dialog --------

    // A view is a place the notation index or the map is drawn in:
    // { body, tab, selected, side, leave() } where leave() runs before a jump.
    const views = new Set();

    function wire(view) {
      const body = view.body;
      body.addEventListener('click', (e) => {
        const go = e.target.closest('[data-go]');
        if (go && go._target) {
          e.preventDefault();
          view.leave();
          opts.jump(go._target);
          return;
        }
        if (e.target.closest('.dep-larger')) {
          e.preventDefault();
          open('deps', view.selected);
          return;
        }
        const node = e.target.closest('.dep-node, [data-pick]');
        if (node) {
          e.preventDefault();
          select(view, Number(node.dataset.n != null ? node.dataset.n : node.dataset.pick));
        }
      });
      body.addEventListener('keydown', (e) => {
        const node = e.target.closest && e.target.closest('.dep-node');
        if (node && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); select(view, Number(node.dataset.n)); }
      });
      body.addEventListener('input', (e) => {
        if (e.target.matches('.insight-filter')) filterNotation(view, e.target.value);
      });
      body.addEventListener('change', (e) => {
        if (e.target.matches('.insight-hover input')) setHover(e.target.checked, true);
      });
      wirePreviews(view);
      views.add(view);
    }

    function fill(view) {
      const t0 = Date.now();
      if (view.tab === 'deps') fillDeps(view);
      else fillNotation(view);
      view.body.dataset.ms = String(Date.now() - t0);
    }

    const hoverBox = () =>
      `<label class="insight-hover"><input type="checkbox"${hoverOn ? ' checked' : ''}> Show notation when resting on a formula</label>`;

    function fillNotation(view) {
      const body = view.body;
      const idx = getIndex();
      if (!idx.macros.length && !idx.symbols.length) {
        body.innerHTML = '<p class="insight-empty">This document defines no notation of its own: no macros used in its formulas, and no symbols defined with := .</p>' + (view.side ? hoverBox() : '');
        return;
      }
      let html = '<input class="insight-filter" type="search" placeholder="Filter by command or text" aria-label="Filter the notation">';
      if (idx.macros.length) {
        html += `<h3>Macros <span class="insight-count">${idx.macros.length}</span></h3><table class="insight-table"><tbody>`;
        idx.macros.forEach((e, k) => {
          const sample = sampleOf(e);
          const body = String(e.mac.body);
          html += `<tr data-k="m${k}" data-text="${esc((e.name + ' ' + body).toLowerCase())}"><td class="insight-sym-cell">${sample ? `<span class="insight-sym" data-sym="${esc(sample)}"></span>` : ''}</td>` +
            `<td class="insight-cmd"><code>\\${esc(e.name)}</code></td><td class="insight-def"><code>${esc(body.length > 90 ? body.slice(0, 87) + '…' : body)}</code></td>` +
            `<td class="insight-first"><a href="#" data-m="${k}">${esc(where(e.first))}</a><span class="insight-uses">${e.count} formula${e.count > 1 ? 's' : ''}</span></td></tr>`;
        });
        html += '</tbody></table>';
      }
      if (idx.symbols.length) {
        html += `<h3>Defined in the text <span class="insight-count">${idx.symbols.length}</span></h3><ol class="insight-symbols">`;
        idx.symbols.forEach((s, k) => {
          html += `<li data-k="s${k}" data-text="${esc(s.el.dataset.tex.toLowerCase())}"><span class="insight-sym" data-sym="${esc(s.tex)}"><code>${esc(s.tex)}</code></span><span class="insight-sym-src"></span><a href="#" data-s="${k}">${esc(where(s.el))}</a></li>`;
        });
        html += '</ol>';
      }
      if (view.side) html += hoverBox();
      body.innerHTML = html;
      body.querySelectorAll('a[data-m]').forEach((a) => { a.dataset.go = ''; a._target = idx.macros[Number(a.dataset.m)].first; });
      body.querySelectorAll('a[data-s]').forEach((a) => {
        const s = idx.symbols[Number(a.dataset.s)];
        a.dataset.go = '';
        a._target = s.el;
        a.previousElementSibling.appendChild(copyOf(s.el));
      });
      renderSymbols(body);
    }

    function filterNotation(view, q) {
      q = q.trim().toLowerCase().replace(/^\\/, '');
      view.body.querySelectorAll('[data-text]').forEach((row) => {
        row.hidden = !!q && !row.dataset.text.includes(q);
      });
    }

    function fillDeps(view) {
      const body = view.body;
      const g = getGraph();
      const lay = layout(g);
      if (!lay.nodes.length) {
        body.innerHTML = '<p class="insight-empty">No result in this document refers to another one, so there is nothing to map. (The map is drawn from the \\ref and \\cref links in statements and proofs.)</p>';
        return;
      }
      let edges = 0;
      lay.nodes.forEach((n) => { edges += n.uses.size; });
      body.innerHTML = view.side
        ? `<p class="insight-lead">${lay.nodes.length} results, ${edges} references. Each arrow goes to a result that uses the one it starts from; pick one to light up what it rests on. <a href="#" class="dep-larger">Larger map</a></p>` +
          `<div class="dep-wrap">${mapSvg(lay)}</div><div class="dep-detail" aria-live="polite"></div>`
        : `<p class="insight-lead">${lay.nodes.length} results and ${edges} references between them, read from the \\ref and \\cref links in statements and proofs. ` +
          'Each arrow goes from a result to one that uses it. Pick a result to light up what it rests on and what rests on it.</p>' +
          `<div class="dep-wrap">${mapSvg(lay)}</div><div class="dep-detail" aria-live="polite"></div>`;
      body._nodes = g.nodes;
      if (view.selected != null && g.nodes[view.selected]) select(view, view.selected);
      else body.querySelector('.dep-detail').innerHTML = '<p class="insight-muted">No result picked.</p>';
    }

    function select(view, k) {
      const body = view.body;
      const nodes = body._nodes;
      const n = nodes && nodes[k];
      if (!n) return;
      view.selected = k;
      const up = closure(n, 'uses');
      const down = closure(n, 'usedBy');
      const svg = body.querySelector('.dep-map');
      svg.classList.add('dep-picked');
      svg.querySelectorAll('.dep-node').forEach((g) => {
        const m = nodes[Number(g.dataset.n)];
        g.classList.toggle('dep-sel', m === n);
        g.classList.toggle('dep-up', up.has(m));
        g.classList.toggle('dep-down', down.has(m));
      });
      svg.querySelectorAll('.dep-edge').forEach((p) => {
        const a = nodes[Number(p.dataset.from)];
        const b = nodes[Number(p.dataset.to)];
        const on = ((up.has(a) || a === n) && (up.has(b) || b === n)) || ((down.has(a) || a === n) && (down.has(b) || b === n));
        p.classList.toggle('dep-lit', on);
      });
      const list = (set) => set.size
        ? Array.from(set).sort((a, b) => a.order - b.order).map((m) => `<a href="#" data-pick="${m.order}">${esc(m.name)}</a>`).join(', ')
        : '<span class="insight-muted">nothing</span>';
      const indirect = (all, direct) => {
        const rest = new Set(Array.from(all).filter((m) => !direct.has(m)));
        return rest.size ? `<br><span class="insight-usedby-k">Indirectly</span> ${list(rest)}` : '';
      };
      const detail = body.querySelector('.dep-detail');
      detail.innerHTML =
        `<div class="dep-detail-head"><strong>${esc(n.name)}</strong>${n.note ? ` <span class="insight-muted">(${esc(n.note)})</span>` : ''} <a href="#" class="dep-go">Go to it</a></div>` +
        `<p><span class="insight-usedby-k">Uses</span> ${list(n.uses)}${indirect(up, n.uses)}</p>` +
        `<p><span class="insight-usedby-k">Used in</span> ${list(n.usedBy)}${indirect(down, n.usedBy)}</p>`;
      const go = detail.querySelector('.dep-go');
      go.dataset.go = '';
      go._target = n.el;
      const node = svg.querySelector(`.dep-node[data-n="${k}"] rect`);
      const wrap = body.querySelector('.dep-wrap');
      if (node && wrap) {
        // bring the node into the map's own scroll box, without scrolling anything else
        const r = node.getBoundingClientRect();
        const w = wrap.getBoundingClientRect();
        if (r.left < w.left || r.right > w.right) wrap.scrollLeft += r.left - w.left - (w.width - r.width) / 2;
        if (r.top < w.top || r.bottom > w.bottom) wrap.scrollTop += r.top - w.top - (w.height - r.height) / 2;
      }
    }

    function setHover(on, fromUi) {
      hoverOn = !!on;
      if (!hoverOn) hidePop();
      document_.querySelectorAll('.insight-hover input').forEach((b) => { b.checked = hoverOn; });
      if (fromUi && opts.onHoverChange) opts.onHoverChange(hoverOn);
    }

    // The large dialog, for a map too big for the side panel.
    let dialog = null;
    let dialogView = null;

    function build() {
      dialog = document_.createElement('dialog');
      dialog.className = 'insight-dialog';
      dialog.setAttribute('aria-label', 'Notation and dependencies');
      dialog.innerHTML =
        '<div class="insight-head">' +
        '<div class="insight-tabs" role="tablist">' +
        '<button type="button" role="tab" data-tab="notation">Notation</button>' +
        '<button type="button" role="tab" data-tab="deps">Map</button>' +
        '</div>' +
        hoverBox() +
        '<button type="button" class="insight-close" aria-label="Close">×</button>' +
        '</div><div class="insight-body"></div>';
      document_.body.appendChild(dialog);
      dialog.querySelector('.insight-close').addEventListener('click', () => dialog.close());
      dialog.addEventListener('close', () => { if (popView === dialogView) hidePop(); });
      dialog.addEventListener('click', (e) => {
        if (e.target === dialog) dialog.close(); // a click on the backdrop
      });
      dialog.querySelector('.insight-tabs').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-tab]');
        if (b) { dialogView.tab = b.dataset.tab; fillDialog(); }
      });
      dialog.querySelector('.insight-head').addEventListener('change', (e) => {
        if (e.target.matches('.insight-hover input')) setHover(e.target.checked, true);
      });
      dialogView = { body: dialog.querySelector('.insight-body'), tab: 'notation', selected: null, side: false, leave: () => dialog.close(), isShown: () => dialog.open };
      wire(dialogView);
    }

    function fillDialog() {
      dialog.querySelectorAll('.insight-tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === dialogView.tab)));
      fill(dialogView);
      dialog.dataset.ms = dialogView.body.dataset.ms;
    }

    function open(which, selected) {
      if (!dialog) build();
      if (which) dialogView.tab = which;
      if (selected != null) dialogView.selected = selected;
      fillDialog();
      if (!dialog.open) dialog.showModal();
    }

    /**
     * Draw the notation index or the map into an element of the page, such as a
     * tab of the side panel. Returns { show(tab), refresh(), hide() }.
     */
    function mount(body, mopts) {
      mopts = mopts || {};
      body.classList.add('insight-view', 'insight-side');
      const view = {
        body, tab: 'notation', selected: null, side: true, shown: false,
        leave: mopts.onJump || (() => {}),
        isShown: () => view.shown,
      };
      wire(view);
      return {
        show(tab) {
          view.tab = tab === 'deps' ? 'deps' : 'notation';
          view.shown = true;
          fill(view);
        },
        hide() { view.shown = false; },
        refresh() { if (view.shown) fill(view); },
      };
    }

    // after the page changed: redraw what is showing
    let refreshTimer = null;
    refreshViews = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        for (const v of views) if (v.isShown()) fill(v);
      }, 300);
    };

    return {
      open,
      mount,
      invalidate,
      setDefinitions,
      usedByNote,
      setHover: (on) => setHover(on, false),
      graph: getGraph,
      index: getIndex,
    };
  }

  /**
   * The side panel: tabs Contents, Notation and Map over the table of
   * contents, and a divider that drags to resize it (the width is remembered).
   *
   *   TeXglassInsight.sidePanel({
   *     pane, head, list,                 // the panel, its head row, the contents list
   *     insight,                          // from attach()
   *     store: { get(k), set(k, v) },     // where the tab and width are kept
   *     onTab(tab) { ... },               // optional
   *   });
   */
  function sidePanel(o) {
    const doc = o.pane.ownerDocument || document;
    const tabs = doc.createElement('div');
    tabs.className = 'side-tabs';
    tabs.setAttribute('role', 'tablist');
    tabs.innerHTML = [['toc', 'Contents'], ['notation', 'Notation'], ['deps', 'Map']]
      .map(([k, label]) => `<button type="button" role="tab" data-side-tab="${k}">${label}</button>`).join('');
    const title = o.head.querySelector('.toc-pane-title');
    if (title) title.replaceWith(tabs);
    else o.head.prepend(tabs);
    const body = doc.createElement('div');
    body.className = 'side-insight';
    body.hidden = true;
    o.list.after(body);
    const view = o.insight ? o.insight.mount(body, { onJump: o.onJump }) : null;
    if (!view) tabs.querySelectorAll('[data-side-tab="notation"], [data-side-tab="deps"]').forEach((b) => b.remove());

    // Stack the tabs when one row does not fit the panel.
    function fitTabs() {
      tabs.classList.remove('side-tabs-stacked');
      if (tabs.scrollWidth > tabs.clientWidth + 1) tabs.classList.add('side-tabs-stacked');
    }
    const win = doc.defaultView || window;
    if (typeof win.ResizeObserver === 'function') new win.ResizeObserver(fitTabs).observe(o.head);
    else win.addEventListener('resize', fitTabs);

    let tab = 'toc';
    function show(t, quiet) {
      tab = view && (t === 'notation' || t === 'deps') ? t : 'toc';
      tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.sideTab === tab)));
      o.list.hidden = tab !== 'toc';
      body.hidden = tab === 'toc';
      o.pane.dataset.tab = tab;
      if (view) {
        if (tab === 'toc') view.hide();
        else view.show(tab);
      }
      if (o.store && !quiet) o.store.set('texglass:side-tab', tab);
      if (o.onTab) o.onTab(tab);
    }
    tabs.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-side-tab]');
      if (b) show(b.dataset.sideTab);
    });

    // The divider: drag the panel's inner edge.
    const grip = doc.createElement('div');
    grip.className = 'side-resizer';
    grip.setAttribute('role', 'separator');
    grip.setAttribute('aria-orientation', 'vertical');
    grip.setAttribute('aria-label', 'Resize the side panel');
    grip.tabIndex = 0;
    grip.title = 'Drag to resize · double-click to reset';
    o.pane.after(grip);
    const MIN = 180;
    const maxWidth = () => Math.max(MIN, Math.round((doc.defaultView || window).innerWidth * 0.7));
    const setWidth = (w, save) => {
      if (w == null) {
        doc.body.style.removeProperty('--side-width');
        if (save && o.store) o.store.set('texglass:side-width', '');
        return;
      }
      w = Math.round(Math.min(maxWidth(), Math.max(MIN, w)));
      doc.body.style.setProperty('--side-width', w + 'px');
      grip.setAttribute('aria-valuenow', String(w));
      fitTabs();
      if (save && o.store) o.store.set('texglass:side-width', String(w));
    };
    const right = () => doc.body.classList.contains('toc-right');
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      const start = e.clientX;
      const width = o.pane.getBoundingClientRect().width;
      doc.body.classList.add('side-resizing');
      const move = (ev) => setWidth(width + (right() ? start - ev.clientX : ev.clientX - start), false);
      const up = () => {
        grip.removeEventListener('pointermove', move);
        grip.removeEventListener('pointerup', up);
        grip.removeEventListener('pointercancel', up);
        doc.body.classList.remove('side-resizing');
        setWidth(o.pane.getBoundingClientRect().width, true);
      };
      grip.addEventListener('pointermove', move);
      grip.addEventListener('pointerup', up);
      grip.addEventListener('pointercancel', up);
    });
    grip.addEventListener('dblclick', () => setWidth(null, true));
    grip.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const grow = (e.key === 'ArrowRight') !== right();
      setWidth(o.pane.getBoundingClientRect().width + (grow ? 20 : -20), true);
    });
    const saved = o.store ? parseFloat(o.store.get('texglass:side-width')) : NaN;
    if (!isNaN(saved)) setWidth(saved, false);
    show((o.store && o.store.get('texglass:side-tab')) || 'toc', true);

    return {
      show: (t) => show(t, true),
      tab: () => tab,
      setWidth: (w) => setWidth(w, false),
    };
  }

  const api = { attach, sidePanel, dependencyGraph, notationIndex, definedSymbol, layout };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TeXglassInsight = api;
})(typeof self !== 'undefined' ? self : this);
