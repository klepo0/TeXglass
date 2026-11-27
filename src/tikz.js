/*
 * TeXglass diagrams, part 1: parse tikzcd, xymatrix and simple tikzpicture
 * source into HTML that src/diagrams.js lays out and draws in the page.
 *
 * Nothing here touches the DOM, so it runs wherever the converter runs (the
 * page, a web worker, Node). Math and text inside a diagram are handed back to
 * the caller (`math(tex, display)` and `text(src)`), which renders them with
 * KaTeX like everything else, so user macros work inside diagrams too.
 *
 * Geometry that depends on the size of rendered text (where an arrow leaves a
 * node, where a label sits) is left to the page: the HTML carries the diagram
 * as JSON in a data attribute, plus the rendered cells and labels.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeXglassTikz = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ---------------------------------------------------------------------------
  // Scanning helpers
  // ---------------------------------------------------------------------------

  /** Index just past the group that opens at s[i] ('{', '[' or '('), or s.length. */
  function matchGroup(s, i) {
    const open = s[i];
    const close = open === '{' ? '}' : open === '[' ? ']' : ')';
    let depth = 0;
    let brace = 0;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (c === '\\') { j++; continue; }
      if (open !== '{') {
        if (c === '{') { brace++; continue; }
        if (c === '}') { brace--; continue; }
        if (brace > 0) continue;
      }
      if (c === open) depth++;
      else if (c === close && --depth === 0) return j + 1;
    }
    return s.length;
  }

  function skipWs(s, i) {
    while (i < s.length && /\s/.test(s[i])) i++;
    return i;
  }

  /**
   * Split at top level on `sep` (a string), outside braces, brackets and
   * \begin…\end pairs; with `quotes`, also outside "…" (tikzcd labels).
   */
  function splitTop(s, sep, quotes) {
    const out = [];
    const all = sep === ',' || sep === ';'; // also respect [ ] and ( )
    let depth = 0; // braces, plus brackets and parens when `all`
    let brace = 0;
    let env = 0;
    let inQ = false;
    let last = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      const top = depth === 0 && env === 0 && !inQ;
      if (c === '\\') {
        if (s.startsWith('\\begin', i)) env++;
        else if (s.startsWith('\\end', i)) env--;
        else if (top && sep === '\\\\' && s[i + 1] === '\\') {
          out.push(s.slice(last, i));
          last = i + 2;
        } else if (top && sep === '\\&' && s[i + 1] === '&') {
          out.push(s.slice(last, i));
          last = i + 2;
        }
        i++;
        continue;
      }
      if (c === '{') { depth++; brace++; continue; }
      if (c === '}') { depth--; brace--; continue; }
      if (inQ) {
        if (c === '"' && brace === 0) inQ = false;
        continue;
      }
      if (all && (c === '[' || c === '(')) { depth++; continue; }
      if (all && (c === ']' || c === ')')) { depth--; continue; }
      if (quotes && c === '"' && depth === 0) { inQ = true; continue; }
      if (top && c === sep) {
        out.push(s.slice(last, i));
        last = i + 1;
      }
    }
    out.push(s.slice(last));
    return out;
  }

  /** "key=value" (value may be braced) -> [key, value|null]. */
  function keyVal(opt) {
    let depth = 0;
    for (let i = 0; i < opt.length; i++) {
      const c = opt[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '=' && depth === 0) return [opt.slice(0, i).trim(), unbrace(opt.slice(i + 1).trim())];
    }
    return [opt.trim(), null];
  }

  function unbrace(s) {
    s = s.trim();
    while (s[0] === '{' && matchGroup(s, 0) === s.length) s = s.slice(1, -1).trim();
    return s;
  }

  // ---------------------------------------------------------------------------
  // Lengths (1em = 10pt, as in a 10pt document)
  // ---------------------------------------------------------------------------

  const PT = { pt: 1, bp: 1.00375, cm: 28.4528, mm: 2.84528, in: 72.27, pc: 12, em: 10, ex: 4.3, mu: 10 / 18, sp: 1 / 65536, dd: 1.07, cc: 12.84 };

  /** A TeX dimension in em, or null. Bare numbers count as `unit`. */
  function toEm(str, unit) {
    const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*([a-z]{2})?/.exec(String(str));
    if (!m) return null;
    const u = m[2] && PT[m[2]] ? m[2] : unit || 'em';
    return (parseFloat(m[1]) * PT[u]) / 10;
  }

  // ---------------------------------------------------------------------------
  // Colours (xcolor names and mixes). Black becomes the text colour and white
  // the page colour, so pictures follow the light/dark theme.
  // ---------------------------------------------------------------------------

  const COLORS = {
    black: 'currentColor', white: 'var(--paper, #fff)', red: '#e53935', green: '#2e9d3a', blue: '#2f6fdd',
    cyan: '#17a2b8', magenta: '#d81b9b', yellow: '#e6b800', orange: '#f08c00', violet: '#7b3fbf',
    purple: '#9c27b0', brown: '#8d5a3b', pink: '#f06292', teal: '#008080', olive: '#808000', lime: '#8bc34a',
  };
  const GRAYS = { gray: 50, darkgray: 75, lightgray: 25 };
  // xcolor's dvipsnames (capitalised), common in hand-made symbol packages.
  Object.assign(COLORS, {
    Cyan: '#00aeef', YellowOrange: '#faa21a', Violet: '#58429b', Orange: '#f58137', RoyalBlue: '#0071bc',
    ForestGreen: '#009b55', BrickRed: '#b6321c', Maroon: '#af3235', Plum: '#92268f', Red: '#ed1b23',
    Blue: '#2d2f92', Green: '#00a64f', Magenta: '#ec008c', Purple: '#99479b', Emerald: '#00a99d',
    Goldenrod: '#ffdf42', Mulberry: '#a93c93', NavyBlue: '#006eb8', OliveGreen: '#3c8031', Peach: '#f7965a',
    RedOrange: '#f26035', Sepia: '#671800', Tan: '#da9d76', Turquoise: '#00b4ce', CadetBlue: '#74729a',
  });

  function color(spec) {
    if (!spec) return null;
    spec = String(spec).trim();
    const html = /^\{?HTML\}?\{?([0-9A-Fa-f]{6})\}?$/.exec(spec);
    if (html) return '#' + html[1];
    const parts = spec.split('!').map((p) => p.trim());
    const base = (name) => {
      if (COLORS[name]) return COLORS[name];
      if (GRAYS[name] !== undefined) return `color-mix(in srgb, currentColor ${GRAYS[name]}%, var(--paper, #fff))`;
      return /^[a-z]+$/i.test(name) ? name.toLowerCase() : null;
    };
    let c = base(parts[0]);
    if (!c) return null;
    for (let k = 1; k < parts.length; k += 2) {
      const pct = Math.max(0, Math.min(100, parseFloat(parts[k]) || 0));
      const other = k + 1 < parts.length ? base(parts[k + 1]) : COLORS.white;
      if (!other) break;
      c = `color-mix(in srgb, ${c} ${pct}%, ${other})`;
    }
    return c;
  }

  const isColor = (name) => /^[a-z]+(![\d.]+(![a-z]+)?)*$/i.test(name) && color(name.split('!')[0]) !== null &&
    (COLORS[name.split('!')[0]] || GRAYS[name.split('!')[0]] !== undefined);

  // ---------------------------------------------------------------------------
  // Commutative diagrams: one model for tikzcd and xymatrix
  //
  //   { rs, cs, rows, cols, cells: [{r, c, html}], labels: [html],
  //     arrows: [{ f, t, head, tail, dbl, dash, sq, bend, sh, xs, ys, s0, s1,
  //                cross, ph, col, lw, sa, ea, L: [{k, p, s, d, sl, n}] }] }
  //
  // f/t are "r-c" cell keys or label names; head is to|2h|harp|harp2|none;
  // tail is none|to|hook|hook2|tail|bar; label side s is l|r|c or a compass
  // word; d marks a "description" label (on the arrow, over a gap).
  // ---------------------------------------------------------------------------

  const CD_SEP = { tiny: 0.45, small: 0.9, scriptsize: 1.35, normal: 1.8, large: 2.7, Large: 3.6, LARGE: 4.5, huge: 5.4, Huge: 6.3 };
  const POS = { 'at start': 0, 'very near start': 0.125, 'near start': 0.25, midway: 0.5, 'near end': 0.75, 'very near end': 0.875, 'at end': 1 };

  function cdSep(v, dflt) {
    v = unbrace(String(v || '')).split(',')[0].trim();
    if (CD_SEP[v] !== undefined) return CD_SEP[v];
    const e = toEm(v);
    return e === null ? dflt : e;
  }

  function dirOffset(dir) {
    let dr = 0;
    let dc = 0;
    for (const ch of dir) {
      if (ch === 'u') dr--;
      else if (ch === 'd') dr++;
      else if (ch === 'l') dc--;
      else if (ch === 'r') dc++;
    }
    return [dr, dc];
  }

  function newArrow() {
    return { f: null, t: null, dir: null, head: 'to', tail: 'none', dbl: 0, dash: '', sq: 0, bend: 0, sh: 0, xs: 0, ys: 0, s0: 0, s1: 0, cross: 0, ph: 0, col: null, lw: 1, sa: null, ea: null, L: [], swap: false, desc: false, pos: 0.5 };
  }

  /** Arrow shapes shared by tikzcd option names and TikZ arrow specs. */
  function applyArrowStyle(a, name) {
    switch (name) {
      case 'to': case 'rightarrow': case '->': a.head = 'to'; a.tail = 'none'; return true;
      case 'leftarrow': case '<-': case 'from': a.head = 'none'; a.tail = 'to'; return true;
      case 'leftrightarrow': case '<->': a.head = 'to'; a.tail = 'to'; return true;
      case 'Rightarrow': case 'Rrightarrow': a.dbl = 1; a.head = 'to'; a.tail = 'none'; return true;
      case 'Leftarrow': case 'Lleftarrow': a.dbl = 1; a.head = 'none'; a.tail = 'to'; return true;
      case 'Leftrightarrow': a.dbl = 1; a.head = 'to'; a.tail = 'to'; return true;
      case 'equal': case 'equals': case 'Equal': a.dbl = 1; a.head = 'none'; a.tail = 'none'; return true;
      case 'no head': case 'dash': case '-': case 'no tail': a.head = 'none'; if (name !== 'no tail') a.tail = 'none'; return true;
      case 'mapsto': case 'maps to': case '|->': a.tail = 'bar'; return true;
      case 'mapsfrom': a.tail = 'none'; a.head = 'bar'; return true;
      case 'hook': case 'hookrightarrow': case 'hook->': a.tail = 'hook'; return true;
      case "hook'": a.tail = 'hook2'; return true;
      case 'hookleftarrow': a.head = 'hook'; a.tail = 'to'; return true;
      case 'tail': case 'rightarrowtail': case '>->': a.tail = 'tail'; return true;
      case 'two heads': case 'twoheadrightarrow': case '->>': a.head = '2h'; return true;
      case 'twoheadleftarrow': a.head = 'none'; a.tail = '2h'; return true;
      case 'harpoon': case 'rightharpoonup': a.head = 'harp'; return true;
      case "harpoon'": case 'rightharpoondown': a.head = 'harp2'; return true;
      case 'leftharpoonup': a.head = 'none'; a.tail = 'harp2'; return true;
      case 'leftharpoondown': a.head = 'none'; a.tail = 'harp'; return true;
      case 'squiggly': case 'rightsquigarrow': a.sq = 1; return true;
      case 'leftrightsquigarrow': a.sq = 1; a.tail = 'to'; return true;
      case 'dashrightarrow': a.dash = 'dashed'; return true;
      case 'dashleftarrow': a.dash = 'dashed'; a.head = 'none'; a.tail = 'to'; return true;
      case 'dashed': case 'densely dashed': case 'loosely dashed': a.dash = 'dashed'; return true;
      case 'dotted': case 'densely dotted': case 'loosely dotted': a.dash = 'dotted'; return true;
      case 'solid': a.dash = ''; return true;
      case 'thick': case 'semithick': a.lw = 1.5; return true;
      case 'very thick': case 'ultra thick': a.lw = 2.2; return true;
      case 'thin': a.lw = 1; return true;
      default: return false;
    }
  }

  function readLabel(tok) {
    // "text" (closing quote at brace depth 0), then ', words or {options}.
    let depth = 0;
    let j = 1;
    for (; j < tok.length; j++) {
      const c = tok[j];
      if (c === '\\') { j++; continue; }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '"' && depth === 0) break;
    }
    const text = tok.slice(1, j);
    let rest = tok.slice(j + 1).trim();
    const L = { tex: text, swap: false, opts: [] };
    if (rest[0] === "'") { L.swap = true; rest = rest.slice(1).trim(); }
    while (rest) {
      if (rest[0] === '{') {
        const e = matchGroup(rest, 0);
        for (const o of splitTop(rest.slice(1, e - 1), ',')) if (o.trim()) L.opts.push(o.trim());
        rest = rest.slice(e).trim();
      } else {
        L.opts.push(rest);
        rest = '';
      }
    }
    return L;
  }

  function applyLabelOpt(L, o, out) {
    const [k, v] = keyVal(o);
    if (k === "'" || k === 'swap') L.swap = !L.swap;
    else if (k === 'description') out.d = 1;
    else if (k === 'marking') out.s = 'c';
    else if (POS[k] !== undefined) out.p = POS[k];
    else if (k === 'pos') out.p = parseFloat(v) || 0.5;
    else if (k === 'name') out.n = v;
    else if (k === 'sloped') out.sl = 1;
    else if (/^(above|below|left|right)( (left|right))?$/.test(k)) out.s = k;
    else if (k === 'inner sep' || k === 'outer sep' || k === 'anchor' || k === 'font') { /* ignored */ }
    else if (isColor(k)) out.col = color(k);
  }

  /** Apply one tikzcd arrow option (or a "label"). */
  function cdOption(a, tok, labels, math) {
    tok = tok.trim();
    if (!tok) return;
    if (tok[0] === '"') {
      const L = readLabel(tok);
      const out = { k: -1, p: null, s: null, d: 0 };
      for (const o of L.opts) applyLabelOpt(L, o, out);
      if (L.tex.trim()) {
        out.k = labels.length;
        out.tex = L.tex;
        labels.push('');
      }
      out.swap = L.swap;
      a.L.push(out);
      return;
    }
    if (/^[udlr]+$/.test(tok)) { a.dir = tok; return; }
    if (applyArrowStyle(a, tok)) return;
    if (POS[tok] !== undefined) { a.pos = POS[tok]; return; }
    const [k, v] = keyVal(tok);
    switch (k) {
      case 'from': a.f = v; return;
      case 'to': a.t = v; return;
      case 'out': a.out = parseFloat(v) || 0; return;
      case 'in': a.in = parseFloat(v) || 0; return;
      case 'looseness': a.loose = parseFloat(v) || 1; return;
      case 'bend left': a.bend = v ? parseFloat(v) || 30 : 30; return;
      case 'bend right': a.bend = -(v ? parseFloat(v) || 30 : 30); return;
      case 'shift left': a.sh += 0.24 * (v ? cdShift(v) : 1); return;
      case 'shift right': a.sh -= 0.24 * (v ? cdShift(v) : 1); return;
      case 'xshift': a.xs += toEm(v, 'pt') || 0; return;
      case 'yshift': a.ys -= toEm(v, 'pt') || 0; return;
      case 'shorten': a.s0 = a.s1 = toEm(v.replace(/^=/, ''), 'pt') || 0; return;
      case 'shorten <': a.s0 = toEm(v, 'pt') || 0; return;
      case 'shorten >': a.s1 = toEm(v, 'pt') || 0; return;
      case 'shorten <=': a.s0 = toEm(v, 'pt') || 0; return;
      case 'shorten >=': a.s1 = toEm(v, 'pt') || 0; return;
      case 'crossing over': a.cross = 1; return;
      case 'phantom': a.ph = 1; return;
      case 'swap': case "'": a.swap = true; return;
      case 'description': a.desc = true; return;
      case 'labels': if (/description/.test(v || '')) a.desc = true; if (/swap|'/.test(v || '')) a.swap = true; return;
      case 'pos': a.pos = parseFloat(v) || 0.5; return;
      case 'start anchor': a.sa = anchorWord(v); return;
      case 'end anchor': a.ea = anchorWord(v); return;
      case 'color': case 'draw': a.col = color(v); return;
      case 'line width': a.lw = Math.max(0.5, (toEm(v, 'pt') || 0.04) / 0.04); return;
      case 'dash pattern': a.dash = 'dashed'; return;
      default:
        if (/^[<>|]*-[<>|]*$/.test(k) || /^-?\{?[A-Za-z]+/.test(k)) {
          const sp = arrowSpec(k);
          if (sp) { a.tail = sp[0]; a.head = sp[1]; return; }
        }
        if (isColor(k)) a.col = color(k);
    }
  }

  function cdShift(v) {
    const n = parseFloat(v);
    if (/[a-z]{2}\s*$/.test(v.trim())) return (toEm(v, 'pt') || 0) / 0.24;
    return isNaN(n) ? 1 : n;
  }

  function anchorWord(v) {
    const w = unbrace(v || '').replace(/^\[[^\]]*\]/, '').trim();
    return /^(north|south|east|west|north east|north west|south east|south west|center)$/.test(w) ? w : null;
  }

  /** TikZ arrow spec "<->", "|->", "-{Stealth}", "-latex" -> [tail, head]. */
  function arrowSpec(spec) {
    const m = /^(.*?)-(?!.*-)(.*)$/.exec(spec.replace(/\s+/g, ''));
    if (!m) return null;
    const tip = (t, end) => {
      t = t.replace(/^\{|\}$/g, '').replace(/\[[^\]]*\]/g, '');
      if (!t) return 'none';
      if (/^(>|<)$/.test(t)) return 'to';
      if (/^(>>|<<)$/.test(t)) return '2h';
      if (t === '|') return 'bar';
      if (/^(stealth|Stealth|latex|Latex|Triangle|triangle\s*\d*|LaTeX)'?$/i.test(t)) return 'stealth';
      if (/^(to|To|Straight\s*Barb|cm\s*to|Computer\s*Modern\s*Rightarrow|angle\s*\d+|Classical\s*TikZ\s*Rightarrow)$/i.test(t)) return 'to';
      if (/^(\|>|>\|)$/.test(t)) return 'stealth';
      if (/^(o|Circle|\*)$/.test(t)) return t === 'o' ? 'circle' : 'dot';
      if (/^(Hooks?|hook)/i.test(t)) return 'hook';
      return end ? 'to' : 'to';
    };
    return [tip(m[1], false), tip(m[2], true)];
  }

  /** Arrows in one cell of a tikzcd; returns { text, arrows }. */
  function cdCellArrows(cell, labels, math) {
    const arrows = [];
    let text = '';
    const re = /\\(arrow|ar|[udlr]{1,2}ar)(?![A-Za-z])/g;
    let last = 0;
    let m;
    while ((m = re.exec(cell))) {
      text += cell.slice(last, m.index);
      const a = newArrow();
      if (m[1] !== 'arrow' && m[1] !== 'ar') a.dir = m[1].slice(0, -2);
      let i = skipWs(cell, re.lastIndex);
      let hadOpts = false;
      if (cell[i] === '[') {
        const e = matchGroup(cell, i);
        for (const tok of splitTop(cell.slice(i + 1, e - 1), ',', true)) cdOption(a, tok, labels, math);
        i = e;
        hadOpts = true;
      }
      // Legacy syntax: \arrow{r}{f}, \rar{f}.
      for (let n = 0; n < 2; n++) {
        const j = skipWs(cell, i);
        if (cell[j] !== '{' || (hadOpts && a.dir)) break;
        const e = matchGroup(cell, j);
        const arg = cell.slice(j + 1, e - 1);
        if (!a.dir && /^\s*[udlr]+\s*$/.test(arg)) a.dir = arg.trim();
        else if (arg.trim()) cdOption(a, `"${arg}"`, labels, math);
        i = e;
      }
      // Labels of phantom arrows (pullback corners) are full size.
      for (const l of a.L) if (l.k >= 0) labels[l.k] = math(`${a.ph ? '\\displaystyle' : '\\scriptstyle'} ${l.tex}`);
      arrows.push(a);
      last = i;
      re.lastIndex = i;
    }
    text += cell.slice(last);
    return { text, arrows };
  }

  function finishArrows(arrows, aliases) {
    const out = [];
    const cellKey = (v, r, c) => {
      if (v === null || v === undefined) return null;
      const s = String(v).trim();
      const rc = /^(\d+)-(\d+)$/.exec(s);
      if (rc) return `${rc[1]}-${rc[2]}`;
      if (aliases[s]) return aliases[s];
      if (/^[udlr]+$/.test(s)) {
        const [dr, dc] = dirOffset(s);
        return `${r + dr}-${c + dc}`;
      }
      return s; // a label name, resolved in the page
    };
    for (const { a, r, c } of arrows) {
      let f = cellKey(a.f, r, c) || `${r}-${c}`;
      let t = cellKey(a.t, r, c);
      if (!t) {
        if (!a.dir) continue;
        const [dr, dc] = dirOffset(a.dir);
        if (!dr && !dc) continue;
        t = `${r + dr}-${c + dc}`;
      }
      if (a.t && !a.f && a.dir) {
        // \arrow[to=Z, ...] keeps the current cell as the start.
        f = `${r}-${c}`;
      }
      const L = a.L.map((l) => {
        const s = l.s || (l.d || a.desc ? 'c' : (l.swap !== a.swap) ? 'r' : 'l');
        const o = { k: l.k, p: l.p === null ? a.pos : l.p, s };
        if (l.d || (a.desc && !l.s)) o.d = 1;
        if (a.ph) { o.s = 'c'; o.d = 0; }
        if (l.sl) o.sl = 1;
        if (l.n) o.n = l.n;
        if (l.col) o.col = l.col;
        return o;
      });
      const m = { f, t, head: a.head, tail: a.tail };
      for (const k of ['dbl', 'sq', 'bend', 'sh', 'xs', 'ys', 's0', 's1', 'cross', 'ph', 'loose']) if (a[k]) m[k] = round(a[k]);
      if (a.out !== undefined && a.in !== undefined) { m.out = a.out; m.in = a.in; }
      if (a.dash) m.dash = a.dash;
      if (a.col) m.col = a.col;
      if (a.lw !== 1) m.lw = a.lw;
      if (a.sa) m.sa = a.sa;
      if (a.ea) m.ea = a.ea;
      if (L.length) m.L = L;
      out.push(m);
    }
    return out;
  }

  const round = (x) => Math.round(x * 1000) / 1000;
  /** Trim, but keep the space of a trailing control space (\ ). */
  const trimTex = (t) => t.replace(/^\s+/, '').replace(/(?<!\\)\s+$/, '').replace(/\\\s+$/, '\\ ');

  function parseTikzcd(body, math) {
    let s = body;
    let i = skipWs(s, 0);
    let rs = 1.8;
    let cs = 1.8;
    let amp = '&';
    if (s[i] === '[') {
      const e = matchGroup(s, i);
      for (const tok of splitTop(s.slice(i + 1, e - 1), ',')) {
        const [k, v] = keyVal(tok);
        if (k === 'row sep') rs = cdSep(v, rs);
        else if (k === 'column sep') cs = cdSep(v, cs);
        else if (k === 'sep') rs = cs = cdSep(v, rs);
        else if (k === 'ampersand replacement') amp = (v || '').trim() || '&';
        else if (k === 'cramped') { rs *= 0.8; cs *= 0.8; }
      }
      s = s.slice(e);
    }
    const labels = [];
    const cells = [];
    const arrows = [];
    const aliases = Object.create(null);
    const rows = splitTop(s, '\\\\');
    if (rows.length > 1 && !rows[rows.length - 1].trim()) rows.pop();
    let cols = 0;
    rows.forEach((row, ri) => {
      row = row.replace(/^\s*\[[^\]]*\]/, '');
      const parts = splitTop(row, amp === '&' ? '&' : '\\&');
      cols = Math.max(cols, parts.length);
      parts.forEach((cell, ci) => {
        const r = ri + 1;
        const c = ci + 1;
        const al = /^\s*\|\[([^\]]*)\]\|/.exec(cell);
        if (al) {
          cell = cell.slice(al[0].length);
          const name = /(?:^|,)\s*(?:alias|name)\s*=\s*([^,]+)/.exec(al[1]);
          if (name) aliases[name[1].trim()] = `${r}-${c}`;
        }
        const res = cdCellArrows(cell, labels, math);
        for (const a of res.arrows) arrows.push({ a, r, c });
        const tex = trimTex(res.text);
        cells.push({ r, c, html: tex ? math(`\\displaystyle ${tex}`) : '' });
      });
    });
    return { rs, cs, rows: rows.length, cols, cells, labels, arrows: finishArrows(arrows, aliases) };
  }

  // --- Paul Taylor's diagrams.sty ------------------------------------------------

  const TAYLOR_ARROWS = {
    To: ['-', '-', '-', '-', '>'],
    Line: ['-', '-', '-', '-', '-'],
    Eq: ['=', '=', '=', '=', '='],
  };

  const TAYLOR_HEADS = new Map([['>', 'to'], ['>>', '2h'], ['|', 'bar']]);
  const TAYLOR_TAILS = new Map([['>', 'tail'], ['<', 'to'], ['<<', '2h'], ['|', 'bar'], ['C', 'hook']]);

  // Other heads and tails diagrams.sty draws, such as {->} or {>->}, read by their main mark.
  const taylorEnd = (mark, ends, back) => ends.get(mark)
    ?? (/>>|<</.test(mark) ? '2h' : /[>]/.test(mark) ? (back ? 'tail' : 'to') : /</.test(mark) ? 'to' : /\|/.test(mark) ? 'bar' : undefined);

  function taylorArrowStyle(parts) {
    const [tail, before, middle, after, head] = parts.map((part) => String(part ?? '').replace(/\s+/g, ''));
    const style = {
      head: head === after || !head ? 'none' : taylorEnd(head, TAYLOR_HEADS, false),
      tail: tail === before || !tail ? 'none' : taylorEnd(tail, TAYLOR_TAILS, true),
      dbl: 0,
      dash: '',
    };
    if (!style.head || !style.tail || (middle && middle !== before && middle !== after)) return null;
    if (before === '=' && after === '=') style.dbl = 1;
    else if (before === 'dash' || after === 'dash') style.dash = 'dashed';
    else if (before === '.' && after === '.') style.dash = 'dotted';
    else if (before !== '-' || after !== '-') return null;
    return style;
  }

  // KaTeX symbols for right and left arrows, with stretchy forms where available.
  // Styles without an equivalent stay as source in ordinary math.
  const TAYLOR_MATH_SHAPES = {
    'none/to/solid': [['\\rightarrow', '\\xrightarrow'], ['\\leftarrow', '\\xleftarrow']],
    'none/2h/solid': [['\\twoheadrightarrow', '\\xtwoheadrightarrow'], ['\\twoheadleftarrow', '\\xtwoheadleftarrow']],
    'to/none/solid': [['\\leftarrow', '\\xleftarrow'], ['\\rightarrow', '\\xrightarrow']],
    'tail/to/solid': [['\\rightarrowtail'], ['\\leftarrowtail']],
    'hook/to/solid': [['\\hookrightarrow', '\\xhookrightarrow'], ['\\hookleftarrow', '\\xhookleftarrow']],
    'bar/to/solid': [['\\mapsto', '\\xmapsto'], ['\\mathrel{\\leftarrow\\mkern-6mu\\vert}']],
    'to/to/solid': [['\\leftrightarrow', '\\xleftrightarrow'], ['\\leftrightarrow', '\\xleftrightarrow']],
    'none/none/solid': [['\\mathrel{-}'], ['\\mathrel{-}']],
    'none/none/double': [['=', '\\xlongequal'], ['=', '\\xlongequal']],
    'none/to/double': [['\\Rightarrow', '\\xRightarrow'], ['\\Leftarrow', '\\xLeftarrow']],
    'to/none/double': [['\\Leftarrow', '\\xLeftarrow'], ['\\Rightarrow', '\\xRightarrow']],
    'to/to/double': [['\\Leftrightarrow', '\\xLeftrightarrow'], ['\\Leftrightarrow', '\\xLeftrightarrow']],
    'none/to/dashed': [['\\dashrightarrow'], ['\\dashleftarrow']],
  };

  function taylorMathArrows(definitions) {
    const arrows = {};
    for (const [name, parts] of Object.entries({ ...TAYLOR_ARROWS, ...definitions })) {
      const style = taylorArrowStyle(parts);
      if (!style) continue;
      const shapes = TAYLOR_MATH_SHAPES[style.tail + '/' + style.head + '/' + (style.dbl ? 'double' : style.dash || 'solid')];
      if (!shapes) continue;
      arrows['\\r' + name] = shapes[0];
      arrows['\\l' + name] = shapes[1];
    }
    return arrows;
  }

  /** Whether an arrow such as \\rTo can be drawn inside a formula (horizontal, with a KaTeX shape). */
  function taylorInline(name, definitions) {
    return Object.prototype.hasOwnProperty.call(taylorMathArrows(definitions), '\\' + name);
  }

  // KaTeX's own reports of an undefined command: red source text, or a parse error in a math-error title
  const TAYLOR_UNDEFINED = /mathcolor="#cc0000"><mtext>\\([A-Za-z]+)<\/mtext>|class="math-error" title="KaTeX parse error: Undefined control sequence: \\([A-Za-z]+) at position/g;

  function taylorArrow(tex, definitions, macro) {
    const m = /^\\([ud]?[lr]|[lr]?[ud])([A-Z][A-Za-z]*)(?![A-Za-z@])/.exec(tex);
    if (!m) return null;
    // The paper's own macro, such as \lObj{A}, is an object.
    if (!definitions?.[m[2]] && macro?.(m[1] + m[2])) return null;
    const parts = definitions?.[m[2]] || TAYLOR_ARROWS[m[2]];
    // An unknown name followed by more than labels is a node, such as \lVert x\rVert.
    const fail = parts ? false : null;
    const style = parts ? taylorArrowStyle(parts) : {};
    if (!style) return false;
    const a = Object.assign(newArrow(), style, { dir: m[1] });

    let i = skipWs(tex, m[0].length);
    if (tex[i] === '[') i = skipWs(tex, matchGroup(tex, i));
    const [dr, dc] = dirOffset(a.dir);
    const above = !dr ? 'above' : !dc || dr !== dc ? 'left' : 'right';
    const below = !dr ? 'below' : above === 'left' ? 'right' : 'left';
    const sides = { '^': above, _: below, '<': 'left', '>': 'right', '~': 'c' };
    const labels = [];
    for (let braces = 0; i < tex.length;) {
      const mark = tex[i];
      const side = mark === '{' && braces < 2 ? (braces++ === 0 ? above : below) : sides[mark];
      // A known arrow followed by an object, as in \rTo^f B: the cell is drawn as
      // ordinary maths, where \rTo is an inline arrow.
      if (!side) return parts && taylorInline(m[1] + m[2], definitions) ? null : fail;
      if (mark !== '{') i = skipWs(tex, i + 1);
      if (i >= tex.length) return fail;
      const end = tex[i] === '{' ? matchGroup(tex, i) : i + (/^\\(?:[A-Za-z@]+|.)/.exec(tex.slice(i))?.[0].length || 1);
      const label = tex[i] === '{' ? tex.slice(i + 1, end - 1) : tex.slice(i, end);
      if (label.trim()) labels.push({ tex: label, s: side });
      i = skipWs(tex, end);
    }
    // An arrow style this renderer does not know: show the diagram's source.
    if (!parts) return false;
    return { a, dr, dc, labels };
  }

  /**
   * A cell that starts with the paper's macros, with those macros written out:
   * \let\incl\rTo, \newcommand{\incl}{\rTo^i} or \newcommand{\incl}[1]{\rTo^{#1}}.
   */
  function taylorAlias(tex, macro) {
    let t = tex;
    for (let k = 0; k < 10 && macro; k++) {
      const m = /^\\([A-Za-z@]+)(?![A-Za-z@])/.exec(t);
      const d = m && macro(m[1]);
      if (!d || typeof d.body !== 'string' || d.delims) break;
      if (d.let && !/^\\[A-Za-z@]+$/.test(d.body.trim())) break;
      let i = m[0].length;
      const args = [];
      const nargs = d.let ? 0 : d.nargs || 0;
      if (nargs && d.def !== null && d.def !== undefined) {
        const at = skipWs(t, i);
        if (t[at] === '[') {
          const end = matchGroup(t, at);
          args.push(t.slice(at + 1, end - 1));
          i = end;
        } else args.push(d.def);
      }
      while (args.length < nargs) {
        const at = skipWs(t, i);
        if (at >= t.length || t[at] === '}') return tex;
        // a braced group, or one token: \incl{i}, \incl i, \incl\alpha
        const end = t[at] === '{' ? matchGroup(t, at) : at + (/^\\(?:[A-Za-z@]+|.)/.exec(t.slice(at))?.[0].length || 1);
        args.push(t[at] === '{' ? t.slice(at + 1, end - 1) : t.slice(at, end));
        i = end;
      }
      t = d.body.trim().replace(/#([1-9])/g, (all, n) => (n <= args.length ? args[n - 1] : all)) + t.slice(i);
    }
    return t;
  }

  /** Taylor arrows sit between their endpoints, with empty cells along the way. */
  function taylorDiagram(body, math, definitions, macro) {
    // Options come right after \begin{diagram}; after a space, [A] starts the first object.
    const end = body[0] === '[' ? matchGroup(body, 0) : 0;
    const opts = end === 0 ? {} : Object.fromEntries(splitTop(body.slice(1, end - 1), ',').map(keyVal));
    const rows = splitTop(body.slice(end), '\\\\').map((row) => splitTop(row, '&').map(trimTex));
    if (rows.length > 1 && rows[rows.length - 1].every((cell) => !cell)) rows.pop();
    const cols = rows.reduce((max, row) => Math.max(max, row.length), 0);
    const nodes = new Map();
    const arrows = [];
    for (const [r, row] of rows.entries()) {
      for (const [c, tex] of row.entries()) {
        let arrow = taylorArrow(tex, definitions, macro);
        // A macro of the paper that stands for an arrow, such as \incl for \rTo^i.
        if (arrow === null) {
          const alias = taylorAlias(tex, macro);
          if (alias !== tex) arrow = taylorArrow(alias, definitions, macro) ?? null;
        }
        if (arrow === false) return null;
        if (arrow) arrows.push({ ...arrow, r, c });
        else if (tex) {
          // an object cell drawn as a formula: any arrow in it needs an inline form
          nodes.set(r * cols + c, tex);
        }
      }
    }

    const endpoint = (r, c, dr, dc) => {
      for (r += dr, c += dc; r >= 0 && r < rows.length && c >= 0 && c < cols; r += dr, c += dc) {
        if (nodes.has(r * cols + c)) return (r + 1) + '-' + (c + 1);
      }
      return null;
    };
    const labels = [];
    for (const arrow of arrows) {
      const { a, r, c, dr, dc } = arrow;
      a.f = endpoint(r, c, -dr, -dc);
      a.t = endpoint(r, c, dr, dc);
      if (!a.f || !a.t) return null;
      for (const label of arrow.labels) {
        a.L.push({ k: labels.length, p: null, s: label.s, d: label.s === 'c' });
        labels.push(math('\\scriptstyle ' + label.tex));
      }
    }
    const cells = Array.from(nodes, ([at, tex]) => ({
      r: Math.floor(at / cols) + 1,
      c: at % cols + 1,
      html: math('\\displaystyle ' + tex),
    }));
    // An object cell drawn as a formula may reach an arrow with no inline form,
    // written there or through the paper's macros: KaTeX then names it as
    // undefined, and the diagram shows its source instead.
    const known = (name) => {
      const m = /^(?:[ud]?[lr]|[lr]?[ud])([A-Z][A-Za-z]*)$/.exec(name);
      return !!m && !!(definitions?.[m[1]] || TAYLOR_ARROWS[m[1]]);
    };
    if (cells.some((cell) => Array.from(cell.html.matchAll(TAYLOR_UNDEFINED), (u) => u[1] || u[2]).some(known))) return null;
    const rs = cdSep(opts.height || opts.size, 0.8);
    const cs = cdSep(opts.width || opts.size, 0.8);
    return cdHtml({ rs, cs, rows: rows.length, cols, cells, labels, arrows: finishArrows(arrows, {}) });
  }

  // --- xymatrix ----------------------------------------------------------------

  /** An xy arrow style such as "->", "-->", "^{(}->", "=>", "|->", ".>" . */
  function xyStyle(a, st) {
    st = st.replace(/\s+/g, '');
    if (!st) { a.ph = 1; return; }
    let m;
    if ((m = /^([\^_])\{\(\}/.exec(st))) { a.tail = m[1] === '^' ? 'hook' : 'hook2'; st = st.slice(m[0].length); }
    else if ((m = /^([\^_]?)\(/.exec(st)) && st.length > 2) { a.tail = m[1] === '_' ? 'hook2' : 'hook'; st = st.slice(m[0].length); }
    if (st[0] === '|' && st.length > 1) { a.tail = 'bar'; st = st.slice(1); }
    else if (st.startsWith('>') && st.length > 1 && /[-.~=:]/.test(st[1])) { a.tail = 'tail'; st = st.slice(1); }
    else if (st.startsWith('<') && st.length > 1) { a.tail = st[1] === '<' ? '2h' : 'to'; st = st.replace(/^<<?/, ''); }
    let head = 'none';
    if (st.endsWith('>>')) { head = '2h'; st = st.slice(0, -2); }
    else if (st.endsWith('>')) { head = 'to'; st = st.slice(0, -1); }
    else if (st.endsWith('|') && st.length > 1) { head = 'bar'; st = st.slice(0, -1); }
    a.head = head;
    if (/^(==?|::?)$/.test(st)) { a.dbl = 1; if (st[0] === ':') a.dash = 'dotted'; }
    else if (/^(--|-\s*-)$/.test(st)) a.dash = 'dashed';
    else if (/^\.\.?$/.test(st)) a.dash = 'dotted';
    else if (/^~~?$/.test(st)) a.sq = 1;
    if (head === 'none' && a.tail === 'none' && !st) a.ph = 1;
  }

  /** Read one xy label after ^, _ or |: returns [tex, pos, end]. */
  function xyLabel(s, i) {
    let pos = null;
    if (s[i] === '<') { pos = 0.25; i++; if (s[i] === '<') { pos = 0.15; i++; } }
    else if (s[i] === '>') { pos = 0.75; i++; if (s[i] === '>') { pos = 0.85; i++; } }
    else if (s[i] === '-') { pos = 0.5; i++; }
    else if (s[i] === '(') { const e = matchGroup(s, i); pos = parseFloat(s.slice(i + 1, e - 1)) || 0.5; i = e; }
    i = skipWs(s, i);
    if (s[i] === '{') {
      const e = matchGroup(s, i);
      return [s.slice(i + 1, e - 1), pos, e];
    }
    if (s[i] === '\\') {
      const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i));
      return [m[0], pos, i + m[0].length];
    }
    return [s[i] || '', pos, i + 1];
  }

  function xyCellArrows(cell, labels, math) {
    const arrows = [];
    let text = '';
    const re = /\\(?:ar|([udlr]+)(upper|lower|compos)?twocell)(?![A-Za-z])/g;
    let last = 0;
    let m;
    while ((m = re.exec(cell))) {
      text += cell.slice(last, m.index);
      if (m[1]) {
        const end = xyTwocell(cell, m.index + m[0].length, m[1], m[2], arrows, labels, math);
        last = end;
        re.lastIndex = end;
        continue;
      }
      const a = newArrow();
      let i = m.index + 3;
      for (;;) {
        i = skipWs(cell, i);
        if (cell[i] === '@') {
          i++;
          if (cell[i] === '{') { const e = matchGroup(cell, i); xyStyle(a, cell.slice(i + 1, e - 1)); i = e; }
          else if (/[23]/.test(cell[i])) {
            a.dbl = 1; i++;
            if (cell[i] === '{') { const e = matchGroup(cell, i); const d = a.dbl; xyStyle(a, cell.slice(i + 1, e - 1)); a.dbl = d; i = e; }
          } else if (cell[i] === '/') {
            const e = cell.indexOf('/', i + 1);
            const spec = cell.slice(i + 1, e < 0 ? cell.length : e);
            const sign = spec[0] === '_' ? -1 : 1;
            const d = toEm(spec.slice(1), 'pt');
            a.bend = sign * (d === null ? 30 : Math.min(70, Math.max(10, d * 18)));
            i = e < 0 ? cell.length : e + 1;
          } else if (cell[i] === '<') {
            const e = cell.indexOf('>', i);
            a.sh += toEm(cell.slice(i + 1, e), 'pt') || 0;
            i = e < 0 ? cell.length : e + 1;
          } else if (cell[i] === '(') {
            i = matchGroup(cell, i); // loops: not drawn
            a.ph = 1;
          } else if (cell[i] === '*' && cell[i + 1] === '{') {
            i = matchGroup(cell, i + 1);
          } else if (/[!?]/.test(cell[i])) i++;
          else if (cell[i] === '-' || cell[i] === '=' || cell[i] === '.') { xyStyle(a, cell[i] + '>'); i++; }
          continue;
        }
        if (cell[i] === '[') {
          const e = matchGroup(cell, i);
          const d = cell.slice(i + 1, e - 1).trim();
          if (/^[udlr]*$/.test(d)) a.dir = d;
          i = e;
          continue;
        }
        if (cell[i] === '^' || cell[i] === '_' || cell[i] === '|') {
          const side = cell[i] === '^' ? 'l' : cell[i] === '_' ? 'r' : 'c';
          const [tex, pos, e] = xyLabel(cell, i + 1);
          const L = { k: -1, p: pos, s: side, d: side === 'c' ? 1 : 0 };
          if (tex.trim()) { L.k = labels.length; labels.push(math(`\\scriptstyle ${tex}`)); }
          a.L.push(L);
          i = e;
          continue;
        }
        if (cell[i] === '"' ) { // "name" or "a";"b" — skip
          const e = cell.indexOf('"', i + 1);
          i = e < 0 ? cell.length : e + 1;
          continue;
        }
        break;
      }
      if (a.ph) a.L.forEach((l) => { l.s = 'c'; l.d = 0; });
      arrows.push(a);
      last = i;
      re.lastIndex = i;
    }
    text += cell.slice(last);
    return { text, arrows };
  }

  let twocells = 0;

  /**
   * xy's 2-cells: \rtwocell^{f}_{g}{\alpha} draws two curved arrows to the
   * right and a double arrow between them (\ruppertwocell and \rlowertwocell
   * pair one curved arrow with a straight one drawn elsewhere).
   */
  function xyTwocell(cell, i, dir, kind, arrows, labels, math) {
    const lab = { up: null, down: null };
    i = skipWs(cell, i);
    if (cell[i] === '<') { const e = cell.indexOf('>', i); i = e < 0 ? i + 1 : e + 1; }
    for (;;) {
      i = skipWs(cell, i);
      if (cell[i] === '^' || cell[i] === '_') {
        const [tex, , e] = xyLabel(cell, i + 1);
        lab[cell[i] === '^' ? 'up' : 'down'] = tex;
        i = e;
        continue;
      }
      break;
    }
    const omitCurves = /^\\omit(?![A-Za-z])/.test(cell.slice(i));
    if (omitCurves) i = skipWs(cell, i + '\\omit'.length);
    let alpha = null;
    if (cell[i] === '{') {
      const e = matchGroup(cell, i);
      alpha = cell.slice(i + 1, e - 1).trim();
      i = e;
    }
    const id = ++twocells;
    const U = `_tc${id}u`;
    const D = `_tc${id}d`;
    const curved = (bend, tex, name) => {
      const a = newArrow();
      a.dir = dir;
      a.bend = bend;
      if (tex && tex.trim()) { a.L.push({ k: labels.length, p: null, s: bend > 0 ? 'l' : 'r', d: 0 }); labels.push(math(`\\scriptstyle ${tex}`)); }
      a.L.push({ k: -1, p: null, s: bend > 0 ? 'r' : 'l', d: 0, n: name });
      return a;
    };
    const straight = (name) => {
      const a = newArrow();
      a.dir = dir;
      a.ph = 1;
      a.L.push({ k: -1, p: null, s: 'c', d: 0, n: name });
      return a;
    };
    const up = kind === 'lower' ? straight(U) : curved(32, lab.up, U);
    const down = kind === 'upper' ? straight(D) : curved(-32, lab.down, D);
    if (omitCurves) {
      up.ph = down.ph = 1;
    }
    arrows.push(up, down);
    if (alpha !== null && !/^\\omit\b/.test(alpha)) {
      const two = newArrow();
      two.f = U;
      two.t = D;
      two.dbl = 1;
      two.s0 = two.s1 = 0.12;
      if (alpha) { two.L.push({ k: labels.length, p: null, s: 'l', d: 0 }); labels.push(math(`\\scriptstyle ${alpha}`)); }
      arrows.push(two);
    }
    return i;
  }

  /** Strip xy object modifiers (*+[F]{x}, *!<..>{x}) from a cell. */
  function xyObject(text) {
    let t = text.trim();
    // \txt{line\\line}: text lines
    const txt = /^(\*[^{]*?)?\\txt\s*(<[^>]*>)?\s*\{/.exec(t);
    if (txt) {
      const open = txt[0].length - 1;
      const e = matchGroup(t, open);
      const lines = splitTop(t.slice(open + 1, e - 1), '\\\\').map((l) => `\\text{${l.trim()}}`);
      return `\\begin{matrix}${lines.join('\\\\')}\\end{matrix}${t.slice(e)}`;
    }
    if (t[0] !== '*') return text;
    let i = 1;
    while (i < t.length && t[i] !== '{') {
      if (t[i] === '[') i = matchGroup(t, i);
      else if (t[i] === '<') { const e = t.indexOf('>', i); i = e < 0 ? t.length : e + 1; }
      else i++;
    }
    if (t[i] !== '{') return text;
    const e = matchGroup(t, i);
    return t.slice(i + 1, e - 1) + t.slice(e);
  }

  /** `src` starts just after \xymatrix; returns { model, end }. */
  function parseXymatrix(src, math) {
    let i = 0;
    let rs = 2.4;
    let cs = 2.4;
    for (;;) {
      i = skipWs(src, i);
      if (src[i] !== '@') break;
      i++;
      // @!, @!R and @!C select uniform spacing. @!=... also sets its size.
      const uniform = /^!(?:[RC](?!=)|0)?/.exec(src.slice(i));
      if (uniform) {
        i += uniform[0].length;
        if (!/^[RC]?[=+-]/.test(src.slice(i))) continue;
      }
      const m = /^([RCMWHL]?)([=+-]?)\s*(\{[^}]*\}|[+-]?\d*\.?\d+\s*[a-z]{2}|\d*\.?\d+)?/.exec(src.slice(i));
      if (src[i] === '*' && src[i + 1] === '[') { i = matchGroup(src, i + 1); continue; }
      if (!m || !m[0]) { i++; continue; }
      i += m[0].length;
      const v = m[3] ? toEm(unbrace(m[3]), 'pt') : null;
      if (v === null) continue;
      const apply = (old) => (m[2] === '+' ? old + v : m[2] === '-' ? old - v : v);
      if (m[1] === 'R') rs = apply(rs);
      else if (m[1] === 'C') cs = apply(cs);
      else if (!m[1]) { rs = apply(rs); cs = apply(cs); }
    }
    if (src[i] !== '{') return null;
    const e = matchGroup(src, i);
    const body = src.slice(i + 1, e - 1);
    const labels = [];
    const cells = [];
    const arrows = [];
    const rows = splitTop(body, '\\\\');
    if (rows.length > 1 && !rows[rows.length - 1].trim()) rows.pop();
    let cols = 0;
    rows.forEach((row, ri) => {
      const parts = splitTop(row, '&');
      cols = Math.max(cols, parts.length);
      parts.forEach((cell, ci) => {
        const res = xyCellArrows(cell, labels, math);
        for (const a of res.arrows) arrows.push({ a, r: ri + 1, c: ci + 1 });
        const tex = trimTex(xyObject(res.text));
        cells.push({ r: ri + 1, c: ci + 1, html: tex ? math(`\\displaystyle ${tex}`) : '' });
      });
    });
    // xy measures between centres; leave room for the cells themselves.
    rs = Math.max(0.6, rs - 0.6);
    cs = Math.max(0.6, cs - 0.8);
    return { model: { rs, cs, rows: rows.length, cols, cells, labels, arrows: finishArrows(arrows, {}) }, end: e };
  }

  // Spans throughout, so a diagram can sit inside a paragraph (inline math).
  function cdHtml(d) {
    const data = { arrows: d.arrows };
    const cells = d.cells
      .map((c) => `<span class="cd-cell" style="grid-area:${c.r}/${c.c}"><span class="cd-node${c.html ? '' : ' cd-empty'}" data-rc="${c.r}-${c.c}">${c.html}</span></span>`)
      .join('');
    const labels = d.labels.map((h, k) => `<span class="cd-label" data-k="${k}">${h}</span>`).join('');
    return (
      `<span class="tg-diagram tg-cd"><span class="cd-wrap" data-cd="${esc(JSON.stringify(data))}">` +
      `<span class="cd-grid" style="grid-template-columns:repeat(${d.cols},auto);row-gap:${round(d.rs + 0.7)}em;column-gap:${round(d.cs + 0.5)}em">${cells}</span>` +
      `${labels}</span></span>`
    );
  }

  // ---------------------------------------------------------------------------
  // tikzpicture: a subset of TikZ (paths, nodes, scopes, \foreach, plots)
  //
  // The model is in TikZ units (cm, y up):
  //   { paths: [{ segs, draw, fill, lw, dash, head, tail, op }],
  //     nodes: [{ k, at | on | of, anchor, dx, dy, shape, draw, fill, col, is,
  //               mw, mh, lw, name, scale, multi }], bbox, partial }
  // A segment is ['M', p] | ['L', p] | ['C', c1, c2, p] | ['Z'], where a point
  // is [x, y] or a node reference { n, a?, dx?, dy? } that the page resolves
  // (and clips to the node's border) once it knows how big the node is.
  // ---------------------------------------------------------------------------

  const CM_PER_PT = 1 / 28.4528;
  const LINE_WIDTHS = { 'ultra thin': 0.1, 'very thin': 0.2, thin: 0.4, semithick: 0.6, thick: 0.8, 'very thick': 1.2, 'ultra thick': 1.6 };
  const DASHES = {
    dashed: [3, 3], 'densely dashed': [3, 2], 'loosely dashed': [3, 6], dotted: [0, 2], 'densely dotted': [0, 1], 'loosely dotted': [0, 4],
    'dash dot': [3, 2, 0, 2], 'dashdotted': [3, 2, 0, 2], 'densely dash dot': [3, 1, 0, 1], 'dash pattern': [3, 3],
  };
  const FONT_SCALE = { tiny: 0.5, scriptsize: 0.7, footnotesize: 0.8, small: 0.9, normalsize: 1, large: 1.2, Large: 1.44, LARGE: 1.73, huge: 2.07, Huge: 2.49 };
  const COMPASS = {
    north: 90, south: 270, east: 0, west: 180, 'north east': 45, 'north west': 135, 'south east': 315, 'south west': 225,
    above: 90, below: 270, right: 0, left: 180, 'above right': 45, 'above left': 135, 'below right': 315, 'below left': 225,
  };
  const OPPOSITE = { above: 'south', below: 'north', left: 'east', right: 'west', 'above left': 'south east', 'above right': 'south west', 'below left': 'north east', 'below right': 'north west' };
  const UNSUPPORTED = /\\(matrix|pic|graph|shade|shadedraw|datavisualization|pgfplot|addplot|tdplot\w*|spy)\b|\\begin\s*\{(axis|semilogyaxis|semilogxaxis|loglogaxis|polaraxis|groupplot)\}|\bchild\s*[{[]|\bpath picture\b/;

  // --- expressions (pgfmath subset) -------------------------------------------

  const DEG = Math.PI / 180;
  const FUNCS = {
    sin: (x) => Math.sin(x * DEG), cos: (x) => Math.cos(x * DEG), tan: (x) => Math.tan(x * DEG),
    asin: (x) => Math.asin(x) / DEG, acos: (x) => Math.acos(x) / DEG, atan: (x) => Math.atan(x) / DEG,
    atan2: (y, x) => Math.atan2(y, x) / DEG, sqrt: Math.sqrt, abs: Math.abs, exp: Math.exp, ln: Math.log, log10: Math.log10,
    log2: Math.log2, min: Math.min, max: Math.max, pow: Math.pow, mod: (a, b) => a % b, Mod: (a, b) => ((a % b) + b) % b,
    int: Math.trunc, floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign, deg: (x) => x / DEG,
    rad: (x) => x * DEG, veclen: (x, y) => Math.hypot(x, y), sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    real: (x) => x, frac: (x) => x - Math.floor(x), neg: (x) => -x,
  };
  const CONSTS = { pi: Math.PI, e: Math.E, true: 1, false: 0 };

  /** Evaluate an expression. Returns { v, unit } (unit: the value had a dimension; v is then in cm). */
  function evaluate(src) {
    const s = String(src).replace(/\\(?=[a-zA-Z])/g, '');
    let i = 0;
    let hadUnit = false;
    const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
    const fail = () => { throw new Error('bad expression: ' + src); };
    function primary() {
      ws();
      const c = s[i];
      if (c === '(' || c === '{') {
        i++;
        const v = expr();
        ws();
        if (s[i] === ')' || s[i] === '}') i++;
        return post(v);
      }
      if (c === '-') { i++; return -power(); }
      if (c === '+') { i++; return power(); }
      const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(s.slice(i));
      if (num) {
        i += num[0].length;
        let v = parseFloat(num[0]);
        ws();
        const u = /^(pt|cm|mm|in|em|ex|bp|pc|sp)(?![a-z])/.exec(s.slice(i));
        if (u) { i += u[0].length; v = (v * PT[u[1]]) * CM_PER_PT; hadUnit = true; }
        return post(v);
      }
      const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
      if (id) {
        i += id[0].length;
        const name = id[0];
        ws();
        if (FUNCS[name]) {
          const args = [];
          if (s[i] === '(') {
            i++;
            for (;;) { args.push(expr()); ws(); if (s[i] === ',') { i++; continue; } if (s[i] === ')') i++; break; }
          } else args.push(power());
          return post(FUNCS[name](...args));
        }
        if (name in CONSTS) return post(CONSTS[name]);
        fail();
      }
      fail();
      return 0;
    }
    function post(v) {
      ws();
      if (s[i] === 'r' && !/[A-Za-z]/.test(s[i + 1] || '')) { i++; v = v / DEG; } // radians -> degrees
      if (s[i] === '!' && s[i + 1] !== '=') { i++; let f = 1; for (let k = 2; k <= v; k++) f *= k; v = f; }
      return v;
    }
    function power() {
      const b = primary();
      ws();
      if (s[i] === '^') { i++; return Math.pow(b, power()); }
      return b;
    }
    function term() {
      let v = power();
      for (;;) {
        ws();
        if (s[i] === '*') { i++; v *= power(); } else if (s[i] === '/') { i++; v /= power(); } else return v;
      }
    }
    function sum() {
      let v = term();
      for (;;) {
        ws();
        if (s[i] === '+') { i++; v += term(); } else if (s[i] === '-') { i++; v -= term(); } else return v;
      }
    }
    function cmp() {
      let v = sum();
      ws();
      if (s[i] === '<' || s[i] === '>') {
        const op = s[i]; i++;
        const w = sum();
        v = op === '<' ? +(v < w) : +(v > w);
      }
      return v;
    }
    function expr() {
      const c = cmp();
      ws();
      if (s[i] === '?') { i++; const a = expr(); ws(); if (s[i] === ':') i++; const b = expr(); return c ? a : b; }
      return c;
    }
    const v = expr();
    ws();
    if (i < s.length || !isFinite(v)) fail();
    return { v, unit: hadUnit };
  }

  // --- affine transforms: [a, b, c, d, e, f] maps (x, y) to (ax+cy+e, bx+dy+f)

  const ID = [1, 0, 0, 1, 0, 0];
  const compose = (m, n) => [
    m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
  ];
  const apply = (m, p) => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
  const linear = (m, p) => [m[0] * p[0] + m[2] * p[1], m[1] * p[0] + m[3] * p[1]];

  // --- the parser -----------------------------------------------------------

  function TikzParser(cb) {
    this.cb = cb;
    this.paths = [];
    this.nodes = [];
    this.labels = [];
    this.names = Object.create(null); // node name -> index
    this.coords = Object.create(null); // \coordinate name -> point
    this.styles = Object.create(null);
    this.colors = Object.create(null);
    this.partial = false;
    this.clips = []; // \clip regions: { segs, parent }
    this.budget = 20000; // statements, against runaway \foreach
    if (cb.colors) {
      for (const k in cb.colors) {
        const [model, v] = cb.colors[k];
        const n = v.split(',').map((x) => parseFloat(x));
        let css = null;
        if (model === 'alias') css = this.color(v);
        else if (model === 'RGB') css = `rgb(${n.slice(0, 3).join(',')})`;
        else if (model === 'rgb') css = `rgb(${n.slice(0, 3).map((x) => Math.round(x * 255)).join(',')})`;
        else if (model === 'HTML') css = '#' + v.replace(/^#/, '');
        else if (model === 'gray') css = `rgb(${[n[0], n[0], n[0]].map((x) => Math.round(x * 255)).join(',')})`;
        else if (model === 'cmyk') css = `rgb(${[0, 1, 2].map((j) => Math.round(255 * (1 - n[j]) * (1 - n[3]))).join(',')})`;
        if (css) this.colors[k] = css;
      }
    }
  }

  TikzParser.prototype.color = function (spec) {
    spec = String(spec || '').trim();
    const head = spec.split('!')[0].trim();
    if (this.colors[head]) {
      if (head === spec) return this.colors[head];
      // a mix with a user colour: substitute and mix
      const parts = spec.split('!');
      let c = this.colors[head];
      for (let k = 1; k < parts.length; k += 2) {
        const other = k + 1 < parts.length ? this.colors[parts[k + 1].trim()] || color(parts[k + 1]) : COLORS.white;
        c = `color-mix(in srgb, ${c} ${parseFloat(parts[k]) || 0}%, ${other})`;
      }
      return c;
    }
    return color(spec);
  };

  TikzParser.prototype.isColor = function (k) {
    return isColor(k) || !!this.colors[k.split('!')[0].trim()];
  };

  /** Fresh drawing state. */
  function baseState() {
    return {
      tf: ID.slice(), ux: [1, 0], uy: [0, 1], draw: null, fill: null, col: null, lw: 0.4, dash: null, head: 'none', tail: 'none',
      arrow: 'to', node: [], opacity: 1, text: null, every: { node: [], label: [] }, font: 1, round: 0,
    };
  }

  /** Expand user styles in an option list. */
  TikzParser.prototype.expand = function (opts, depth) {
    const out = [];
    for (const raw of splitTop(opts, ',')) {
      const o = raw.trim();
      if (!o) continue;
      const [k, v] = keyVal(o);
      const st = /^(.*?)\/\.(style|append style)$/.exec(k);
      if (st) {
        const name = st[1].trim();
        this.styles[name] = (st[2] === 'append style' && this.styles[name] ? this.styles[name] + ',' : '') + (v || '');
        continue;
      }
      if (this.styles[k] !== undefined && (depth || 0) < 8) {
        const body = v !== null ? this.styles[k].replace(/#1/g, v) : this.styles[k].replace(/#1/g, '');
        out.push(...this.expand(body, (depth || 0) + 1));
        continue;
      }
      out.push(o);
    }
    return out;
  };

  /** Apply path options to a state (in place). Node-only options are collected into st.nodeOpts. */
  TikzParser.prototype.pathOptions = function (st, opts) {
    const nodeOpts = [];
    for (const o of this.expand(opts)) {
      const [k, v] = keyVal(o);
      if (this.transformOption(st, k, v)) continue;
      if (k === 'nodes') { st.every.node = st.every.node.concat(this.expand(v || '')); continue; }
      if (k === 'draw') { st.draw = v ? this.color(v) : (st.col || 'currentColor'); continue; }
      if (k === 'fill') { st.fill = v ? this.color(v) : (st.col || 'currentColor'); continue; }
      if (k === 'color') { st.col = this.color(v); if (st.draw) st.draw = st.col; continue; }
      if (k === 'text') { st.text = this.color(v); continue; }
      if (k === 'line width') { st.lw = (toEm(v, 'pt') || 0.04) * 10; continue; }
      if (LINE_WIDTHS[k] !== undefined) { st.lw = LINE_WIDTHS[k]; continue; }
      if (DASHES[k]) { st.dash = DASHES[k]; continue; }
      if (k === 'solid') { st.dash = null; continue; }
      if (k === '>') { const t = arrowSpec('-' + (v || '')); if (t) st.arrow = t[1]; continue; }
      if (k === 'opacity' || k === 'draw opacity' || k === 'fill opacity') { st.opacity = parseFloat(v) || 1; continue; }
      if (k === 'rounded corners') { st.round = v ? toEm(v, 'pt') || 0.4 : 0.4; continue; }
      if (k === 'sharp corners') { st.round = 0; continue; }
      if (k === 'font') { st.font = fontScale(v); continue; }
      // patterns library: hatching drawn in the pattern colour
      if (k === 'pattern') { st.pattern = Object.assign({ c: 'currentColor' }, st.pattern, { k: (v || '').trim() }); continue; }
      if (k === 'pattern color') { st.pattern = Object.assign({ k: 'north east lines' }, st.pattern, { c: this.color(v) }); continue; }
      // decorations: only the brace of decorations.pathreplacing is drawn
      if (k === 'decorate') { st.decorate = true; continue; }
      if (k === 'decoration') {
        const d = {};
        for (const x of splitTop(unbrace(v || ''), ',')) {
          const [dk, dv] = keyVal(x);
          if (dk === 'amplitude' || dk === 'raise') d[dk] = toEm(dv, 'pt') / 2.8453;
          else if (dk === 'mirror') d.mirror = true;
          else if (!dv && dk) d.name = dk;
          else if (dk === 'name') d.name = dv;
        }
        st.decoration = d;
        continue;
      }
      if (/^[<>|]*-[<>|]*$/.test(k) || /^(\{.*\}|[A-Za-z<>|]*)-(\{.*\}|[A-Za-z<>|]*)$/.test(k)) {
        const t = arrowSpec(k);
        if (t) {
          const def = st.arrow;
          st.tail = /^</.test(k) || /^\{?>/.test(k) ? (t[0] === 'to' ? def : t[0]) : t[0];
          st.head = /->|>$/.test(k) ? (t[1] === 'to' ? def : t[1]) : t[1];
          if (k.endsWith('-')) st.head = 'none';
          continue;
        }
      }
      if (this.isColor(k)) { st.col = this.color(k); continue; }
      nodeOpts.push(o);
    }
    st.nodeOpts = nodeOpts;
    return st;
  };

  function fontScale(v) {
    // \fontsize{8}{10}\selectfont: 8pt against the 10pt the picture is set in
    const f = /\\fontsize\s*\{\s*([\d.]+)\s*(pt)?\s*\}/.exec(v || '');
    if (f && parseFloat(f[1]) > 0) return round(parseFloat(f[1]) / 10);
    const m = /\\(tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)\b/.exec(v || '');
    return m ? FONT_SCALE[m[1]] : 1;
  }

  /** Coordinate transformations; true if `k` was one. */
  TikzParser.prototype.transformOption = function (st, k, v) {
    const num = (x) => { try { return evaluate(x).v; } catch (e) { return 0; } };
    const lenPt = (x) => { try { const r = evaluate(x); return r.unit ? r.v : r.v * CM_PER_PT; } catch (e) { return 0; } };
    switch (k) {
      case 'scale': { const s = num(v); st.tf = compose(st.tf, [s, 0, 0, s, 0, 0]); return true; }
      case 'xscale': st.tf = compose(st.tf, [num(v), 0, 0, 1, 0, 0]); return true;
      case 'yscale': st.tf = compose(st.tf, [1, 0, 0, num(v), 0, 0]); return true;
      case 'rotate': { const a = num(v) * DEG; st.tf = compose(st.tf, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]); return true; }
      case 'xshift': st.tf = compose(st.tf, [1, 0, 0, 1, lenPt(v), 0]); return true;
      case 'yshift': st.tf = compose(st.tf, [1, 0, 0, 1, 0, lenPt(v)]); return true;
      case 'shift': {
        const p = this.coordinate(unbrace(v || '').replace(/^\(|\)$/g, ''), st, true);
        if (Array.isArray(p)) st.tf = compose(st.tf, [1, 0, 0, 1, ...linearInverseFree(st, p)]);
        return true;
      }
      case 'x': st.ux = vecOpt(this, v, [1, 0], st); return true;
      case 'y': st.uy = vecOpt(this, v, [0, 1], st); return true;
      case 'transform shape': return true;
      default: return false;
    }
    function vecOpt(self, v, dflt, st) {
      v = unbrace(v || '');
      if (/^\(.*\)$/.test(v)) {
        const p = self.coordinate(v.slice(1, -1), Object.assign({}, st, { tf: ID, ux: [1, 0], uy: [0, 1] }), true);
        return Array.isArray(p) ? p : dflt;
      }
      let l = 1;
      try { l = evaluate(v).v; } catch (e) { /* keep 1 */ }
      return [dflt[0] * l, dflt[1] * l];
    }
    // shift={(1,2)} is given in the current coordinate system: undo the outer
    // transform's translation (the shift composes before it).
    function linearInverseFree(st, p) {
      const m = st.tf;
      const det = m[0] * m[3] - m[1] * m[2] || 1;
      const x = p[0] - m[4]; const y = p[1] - m[5];
      return [(m[3] * x - m[2] * y) / det, (-m[1] * x + m[0] * y) / det];
    }
  };

  /** Resolve the text of a coordinate "(…)" (without the parentheses). */
  TikzParser.prototype.coordinate = function (s, st, noRef) {
    s = s.trim();
    let shift = null;
    const pre = /^\[([^\]]*)\]\s*/.exec(s);
    if (pre) {
      s = s.slice(pre[0].length);
      const t = Object.assign({}, st, { tf: ID.slice() });
      for (const o of splitTop(pre[1], ',')) { const [k, v] = keyVal(o); this.transformOption(t, k, v); }
      shift = [t.tf[4], t.tf[5]];
    }
    const withShift = (p) => {
      if (!shift) return p;
      if (Array.isArray(p)) return [p[0] + shift[0], p[1] + shift[1]];
      return Object.assign({}, p, { dx: (p.dx || 0) + shift[0], dy: (p.dy || 0) + shift[1] });
    };
    if (s[0] === '$' && s[s.length - 1] === '$') return withShift(this.calc(s.slice(1, -1), st));
    const parts = splitTop(s, ',');
    const val = (x) => evaluate(unbrace(x));
    if (parts.length === 2) {
      const a = val(parts[0]);
      const b = val(parts[1]);
      const x = a.unit ? [a.v, 0] : [a.v * st.ux[0], a.v * st.ux[1]];
      const y = b.unit ? [0, b.v] : [b.v * st.uy[0], b.v * st.uy[1]];
      return withShift(apply(st.tf, [x[0] + y[0], x[1] + y[1]]));
    }
    const polar = splitTop(s, ':');
    if (polar.length === 2) {
      const ang = val(polar[0]).v * DEG;
      const rs = polar[1].split(/\s+and\s+/);
      const r1 = val(rs[0]);
      const r2 = rs[1] ? val(rs[1]) : r1;
      const ex = r1.unit ? [r1.v, 0] : [r1.v * st.ux[0], r1.v * st.ux[1]];
      const ey = r2.unit ? [0, r2.v] : [r2.v * st.uy[0], r2.v * st.uy[1]];
      const c = Math.cos(ang); const sn = Math.sin(ang);
      return withShift(apply(st.tf, [ex[0] * c + ey[0] * sn, ex[1] * c + ey[1] * sn]));
    }
    // a name, maybe with an anchor
    let name = s;
    let anchor = null;
    if (this.names[name] === undefined && this.coords[name] === undefined) {
      const dot = s.lastIndexOf('.');
      if (dot > 0) { name = s.slice(0, dot).trim(); anchor = s.slice(dot + 1).trim(); }
    }
    if (this.coords[name] !== undefined) return withShift(this.coords[name]);
    if (this.names[name] !== undefined) {
      if (noRef) return withShift(this.center(this.names[name]));
      const r = { n: this.names[name] };
      if (anchor && anchor !== 'center') r.a = anchor;
      return withShift(r);
    }
    throw new Error('unknown coordinate (' + s + ')');
  };

  /** ($(a)!0.5!(b)$), ($(a)+(1,0)$), ($2*(a)-(b)$) */
  TikzParser.prototype.calc = function (s, st) {
    const pt = (txt) => this.toXY(this.coordinate(txt, st, true));
    s = s.trim();
    let acc = [0, 0];
    let i = 0;
    let sign = 1;
    while (i < s.length) {
      i = skipWs(s, i);
      if (s[i] === '+') { sign = 1; i++; continue; }
      if (s[i] === '-') { sign = -1; i++; continue; }
      let factor = 1;
      const f = /^([\d.]+|\{[^}]*\})\s*\*\s*/.exec(s.slice(i));
      if (f) { factor = evaluate(unbrace(f[1])).v; i += f[0].length; }
      if (s[i] !== '(') break;
      const e = matchGroup(s, i);
      let p = pt(s.slice(i + 1, e - 1));
      i = skipWs(s, e);
      while (s[i] === '!') {
        const e2 = s.indexOf('!', i + 1);
        const t = s.slice(i + 1, e2).trim();
        const j = skipWs(s, e2 + 1);
        const e3 = matchGroup(s, j);
        const q = pt(s.slice(j + 1, e3 - 1));
        const m = /^([^:]*?)\s*(?::(.*))?$/.exec(t);
        if (m[2] !== undefined) {
          // (a)!len!angle:(b) is rare; take the plain partway form
          const tt = evaluate(m[1] || '0').v;
          p = [p[0] + (q[0] - p[0]) * tt, p[1] + (q[1] - p[1]) * tt];
        } else {
          const r = evaluate(m[1]);
          if (r.unit) {
            const d = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
            p = [p[0] + ((q[0] - p[0]) * r.v) / d, p[1] + ((q[1] - p[1]) * r.v) / d];
          } else p = [p[0] + (q[0] - p[0]) * r.v, p[1] + (q[1] - p[1]) * r.v];
        }
        i = skipWs(s, e3);
      }
      acc = [acc[0] + sign * factor * p[0], acc[1] + sign * factor * p[1]];
      sign = 1;
    }
    return acc;
  };

  /** Numeric position of a point or node reference (its centre or anchor, estimated). */
  TikzParser.prototype.toXY = function (p) {
    if (Array.isArray(p)) return p;
    const c = this.center(p.n);
    let x = c[0]; let y = c[1];
    if (p.a) {
      const ang = COMPASS[p.a] !== undefined ? COMPASS[p.a] : parseFloat(p.a);
      if (!isNaN(ang)) {
        const n = this.nodes[p.n];
        const est = n.est || [0.3, 0.2];
        x += Math.cos(ang * DEG) * est[0];
        y += Math.sin(ang * DEG) * est[1];
      }
    }
    return [x + (p.dx || 0), y + (p.dy || 0)];
  };

  TikzParser.prototype.center = function (k) {
    const n = this.nodes[k];
    return n && n.at ? n.at : n && n.pos ? n.pos : [0, 0];
  };

  // --- statements -------------------------------------------------------------

  TikzParser.prototype.run = function (body, st) {
    let i = 0;
    const s = body;
    while (i < s.length) {
      if (--this.budget < 0) { this.partial = true; return; }
      i = skipWs(s, i);
      if (i >= s.length) break;
      const c = s[i];
      if (c === ';') { i++; continue; }
      if (c === '{') {
        const e = matchGroup(s, i);
        this.run(s.slice(i + 1, e - 1), cloneState(st));
        i = e;
        continue;
      }
      if (c !== '\\') { i++; continue; }
      const m = /^\\([A-Za-z]+)\s*/.exec(s.slice(i));
      if (!m) { i += 2; continue; }
      const cmd = m[1];
      let j = i + m[0].length;
      if (cmd === 'begin') {
        const env = /^\{([^}]*)\}/.exec(s.slice(j));
        if (!env) { i = j; continue; }
        const name = env[1];
        const e = findEnd(s, j + env[0].length, name);
        let inner = s.slice(j + env[0].length, e.contentEnd);
        const t = cloneState(st);
        if (name === 'scope' || name === 'pgfonlayer') {
          let k2 = skipWs(inner, 0);
          if (inner[k2] === '[' && name === 'scope') {
            const oe = matchGroup(inner, k2);
            this.pathOptions(t, inner.slice(k2 + 1, oe - 1));
            t.every.node = t.every.node.concat(t.nodeOpts);
            inner = inner.slice(oe);
          } else if (name === 'pgfonlayer') {
            inner = inner.replace(/^\s*\{[^}]*\}/, '');
          }
          this.run(inner, t);
        } else this.partial = true;
        i = e.end;
        continue;
      }
      // a macro the picture defined, used as a statement (\def\branches#1{\draw[#1] …;} … \branches{red})
      const mac = !STATEMENTS.has(cmd) && this.macro(cmd);
      if (mac) {
        const c = callMacro(mac, s, j);
        if (--this.budget < 0) { this.partial = true; return; }
        this.run(c.text, st);
        i = c.end;
        continue;
      }
      if (NO_SEMI.has(cmd)) {
        // not ended by ';'
        this.skipTo = j;
        try { this.statement(cmd, '', st, s, j); } catch (err) { this.partial = true; }
        i = Math.max(this.skipTo, j);
        continue;
      }
      // the rest of the statement, up to ';' at top level
      const end = statementEnd(s, j);
      const stmt = s.slice(j, end);
      i = end + 1;
      try {
        this.statement(cmd, stmt, st, s, j);
      } catch (err) {
        this.partial = true;
      }
    }
  };

  const NO_SEMI = new Set(['foreach', 'def', 'pgfmathsetmacro', 'pgfmathtruncatemacro', 'tikzset', 'newcommand', 'renewcommand',
    'usetikzlibrary', 'pgfsetlinewidth', 'pgfdeclarelayer', 'pgfsetlayers', 'small', 'footnotesize', 'scriptsize', 'tiny', 'large',
    'normalsize', 'centering', 'noindent']);

  const STATEMENTS = new Set(['draw', 'fill', 'filldraw', 'path', 'useasboundingbox', 'clip', 'node', 'coordinate', 'tikzstyle', 'begin', 'end']);

  function cloneState(st) {
    return Object.assign({}, st, { every: { node: st.every.node.slice(), label: st.every.label.slice() } });
  }

  function findEnd(s, from, name) {
    const re = /\\(begin|end)\s*\{([^}]*)\}/g;
    re.lastIndex = from;
    let depth = 1;
    let m;
    while ((m = re.exec(s))) {
      if (m[2] !== name) continue;
      if (m[1] === 'begin') depth++;
      else if (--depth === 0) return { contentEnd: m.index, end: m.index + m[0].length };
    }
    return { contentEnd: s.length, end: s.length };
  }

  function statementEnd(s, i) {
    let depth = 0;
    for (; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') { i++; continue; }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') depth--;
      else if (c === ';' && depth <= 0) return i;
    }
    return s.length;
  }

  TikzParser.prototype.statement = function (cmd, stmt, st, whole, at) {
    switch (cmd) {
      case 'draw': return this.path(stmt, st, { draw: true });
      case 'fill': return this.path(stmt, st, { fill: true });
      case 'filldraw': return this.path(stmt, st, { draw: true, fill: true });
      case 'path': case 'useasboundingbox': return this.path(stmt, st, {});
      case 'clip': {
        // later paths in this scope are cut to this region (nested clips intersect)
        const before = this.paths.length;
        this.path(stmt, st, {});
        const added = this.paths.splice(before);
        if (added.length) {
          this.clips.push({ segs: added[0].segs, parent: st.clip });
          st.clip = this.clips.length - 1;
        }
        return undefined;
      }
      case 'node': return this.path('node ' + stmt, st, {});
      case 'coordinate': return this.path('coordinate ' + stmt, st, {});
      case 'foreach': return this.foreach(whole, at, st);
      case 'def': case 'pgfmathsetmacro': case 'pgfmathtruncatemacro': case 'newcommand': case 'renewcommand':
        return this.define(cmd, whole, at);
      case 'tikzset': {
        const e = matchGroup(whole, skipWs(whole, at));
        this.expand(whole.slice(skipWs(whole, at) + 1, e - 1));
        this.skipTo = e;
        return undefined;
      }
      case 'tikzstyle': {
        // \tikzstyle{name}=[opts]
        const m = /^\{([^}]*)\}\s*(?:\+?=)\s*\[([\s\S]*)\]\s*$/.exec(stmt.trim());
        if (m) this.styles[m[1].trim()] = m[2];
        return undefined;
      }
      case 'usetikzlibrary': case 'pgfsetlinewidth': case 'pgfdeclarelayer': case 'pgfsetlayers': {
        const k = skipWs(whole, at);
        this.skipTo = whole[k] === '{' ? matchGroup(whole, k) : k;
        return undefined;
      }
      case 'small': case 'footnotesize': case 'scriptsize': case 'tiny':
      case 'large': case 'normalsize': case 'centering': case 'noindent':
        return undefined;
      default:
        this.partial = true;
        return undefined;
    }
  };

  /** \def\r{2}, \pgfmathsetmacro{\r}{2*3}, \newcommand{\r}{2}: substitute textually in what follows. */
  TikzParser.prototype.define = function (cmd, whole, at) {
    let i = skipWs(whole, at);
    let name;
    if (whole[i] === '{') {
      const e = matchGroup(whole, i);
      name = whole.slice(i + 1, e - 1).trim();
      i = skipWs(whole, e);
    } else {
      const m = /^\\[A-Za-z]+/.exec(whole.slice(i));
      if (!m) { this.skipTo = i + 1; return; }
      name = m[0];
      i = skipWs(whole, i + m[0].length);
    }
    // arguments: \newcommand{\f}[2]{…} or \def\f#1#2{…}
    let nargs = 0;
    if (whole[i] === '[') {
      const oe = matchGroup(whole, i);
      nargs = parseInt(whole.slice(i + 1, oe - 1), 10) || 0;
      i = skipWs(whole, oe);
      if (whole[i] === '[') i = skipWs(whole, matchGroup(whole, i)); // default for #1: ignored
    }
    const params = /^(?:#\d)+/.exec(whole.slice(i));
    if (params) { nargs = params[0].length / 2; i = skipWs(whole, i + params[0].length); }
    if (whole[i] !== '{') { this.skipTo = i; return; }
    const e = matchGroup(whole, i);
    let val = whole.slice(i + 1, e - 1);
    if (cmd.startsWith('pgfmath')) {
      try { val = String(round(evaluate(this.subst(val)).v)); } catch (err) { /* keep text */ }
      if (cmd === 'pgfmathtruncatemacro') val = String(Math.trunc(parseFloat(val)));
    }
    this.macros = this.macros || [];
    this.macros.push([name.replace(/^\\/, ''), val, nargs]);
    this.skipTo = e;
  };

  /** The macro called name, as [name, body, nargs], or undefined. */
  TikzParser.prototype.macro = function (name) {
    if (this.macros) for (let k = this.macros.length - 1; k >= 0; k--) if (this.macros[k][0] === name) return this.macros[k];
    return this.docMacro(name);
  };

  /**
   * A macro the document defined before the picture (\def\edge{(0,0) -- (1,1)}
   * outside the tikzpicture), as [name, body, nargs], when its body is TikZ:
   * path coordinates or drawing commands, or a number. Other document macros stay for KaTeX.
   */
  TikzParser.prototype.docMacro = function (name) {
    const d = this.cb.macros && Object.prototype.hasOwnProperty.call(this.cb.macros, name) ? this.cb.macros[name] : null;
    if (!d || d.delims || typeof d.body !== 'string') return undefined;
    const b = d.body.trim();
    // a number, perhaps with a unit (\def\r{1.5}, or a \tgparam's value), also counts
    if (!/^(\(|\\(draw|fill|filldraw|path|node|coordinate|foreach|clip)\b)/.test(b) && !/^[-+]?(\d+\.?\d*|\.\d+)\s*(cm|mm|pt|in|em|ex|bp)?$/.test(b)) return undefined;
    return [name, d.body, d.nargs || 0];
  };

  /** The body of macro mac called at text[i] (just after its name), with its arguments put in: { text, end }. */
  function callMacro(mac, text, i) {
    let body = mac[1];
    let j = i;
    for (let a = 1; a <= mac[2]; a++) {
      j = skipWs(text, j);
      let arg;
      if (text[j] === '{') { const e = matchGroup(text, j); arg = text.slice(j + 1, e - 1); j = e; }
      else if (text[j] === '\\') { const m = /^\\(?:[A-Za-z]+|.)/.exec(text.slice(j)); arg = m[0]; j += m[0].length; }
      else { arg = text[j] || ''; j++; }
      body = body.replace(new RegExp('#' + a, 'g'), () => arg);
    }
    return { text: body, end: j };
  }

  TikzParser.prototype.subst = function (text) {
    if (this.cb.macros) {
      // document macros holding coordinates or paths
      const re = /\\([A-Za-z]+)\s?/g;
      let m;
      let guard = 0;
      while ((m = re.exec(text)) && guard++ < 500) {
        if (this.macros && this.macros.some((x) => x[0] === m[1])) continue;
        const mac = this.docMacro(m[1]);
        if (!mac) continue;
        const c = callMacro(mac, text, m.index + m[0].length);
        text = text.slice(0, m.index) + c.text + text.slice(c.end);
        re.lastIndex = m.index;
      }
    }
    if (!this.macros) return text;
    for (let k = this.macros.length - 1; k >= 0; k--) {
      const mac = this.macros[k];
      const [n, v, nargs] = mac;
      const re = new RegExp('\\\\' + n + '(?![A-Za-z])\\s?', 'g');
      if (!nargs) { text = text.replace(re, () => v); continue; }
      let m;
      let guard = 0;
      while ((m = re.exec(text)) && guard++ < 200) {
        const c = callMacro(mac, text, m.index + m[0].length);
        text = text.slice(0, m.index) + c.text + text.slice(c.end);
        re.lastIndex = m.index + c.text.length;
      }
    }
    return text;
  };

  /** \foreach \x [count=\i] in {1,...,5} { body }  or  ... in {..} \draw ...; */
  TikzParser.prototype.foreach = function (whole, at, st) {
    let i = skipWs(whole, at);
    const vars = /^(\\[A-Za-z]+(?:\s*\/\s*\\[A-Za-z]+)*)\s*/.exec(whole.slice(i));
    if (!vars) { this.skipTo = statementEnd(whole, i) + 1; this.partial = true; return; }
    const names = vars[1].split('/').map((v) => v.trim().slice(1));
    i += vars[0].length;
    let count = null;
    let evalVar = null;
    if (whole[i] === '[') {
      const e = matchGroup(whole, i);
      for (const o of splitTop(whole.slice(i + 1, e - 1), ',')) {
        const [k, v] = keyVal(o);
        if (k === 'count') count = v.replace(/\s+from.*$/, '').trim().slice(1);
        if (k === 'evaluate') { const m = /^\\(\w+)\s+as\s+\\(\w+)\s+using\s+(.*)$/.exec(v || ''); if (m) evalVar = m.slice(1); }
      }
      i = skipWs(whole, e);
    }
    const inKw = /^in\s*/.exec(whole.slice(i));
    if (!inKw) { this.skipTo = statementEnd(whole, i) + 1; this.partial = true; return; }
    i += inKw[0].length;
    let listText;
    if (whole[i] === '{') {
      const e = matchGroup(whole, i);
      listText = whole.slice(i + 1, e - 1);
      i = skipWs(whole, e);
    } else {
      const m = /^\\[A-Za-z]+/.exec(whole.slice(i));
      listText = m ? this.subst(m[0]) : '';
      i = skipWs(whole, i + (m ? m[0].length : 0));
    }
    let body;
    if (whole[i] === '{') {
      const e = matchGroup(whole, i);
      body = whole.slice(i + 1, e - 1);
      this.skipTo = e;
    } else {
      const e = statementEnd(whole, i);
      body = whole.slice(i, e + 1);
      this.skipTo = e + 1;
    }
    const items = expandList(this.subst(listText));
    items.forEach((item, idx) => {
      const vals = splitTop(item, '/');
      let b = body;
      const subs = names.map((n, k) => [n, (vals[k] !== undefined ? vals[k] : vals[vals.length - 1]).trim()]);
      if (count) subs.push([count, String(idx + 1)]);
      if (evalVar) {
        try {
          const expr = evalVar[2].replace(new RegExp('\\\\' + evalVar[0] + '(?![A-Za-z])', 'g'), subs.find((x) => x[0] === evalVar[0])?.[1] || '0');
          subs.push([evalVar[1], String(round(evaluate(expr).v))]);
        } catch (e) { /* ignore */ }
      }
      subs.sort((a, c) => c[0].length - a[0].length);
      for (const [n, v] of subs) b = b.replace(new RegExp('\\\\' + n + '(?![A-Za-z])', 'g'), () => v);
      this.run(b, st);
    });
  };

  /** "1,...,5", "0,0.5,...,2", "a,b,c" -> items. */
  function expandList(text) {
    const parts = splitTop(text, ',').map((p) => p.trim()).filter((p) => p !== '');
    const out = [];
    for (let k = 0; k < parts.length; k++) {
      if (parts[k] === '...' && k > 0 && k + 1 < parts.length) {
        const a = parseFloat(out[out.length - 1]);
        const prev = out.length > 1 ? parseFloat(out[out.length - 2]) : NaN;
        const b = parseFloat(parts[k + 1]);
        if (isNaN(a) || isNaN(b)) {
          // letters: a,...,e
          const ca = out[out.length - 1].charCodeAt(0);
          const cb2 = parts[k + 1].charCodeAt(0);
          for (let ch = ca + 1; ch < cb2; ch++) out.push(String.fromCharCode(ch));
          continue;
        }
        const step = !isNaN(prev) && out.length > 1 ? a - prev : (b >= a ? 1 : -1);
        if (!step) continue;
        for (let x = a + step, n = 0; (step > 0 ? x < b - 1e-9 : x > b + 1e-9) && n < 2000; x += step, n++) out.push(String(round(x)));
        continue;
      }
      out.push(parts[k]);
    }
    return out;
  }

  // --- paths --------------------------------------------------------------------

  /** A cubic for an arc from angle a0 to a1 (degrees) on the ellipse (rx, ry) around c, under the linear part of tf. */
  function arcSegs(tf, c, rx, ry, a0, a1) {
    const out = [];
    const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / 90));
    const step = (a1 - a0) / n;
    const k = (4 / 3) * Math.tan((step * DEG) / 4);
    const P = (a) => { const v = linear(tf, [rx * Math.cos(a * DEG), ry * Math.sin(a * DEG)]); return [c[0] + v[0], c[1] + v[1]]; };
    const D = (a) => linear(tf, [-rx * Math.sin(a * DEG), ry * Math.cos(a * DEG)]);
    for (let s = 0; s < n; s++) {
      const t0 = a0 + s * step;
      const t1 = t0 + step;
      const p0 = P(t0); const p1 = P(t1); const d0 = D(t0); const d1 = D(t1);
      // d0, d1 already have the radius as their length
      out.push(['C', [p0[0] + d0[0] * k, p0[1] + d0[1] * k], [p1[0] - d1[0] * k, p1[1] - d1[1] * k], p1]);
    }
    return out;
  }

  /**
   * A curly brace (decorations.pathreplacing) in place of a straight path from its
   * first to its last point. It bulges to the left of the path, or the right when mirrored.
   */
  function braceSegs(segs, d) {
    const pts = [];
    for (const g of segs) if (g.length > 1 && Array.isArray(g[g.length - 1])) pts.push(g[g.length - 1]);
    if (pts.length < 2) return segs;
    const a = pts[0];
    const b = pts[pts.length - 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!L) return segs;
    const u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    const sgn = d.mirror ? -1 : 1;
    const nrm = [-u[1] * sgn, u[0] * sgn];
    const h = d.amplitude > 0 ? d.amplitude : 5 / 28.4528; // 5pt
    const r = d.raise || 0;
    const q = Math.min(h / 2, L / 4);
    const P = (s, t) => [round(a[0] + u[0] * s + nrm[0] * (t + r)), round(a[1] + u[1] * s + nrm[1] * (t + r))];
    const m = L / 2;
    return [
      ['M', P(0, 0)],
      ['C', P(0, h / 4), P(0, h / 2), P(q, h / 2)],
      ['L', P(m - q, h / 2)],
      ['C', P(m, h / 2), P(m, h / 2), P(m, h)],
      ['M', P(m, h)],
      ['C', P(m, h / 2), P(m, h / 2), P(m + q, h / 2)],
      ['L', P(L - q, h / 2)],
      ['C', P(L, h / 2), P(L, h / 4), P(L, 0)],
    ];
  }

  TikzParser.prototype.path = function (text, st0, kind) {
    text = this.subst(text);
    const st = cloneState(st0);
    const segs = [];
    const subpaths = []; // extra paths from `edge`
    let cur = null; // current point (number pair or ref)
    let ref = null; // reference for "+" coordinates
    let start = null; // start of the current subpath
    let pendingOp = null; // '--', 'to', '-|', '|-', 'edge', 'rectangle', 'controls', 'grid'
    let opOpts = null;
    let controls = [];
    let pendingNodes = []; // nodes waiting for the next segment
    let i = 0;
    const s = text;
    const xy = (p) => this.toXY(p);

    const readOpts = () => {
      i = skipWs(s, i);
      if (s[i] !== '[') return null;
      const e = matchGroup(s, i);
      const o = s.slice(i + 1, e - 1);
      i = e;
      return o;
    };

    const addSeg = (seg) => {
      segs.push(seg);
      for (const n of pendingNodes) this.nodes[n].on = { path: this.paths.length, seg: segs.length - 1, t: this.nodes[n].on.t };
      pendingNodes = [];
    };

    const lineTo = (p) => {
      if (pendingOp === '--' || pendingOp === null) addSeg(['L', p]);
      else if (pendingOp === '-|' || pendingOp === '|-') {
        const a = xy(cur); const b = xy(p);
        const corner = pendingOp === '-|' ? [b[0], a[1]] : [a[0], b[1]];
        const nodes = pendingNodes;
        pendingNodes = [];
        segs.push(['L', corner]);
        segs.push(['L', p]);
        for (const n of nodes) {
          const t = this.nodes[n].on.t;
          this.nodes[n].on = t <= 0.5 ? { path: this.paths.length, seg: segs.length - 2, t: t * 2 } : { path: this.paths.length, seg: segs.length - 1, t: t * 2 - 1 };
        }
      } else if (pendingOp === 'to') {
        const o = opOpts ? this.expand(opOpts) : [];
        let out = null; let inn = null; let bend = 0; let loose = 1;
        for (const oo of o) {
          const [k, v] = keyVal(oo);
          if (k === 'out') out = parseFloat(v);
          else if (k === 'in') inn = parseFloat(v);
          else if (k === 'bend left') bend = v ? parseFloat(v) : 30;
          else if (k === 'bend right') bend = -(v ? parseFloat(v) : 30);
          else if (k === 'looseness') loose = parseFloat(v) || 1;
        }
        const a = xy(cur); const b = xy(p);
        const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
        const k = 0.3915 * d * loose;
        if (out !== null && inn !== null) {
          addSeg(['C', [a[0] + k * Math.cos(out * DEG), a[1] + k * Math.sin(out * DEG)], [b[0] + k * Math.cos(inn * DEG), b[1] + k * Math.sin(inn * DEG)], p]);
        } else if (bend) {
          const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) / DEG;
          addSeg(['C', [a[0] + k * Math.cos((ang + bend) * DEG), a[1] + k * Math.sin((ang + bend) * DEG)],
            [b[0] + k * Math.cos((ang + 180 - bend) * DEG), b[1] + k * Math.sin((ang + 180 - bend) * DEG)], p]);
        } else addSeg(['L', p]);
      } else if (pendingOp === 'controls') {
        const c1 = xy(controls[0]);
        const c2 = xy(controls[1] || controls[0]);
        addSeg(['C', c1, c2, p]);
      } else if (pendingOp === 'rectangle') {
        const a = xy(cur); const b = xy(p);
        pendingNodes = [];
        segs.push(['L', [b[0], a[1]]], ['L', b], ['L', [a[0], b[1]]], ['Z']);
      } else if (pendingOp === 'grid') {
        const a = xy(cur); const b = xy(p);
        let step = [1, 1];
        for (const oo of opOpts ? this.expand(opOpts) : []) {
          const [k, v] = keyVal(oo);
          try {
            if (k === 'step') { const r = /^\(.*\)$/.test(v) ? this.coordinate(v.slice(1, -1), Object.assign({}, st, { tf: ID }), true) : null; step = r ? [Math.abs(r[0]), Math.abs(r[1])] : [evaluate(v).v, evaluate(v).v]; }
            if (k === 'xstep') step[0] = evaluate(v).v;
            if (k === 'ystep') step[1] = evaluate(v).v;
          } catch (e) { /* default */ }
        }
        const sc = Math.hypot(st.tf[0], st.tf[1]) || 1;
        const [x0, x1] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
        const [y0, y1] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
        const sx = step[0] * sc; const sy = step[1] * sc;
        if (sx > 0 && (x1 - x0) / sx < 400) for (let x = Math.ceil(x0 / sx - 1e-9) * sx; x <= x1 + 1e-9; x += sx) segs.push(['M', [x, y0]], ['L', [x, y1]]);
        if (sy > 0 && (y1 - y0) / sy < 400) for (let y = Math.ceil(y0 / sy - 1e-9) * sy; y <= y1 + 1e-9; y += sy) segs.push(['M', [x0, y]], ['L', [x1, y]]);
        segs.push(['M', p]);
      }
      controls = [];
      pendingOp = null;
      opOpts = null;
    };

    const moveTo = (p) => {
      if (pendingOp === 'edge') {
        // a separate path from the current point
        const est = cloneState(st);
        if (opOpts) this.pathOptions(est, opOpts);
        if (!est.draw) est.draw = st.draw || est.col || 'currentColor';
        const e = { segs: [['M', cur], ['L', p]] };
        const nodes = pendingNodes;
        pendingNodes = [];
        subpaths.push({ e, st: est, nodes });
        pendingOp = null;
        opOpts = null;
        return;
      }
      if (pendingOp) { lineTo(p); } else { addSeg(['M', p]); start = p; }
      cur = p;
    };

    // path-level options may come first
    const first = readOpts();
    if (first) this.pathOptions(st, first);
    if (kind.draw && !st.draw) st.draw = st.col || 'currentColor';
    if (kind.fill && !st.fill) st.fill = st.col || 'currentColor';
    if (!kind.draw && !kind.fill && !first) { st.draw = null; st.fill = null; }

    while (i < s.length) {
      i = skipWs(s, i);
      if (i >= s.length) break;
      const rest = s.slice(i);
      let m;
      if (s[i] === '[') { const o = readOpts(); this.pathOptions(st, o); continue; }
      if (s[i] === '(' || rest.startsWith('+(') || rest.startsWith('++(')) {
        const rel = rest.startsWith('++(') ? 2 : rest.startsWith('+(') ? 1 : 0;
        i += rel;
        const e = matchGroup(s, i);
        const inner = s.slice(i + 1, e - 1);
        i = e;
        if (pendingOp === 'controls' && /^\s*(and|\.\.)/.test(s.slice(i)) && !rel) {
          controls.push(this.coordinate(inner, st));
          continue;
        }
        let p;
        if (rel) {
          const base = xy(ref || cur || [0, 0]);
          const d = this.coordinate(inner, Object.assign({}, st, { tf: [st.tf[0], st.tf[1], st.tf[2], st.tf[3], 0, 0] }), true);
          p = [base[0] + d[0], base[1] + d[1]];
          if (rel === 2) ref = p;
        } else {
          p = this.coordinate(inner, st);
          ref = p;
        }
        if (pendingOp === 'controls' && /^\s*(and|\.\.)/.test(s.slice(i))) { controls.push(p); continue; }
        moveTo(p);
        if (pendingOp === null && rel !== 1) ref = p;
        continue;
      }
      if ((m = /^(--|-\||\|-)/.exec(rest))) { pendingOp = m[1]; i += m[0].length; continue; }
      if ((m = /^\.\.\s*controls\s*/.exec(rest))) { pendingOp = 'controls'; controls = []; i += m[0].length; continue; }
      if ((m = /^(and|\.\.)\s*/.exec(rest))) { i += m[0].length; continue; }
      if ((m = /^(to|edge)\b\s*/.exec(rest))) {
        pendingOp = m[1];
        i += m[0].length;
        opOpts = readOpts();
        continue;
      }
      if ((m = /^rectangle\b\s*/.exec(rest))) { pendingOp = 'rectangle'; i += m[0].length; continue; }
      if ((m = /^grid\b\s*/.exec(rest))) { pendingOp = 'grid'; i += m[0].length; opOpts = readOpts(); continue; }
      if ((m = /^cycle\b/.exec(rest))) {
        i += m[0].length;
        if (pendingOp && pendingOp !== '--') { lineTo(start); } else addSeg(['Z']);
        pendingOp = null;
        cur = start;
        continue;
      }
      if ((m = /^(circle|ellipse)\b\s*/.exec(rest))) {
        i += m[0].length;
        const o = readOpts();
        let rx = 1; let ry = 1;
        const c = xy(cur || [0, 0]);
        const val = (v) => { const r = evaluate(v); return r.unit ? r.v / (Math.hypot(st.tf[0], st.tf[1]) || 1) : r.v; };
        i = skipWs(s, i);
        if (s[i] === '(') {
          const e = matchGroup(s, i);
          const rr = s.slice(i + 1, e - 1).split(/\s+and\s+/);
          rx = val(rr[0]); ry = rr[1] ? val(rr[1]) : rx;
          i = e;
        }
        for (const oo of o ? this.expand(o) : []) {
          const [k, v] = keyVal(oo);
          if (k === 'radius') rx = ry = val(v);
          else if (k === 'x radius') rx = val(v);
          else if (k === 'y radius') ry = val(v);
        }
        const seg = arcSegs(st.tf, c, rx * st.ux[0] || rx, ry * st.uy[1] || ry, 0, 360);
        segs.push(['M', [seg[seg.length - 1][3][0], seg[seg.length - 1][3][1]]], ...seg, ['Z'], ['M', c]);
        continue;
      }
      if ((m = /^arc\b\s*/.exec(rest))) {
        i += m[0].length;
        const o = readOpts();
        let a0 = 0; let a1 = 90; let rx = 1; let ry = 1; let delta = null;
        const val = (v) => evaluate(v);
        i = skipWs(s, i);
        if (s[i] === '(') {
          const e = matchGroup(s, i);
          const parts = splitTop(s.slice(i + 1, e - 1), ':');
          a0 = val(parts[0]).v; a1 = val(parts[1]).v;
          const rr = (parts[2] || '1').split(/\s+and\s+/);
          rx = val(rr[0]).v; ry = rr[1] ? val(rr[1]).v : rx;
          i = e;
        }
        for (const oo of o ? this.expand(o) : []) {
          const [k, v] = keyVal(oo);
          if (k === 'start angle') a0 = val(v).v;
          else if (k === 'end angle') a1 = val(v).v;
          else if (k === 'delta angle') delta = val(v).v;
          else if (k === 'radius') rx = ry = val(v).v;
          else if (k === 'x radius') rx = val(v).v;
          else if (k === 'y radius') ry = val(v).v;
        }
        if (delta !== null) a1 = a0 + delta;
        const p0 = xy(cur || [0, 0]);
        const off = linear(st.tf, [rx * Math.cos(a0 * DEG), ry * Math.sin(a0 * DEG)]);
        const c = [p0[0] - off[0], p0[1] - off[1]];
        const segsA = arcSegs(st.tf, c, rx, ry, a0, a1);
        for (const sg of segsA) addSeg(sg);
        cur = segsA[segsA.length - 1][3];
        ref = cur;
        continue;
      }
      if ((m = /^plot\b\s*/.exec(rest))) {
        i += m[0].length;
        const o = readOpts();
        let domain = [-5, 5]; let samples = 25; let variable = 'x';
        const all = (st.plotOpts || []).concat(st.nodeOpts || [], o ? this.expand(o) : []);
        for (const oo of all) {
          const [k, v] = keyVal(oo);
          if (k === 'domain') { const d = v.split(':'); domain = [evaluate(d[0]).v, evaluate(d[1]).v]; }
          else if (k === 'samples') samples = Math.max(2, Math.min(1000, parseInt(v, 10) || 25));
          else if (k === 'variable') variable = v.trim().replace(/^\\/, '');
        }
        i = skipWs(s, i);
        const pts = [];
        if (rest.slice(m[0].length).trim().startsWith('coordinates') || s.slice(i).startsWith('coordinates')) {
          const k = s.indexOf('{', i);
          const e = matchGroup(s, k);
          const list = s.slice(k + 1, e - 1);
          const re = /\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;
          let mm;
          while ((mm = re.exec(list))) pts.push(this.coordinate(mm[1], st, true));
          i = e;
        } else if (s[i] === '(') {
          const e = matchGroup(s, i);
          const expr = s.slice(i + 1, e - 1);
          i = e;
          for (let k = 0; k < samples; k++) {
            const x = domain[0] + ((domain[1] - domain[0]) * k) / (samples - 1);
            const sub = expr.replace(new RegExp('\\\\' + variable + '(?![A-Za-z])', 'g'), `(${x})`);
            try { pts.push(this.coordinate(sub, st, true)); } catch (err) { /* skip a bad sample */ }
          }
        } else { this.partial = true; break; }
        pts.forEach((p, k) => {
          if (k === 0 && (pendingOp === null || !cur)) { addSeg(['M', p]); start = p; } else addSeg(['L', p]);
        });
        pendingOp = null;
        if (pts.length) { cur = pts[pts.length - 1]; ref = cur; }
        continue;
      }
      if ((m = /^(node|coordinate)\b\s*/.exec(rest))) {
        i += m[0].length;
        i = this.node(s, i, st, m[1] === 'coordinate', {
          cur: () => cur,
          pending: pendingOp !== null && pendingOp !== 'controls',
          attach: (k, t) => { this.nodes[k].on = { t }; pendingNodes.push(k); },
          prev: (k, t) => {
            if (!segs.length || segs[segs.length - 1][0] === 'M') return false;
            this.nodes[k].on = { path: this.paths.length, seg: segs.length - 1, t };
            return true;
          },
        });
        continue;
      }
      if ((m = /^(sin|cos|parabola|let|svg|child|pic|decorate)\b/.exec(rest))) { this.partial = true; break; }
      i++;
    }

    if (st.decorate) {
      if (st.decoration && st.decoration.name === 'brace') segs.splice(0, segs.length, ...braceSegs(segs, st.decoration));
      else this.partial = true;
    }
    if (segs.length) {
      this.paths.push({ segs, draw: st.draw, fill: st.fill, lw: st.lw, dash: st.dash, head: st.head, tail: st.tail, op: st.opacity !== 1 ? st.opacity : undefined, rc: st.round || undefined, clip: st.clip, pat: st.pattern || undefined });
    }
    for (const sp of subpaths) {
      const e = sp.st;
      this.paths.push({ segs: sp.e.segs, draw: e.draw, fill: null, lw: e.lw, dash: e.dash, head: e.head, tail: e.tail, clip: st.clip });
      const at = this.paths.length - 1;
      for (const n of sp.nodes) this.nodes[n].on = { path: at, seg: 1, t: this.nodes[n].on.t };
    }
    // nodes left waiting (e.g. "-- node {x}" at the end) sit at the current point
    for (const n of pendingNodes) { delete this.nodes[n].on; this.nodes[n].at = xy(cur || [0, 0]); }
  };

  /** node[opts] (name) at (p) {text}; returns the index after it. */
  TikzParser.prototype.node = function (s, i, st, isCoord, ctx) {
    let opts = '';
    let name = null;
    let at = null;
    for (;;) {
      i = skipWs(s, i);
      if (s[i] === '[') { const e = matchGroup(s, i); opts += ',' + s.slice(i + 1, e - 1); i = e; continue; }
      if (s[i] === '(') { const e = matchGroup(s, i); name = s.slice(i + 1, e - 1).trim(); i = e; continue; }
      const m = /^at\s*/.exec(s.slice(i));
      if (m) {
        i += m[0].length;
        const e = matchGroup(s, i);
        at = this.coordinate(s.slice(i + 1, e - 1), st, true);
        i = e;
        continue;
      }
      break;
    }
    let text = '';
    if (!isCoord && s[i] === '{') {
      const e = matchGroup(s, i);
      text = s.slice(i + 1, e - 1);
      i = e;
    }
    const allOpts = this.expand([this.styles['every node'] || ''].concat(st.every.node, st.nodeOpts || []).join(',') + ',' + opts);
    const n = {
      k: -1, shape: isCoord ? 'coord' : 'rect', anchor: 'center', dx: 0, dy: 0, is: 0.3333 * 10 * CM_PER_PT, mw: 0, mh: 0, lw: st.lw,
      draw: null, fill: null, col: st.text || st.col || null, scale: st.font, dash: null, os: 0, tw: 0, align: null,
    };
    let pos = null;
    const labels = [];
    for (const o of allOpts) {
      const [k, v] = keyVal(o);
      const dist = (x) => { try { const r = evaluate(x); return r.unit ? r.v : r.v; } catch (e) { return 0; } };
      if (k === 'draw') n.draw = v ? this.color(v) : 'currentColor';
      else if (k === 'fill') n.fill = v ? this.color(v) : 'currentColor';
      else if (k === 'circle' || k === 'shape' && v === 'circle') n.shape = 'circle';
      else if (k === 'ellipse' || k === 'shape' && v === 'ellipse') n.shape = 'ellipse';
      else if (k === 'rectangle' || k === 'shape' && v === 'rectangle') n.shape = 'rect';
      else if (k === 'coordinate' || k === 'shape' && v === 'coordinate') n.shape = 'coord';
      else if (k === 'diamond' || k === 'shape' && v === 'diamond') n.shape = 'diamond';
      else if (k === 'regular polygon' || k === 'shape' && v === 'regular polygon') { n.shape = 'poly'; n.sides = n.sides || 5; }
      else if (k === 'regular polygon sides') n.sides = Math.max(3, Math.min(12, parseInt(v, 10) || 5));
      else if (k === 'inner sep') n.is = dist(v);
      else if (k === 'outer sep') n.os = dist(v);
      else if (k === 'minimum size') n.mw = n.mh = dist(v);
      else if (k === 'minimum width') n.mw = dist(v);
      else if (k === 'minimum height') n.mh = dist(v);
      else if (k === 'text width') n.tw = dist(v);
      else if (k === 'align') n.align = v;
      else if (k === 'anchor') n.anchor = v;
      else if (k === 'text' || k === 'color' || k === 'text color') n.col = this.color(v);
      else if (k === 'font') n.scale = fontScale(v);
      else if (k === 'overlay') n.ov = 1;
      else if (k === 'scale') { /* node scale ignored */ }
      else if (k === 'rounded corners') n.rc = v ? toEm(v, 'pt') || 0.4 : 0.4;
      else if (k === 'line width') n.lw = (toEm(v, 'pt') || 0.04) * 10;
      else if (LINE_WIDTHS[k] !== undefined) n.lw = LINE_WIDTHS[k];
      else if (DASHES[k]) n.dash = DASHES[k];
      else if (POS[k] !== undefined) pos = POS[k];
      else if (k === 'pos') pos = parseFloat(v);
      else if (k === 'sloped' || k === 'auto' || k === 'swap') { /* not supported */ }
      else if (k === 'xshift') n.dx += dist(v.match(/[a-z]{2}\s*$/) ? v : v + 'pt');
      else if (k === 'yshift') n.dy += dist(v.match(/[a-z]{2}\s*$/) ? v : v + 'pt');
      else if (/^(above|below|left|right)( (left|right))?$/.test(k)) {
        n.anchor = OPPOSITE[k];
        if (v) {
          const of = /^(.*?)\s*of\s+(.+)$/.exec(v);
          if (of || /^of\s/.test(v)) {
            const target = (of ? of[2] : v.slice(3)).trim();
            const d = of && of[1] ? dist(of[1]) : 1;
            const base = this.names[target] !== undefined ? this.center(this.names[target]) : this.coords[target];
            if (base) {
              const ang = COMPASS[k] * DEG;
              const ref = this.names[target] !== undefined ? this.nodes[this.names[target]] : null;
              const est = ref && ref.est ? ref.est : [0, 0];
              // centre-to-centre: the target's half size, the gap, and our own half size (estimated)
              at = [base[0] + Math.cos(ang) * (est[0] + d + 0.25), base[1] + Math.sin(ang) * (est[1] + d + 0.2)];
              n.anchor = 'center';
            }
          } else {
            const d = dist(v);
            const ang = COMPASS[k] * DEG;
            n.dx += Math.cos(ang) * d;
            n.dy += Math.sin(ang) * d;
          }
        }
      } else if (/^(above|below|left|right) of$/.test(k)) {
        const target = (v || '').trim();
        const base = this.names[target] !== undefined ? this.center(this.names[target]) : this.coords[target];
        if (base) { const ang = COMPASS[k.slice(0, -3)] * DEG; at = [base[0] + Math.cos(ang) * 1, base[1] + Math.sin(ang) * 1]; }
      } else if (k === 'label' || k === 'pin') labels.push(v || '');
      else if (this.isColor(k)) n.col = this.color(k);
      else if (k === 'name') name = v;
    }
    // a size command around the whole text: {\tiny{$0$}} or {\small label}
    const sz = /^\s*\\(tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)(?![A-Za-z])\s*/.exec(text);
    if (sz) {
      let rest = text.slice(sz[0].length);
      if (rest[0] === '{' && matchGroup(rest, 0) === rest.trimEnd().length) rest = rest.trimEnd().slice(1, -1);
      text = rest;
      n.scale = round((n.scale || 1) * FONT_SCALE[sz[1]]);
    }
    if (n.shape !== 'coord' && text.trim()) {
      n.k = this.labels.length;
      this.labels.push(this.cb.text(text));
      if (/\\\\/.test(text) || n.tw) n.multi = 1;
    } else if (n.shape !== 'coord') {
      n.empty = 1;
    }
    // a rough size estimate (cm), for layout decisions made before the page measures
    const plain = text.replace(/\\[A-Za-z]+|[{}$^_]/g, '');
    n.est = [Math.max(n.mw / 2, plain.length * 0.09 * (n.scale || 1) + n.is), Math.max(n.mh / 2, (text.trim() ? 0.2 * (n.scale || 1) : 0) + n.is)];
    // \includegraphics[width=4.85cm]{…}: its width is known
    const gw = /\\includegraphics\s*\[[^\]]*\bwidth\s*=\s*([\d.]+\s*(?:cm|mm|in|pt|bp|em))/.exec(text);
    if (gw) { try { const r = evaluate(gw[1]); n.est = [r.v / 2 + n.is, r.v / 2 + n.is]; } catch (e) { /* keep the guess */ } }
    if (st.clip !== undefined) n.clip = st.clip;
    const k = this.nodes.length;
    this.nodes.push(n);
    if (at) n.at = at;
    else if (ctx.pending) ctx.attach(k, pos === null ? 0.5 : pos);
    else if (pos === null || !ctx.prev(k, pos)) {
      const c = ctx.cur();
      n.at = c ? this.toXY(c) : [0, 0];
    }
    if (name) {
      this.names[name] = k;
      n.name = name;
      if (n.shape === 'coord' && n.at) this.coords[name] = n.at;
    }
    for (const l of labels) this.labelNode(l, k, st);
    return i;
  };

  /** label=[opts]angle:text */
  TikzParser.prototype.labelNode = function (spec, parent, st) {
    spec = unbrace(spec);
    let opts = '';
    if (spec[0] === '[') { const e = matchGroup(spec, 0); opts = spec.slice(1, e - 1); spec = spec.slice(e); }
    let dir = 90;
    const parts = splitTop(spec, ':');
    let text = spec;
    if (parts.length > 1) {
      const d = parts[0].trim();
      if (COMPASS[d] !== undefined) { dir = COMPASS[d]; text = parts.slice(1).join(':'); }
      else if (/^-?[\d.]+$/.test(d)) { dir = parseFloat(d); text = parts.slice(1).join(':'); }
    }
    const n = { k: this.labels.length, shape: 'rect', anchor: 'center', dx: 0, dy: 0, is: 0.3333 * 10 * CM_PER_PT, mw: 0, mh: 0, lw: st.lw, col: st.text || null, scale: st.font, of: parent, dir };
    for (const o of this.expand([this.styles['every label'] || ''].concat(st.every.label, opts ? [opts] : []).join(','))) {
      const [k, v] = keyVal(o);
      if (this.isColor(k)) n.col = this.color(k);
      else if (k === 'text' || k === 'color') n.col = this.color(v);
      else if (k === 'font') n.scale = fontScale(v);
      else if (k === 'draw') n.draw = v ? this.color(v) : 'currentColor';
      else if (k === 'fill') n.fill = v ? this.color(v) : 'currentColor';
      else if (k === 'inner sep') { try { n.is = evaluate(v).v; } catch (e) { /* default */ } }
    }
    this.labels.push(this.cb.text(unbrace(text)));
    this.nodes.push(n);
  };

  /** The model's bounding box in cm (estimated: node sizes are guesses). */
  TikzParser.prototype.bbox = function () {
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    const grow = (p, r) => {
      if (!p) return;
      x0 = Math.min(x0, p[0] - (r ? r[0] : 0)); x1 = Math.max(x1, p[0] + (r ? r[0] : 0));
      y0 = Math.min(y0, p[1] - (r ? r[1] : 0)); y1 = Math.max(y1, p[1] + (r ? r[1] : 0));
    };
    const clipBox = (k) => {
      if (k === undefined || k === null || !this.clips[k]) return null;
      const c = this.clips[k];
      if (!c.box) {
        const b = [Infinity, Infinity, -Infinity, -Infinity];
        for (const g of c.segs) for (const q of g.slice(1)) {
          const p = this.toXY(q);
          b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]);
        }
        const o = clipBox(c.parent);
        c.box = o ? [Math.max(b[0], o[0]), Math.max(b[1], o[1]), Math.min(b[2], o[2]), Math.min(b[3], o[3])] : b;
      }
      return c.box;
    };
    for (const p of this.paths) {
      const cb = clipBox(p.clip);
      for (const g of p.segs) for (const q of g.slice(1)) {
        const xy = this.toXY(q);
        if (cb) { if (cb[0] > cb[2] || cb[1] > cb[3]) continue; grow([Math.min(Math.max(xy[0], cb[0]), cb[2]), Math.min(Math.max(xy[1], cb[1]), cb[3])]); }
        else grow(xy);
      }
    }
    for (const n of this.nodes) if (n.at && !n.ov) grow(n.at, n.est);
    if (x0 === Infinity) return [0, 0, 0, 0];
    return [x0, y0, x1, y1].map(round);
  };

  function roundDeep(v) {
    if (typeof v === 'number') return round(v);
    if (Array.isArray(v)) return v.map(roundDeep);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k in v) if (v[k] !== null && v[k] !== undefined && k !== 'est' && k !== 'on' || (k === 'on' && v[k])) o[k] = roundDeep(v[k]);
      return o;
    }
    return v;
  }

  function tikzpicture(body, cb) {
    const src = String(body);
    const fallback = (why) =>
      `<div class="tg-diagram tikz-fallback"><div class="graphic-placeholder">TikZ picture: ${esc(why)}</div>` +
      `<details><summary>Source</summary><pre>${esc(src.trim())}</pre></details></div>`;
    if (/\\begin\s*\{(axis|semilogyaxis|semilogxaxis|loglogaxis|polaraxis|groupplot)\}|\\addplot\b/.test(src)) return fallback('pgfplots plots are not rendered here');
    const p = new TikzParser(cb);
    const st = baseState();
    let baseline = null;
    let s = src;
    if (cb.styles) { try { p.expand(cb.styles); } catch (e) { /* ignore */ } }
    const i = skipWs(s, 0);
    if (s[i] === '[') {
      const e = matchGroup(s, i);
      const opts = s.slice(i + 1, e - 1);
      p.pathOptions(st, opts);
      // baseline=<dimension>: the height (in picture coordinates) that sits on
      // the text baseline when the picture is set inline, as in \tikz[baseline=-3]{…}.
      const bl = /(?:^|,)\s*baseline\s*=\s*([^,]+)/.exec(opts);
      const blEm = bl && /^\s*[+-]?[\d.]+\s*([a-z]{2})?\s*$/.test(bl[1]) ? toEm(bl[1], 'pt') : null;
      if (blEm !== null) baseline = blEm / 2.8453;
      st.every.node = st.every.node.concat(st.nodeOpts);
      for (const o of st.nodeOpts) { const [k] = keyVal(o); if (k === 'domain' || k === 'samples' || k === 'smooth') (st.plotOpts || (st.plotOpts = [])).push(o); }
      s = s.slice(e);
    }
    if (UNSUPPORTED.test(s)) p.partial = true;
    try {
      p.run(s, st);
    } catch (e) {
      p.partial = true;
    }
    if (!p.paths.length && !p.nodes.length) return fallback('this picture uses TikZ features that are not supported yet');
    const bb = p.bbox();
    const model = { paths: p.paths, nodes: p.nodes.map((n) => { const c = Object.assign({}, n); return c; }), bbox: bb };
    if (p.clips.length) model.clips = p.clips.map((c) => ({ segs: c.segs, parent: c.parent }));
    if (baseline !== null) model.baseline = baseline;
    const json = JSON.stringify(roundDeep(model));
    const S = 2.8453; // em per cm
    const w = round((bb[2] - bb[0]) * S + 1);
    const h = round((bb[3] - bb[1]) * S + 1);
    const labels = p.labels.map((html, k) => `<span class="tikz-node" data-k="${k}">${html}</span>`).join('');
    const note = p.partial ? '<span class="tikz-note">Some parts of this picture use TikZ features that are not drawn here.</span>' : '';
    return `<span class="tg-diagram tg-tikz"><span class="tikz-wrap" data-tikz="${esc(json)}" style="width:${w}em;height:${h}em">${labels}</span>${note}</span>`;
  }

  return {
    tikzcd: (body, math) => cdHtml(parseTikzcd(body, math)),
    taylorDiagram,
    taylorMathArrows,
    xymatrix(src, math) {
      const r = parseXymatrix(src, math);
      return r ? { html: cdHtml(r.model), end: r.end } : null;
    },
    tikzpicture,
    _: { evaluate, expandList, matchGroup, skipWs, splitTop, keyVal, unbrace, toEm, color, isColor, arrowSpec, applyArrowStyle, esc, round, POS },
  };
});
