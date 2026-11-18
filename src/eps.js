/*
 * EPS figures as SVG.
 *
 * Browsers cannot show PostScript, and older papers on arXiv often have only
 * .eps figures, mostly line drawings from xfig (fig2dev), gnuplot or similar.
 * This is a small PostScript interpreter that runs such a file and writes the
 * paths and text it draws as an SVG image. It covers the operators these
 * programs use (procedures, dictionaries, arithmetic, control flow, paths,
 * transforms, colours, dashes, clipping and simple text); bitmap images and
 * anything it does not know are left out.
 *
 * TeXglassEps.toSvg(text) returns { svg, partial } or null when nothing could be drawn.
 * Works in browsers and in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeXglassEps = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // --- objects ----------------------------------------------------------------
  // numbers and booleans are JS values; others are tagged objects.
  const name = (v, lit) => ({ t: 'name', v, lit: !!lit });
  const str = (v) => ({ t: 'str', v });
  const MARK = { t: 'mark' };
  const NULL = { t: 'null' };
  const dict = () => ({ t: 'dict', m: new Map() });

  class Stop extends Error {}
  class Exit extends Error {}
  class Quit extends Error {}

  // --- scanner ----------------------------------------------------------------

  /** The tokens of a PostScript program, with { } procedures already grouped. */
  function scan(src) {
    let i = 0;
    const n = src.length;
    const DELIM = /[\s()<>[\]{}/%]/;
    function token() {
      for (;;) {
        while (i < n && /\s/.test(src[i])) i++;
        if (i >= n) return undefined;
        if (src[i] === '%') { while (i < n && src[i] !== '\n' && src[i] !== '\r') i++; continue; }
        break;
      }
      const c = src[i];
      if (c === '(') {
        let depth = 1;
        let out = '';
        i++;
        while (i < n && depth) {
          const ch = src[i++];
          if (ch === '\\') {
            const e = src[i++];
            const esc = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\\': '\\', '(': '(', ')': ')' }[e];
            if (esc !== undefined) out += esc;
            else if (/[0-7]/.test(e)) {
              let o = e;
              while (o.length < 3 && /[0-7]/.test(src[i])) o += src[i++];
              out += String.fromCharCode(parseInt(o, 8));
            } else if (e === '\n') { /* line continuation */ } else if (e === '\r') { if (src[i] === '\n') i++; } else out += e;
          } else if (ch === '(') { depth++; out += ch; } else if (ch === ')') { if (--depth) out += ch; } else out += ch;
        }
        return str(out);
      }
      if (c === '<' && src[i + 1] === '<') { i += 2; return name('<<'); }
      if (c === '>' && src[i + 1] === '>') { i += 2; return name('>>'); }
      if (c === '<') {
        const e = src.indexOf('>', i);
        const hex = src.slice(i + 1, e < 0 ? n : e).replace(/[^0-9a-fA-F]/g, '');
        i = e < 0 ? n : e + 1;
        let out = '';
        for (let k = 0; k < hex.length; k += 2) out += String.fromCharCode(parseInt((hex[k] + (hex[k + 1] || '0')), 16));
        return str(out);
      }
      if (c === '{' || c === '}' || c === '[' || c === ']') { i++; return c === '[' || c === ']' ? name(c) : { t: 'brace', v: c }; }
      let j = i + 1;
      if (c === '/') { if (src[j] === '/') j++; while (j < n && !DELIM.test(src[j])) j++; const v = src.slice(i, j).replace(/^\/+/, ''); i = j; return name(v, true); }
      while (j < n && !DELIM.test(src[j])) j++;
      const w = src.slice(i, j);
      i = j;
      if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(w)) return parseFloat(w);
      const radix = /^(\d+)#([0-9a-zA-Z]+)$/.exec(w);
      if (radix) return parseInt(radix[2], parseInt(radix[1], 10));
      return name(w);
    }
    function group() {
      const out = [];
      for (;;) {
        const t = token();
        if (t === undefined) return out;
        if (t.t === 'brace') {
          if (t.v === '}') return out;
          out.push({ t: 'proc', v: group() });
        } else out.push(t);
      }
    }
    // procedures need the whole program; the top level runs token by token
    return { next() {
      const t = token();
      if (t && t.t === 'brace') return t.v === '{' ? { t: 'proc', v: group() } : null;
      return t;
    } };
  }

  // --- matrices -----------------------------------------------------------------

  const mul = (a, b) => [ // a then b
    a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
  ];
  const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const dapply = (m, x, y) => [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
  function invert(m) {
    const d = m[0] * m[3] - m[1] * m[2];
    if (!d) return [1, 0, 0, 1, 0, 0];
    return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
  }
  const f2 = (x) => String(Math.round(x * 100) / 100);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Symbol font letters as Unicode
  const SYMBOL = {
    a: 'α', b: 'β', c: 'χ', d: 'δ', e: 'ε', f: 'φ', g: 'γ', h: 'η', i: 'ι', j: 'ϕ', k: 'κ', l: 'λ', m: 'μ', n: 'ν', o: 'ο', p: 'π',
    q: 'θ', r: 'ρ', s: 'σ', t: 'τ', u: 'υ', v: 'ϖ', w: 'ω', x: 'ξ', y: 'ψ', z: 'ζ', A: 'Α', B: 'Β', C: 'Χ', D: 'Δ', E: 'Ε', F: 'Φ',
    G: 'Γ', H: 'Η', I: 'Ι', K: 'Κ', L: 'Λ', M: 'Μ', N: 'Ν', O: 'Ο', P: 'Π', Q: 'Θ', R: 'Ρ', S: 'Σ', T: 'Τ', U: 'Υ', W: 'Ω',
    X: 'Ξ', Y: 'Ψ', Z: 'Ζ', '\xa5': '∞', '\xb6': '∂', '\xd1': '∇', '\xb1': '±', '\xb4': '×', '\xae': '→', '\xac': '←',
    '\xa3': '≤', '\xb3': '≥', '\xb9': '≠', '\xbb': '≈', '\xce': '∈', '\xf2': '∫', '\xe5': '∑', '\xd5': '∏', '\xd6': '√',
  };
  // Latin-1 characters PostScript names differently from Unicode in StandardEncoding
  const STD = { '\x27': '’', '\x60': '‘' };

  // --- the interpreter ------------------------------------------------------------

  function run(src) {
    const os = [];
    const gstack = [];
    const out = []; // SVG elements
    const defs = [];
    let partial = false;
    let budget = 3e6;
    let clipId = 0;
    let gs = {
      ctm: [1, 0, 0, 1, 0, 0], path: [], cp: null, start: null, color: [0, 0, 0], lw: 1, cap: 0, join: 0,
      dash: null, dashOff: 0, font: null, clip: null,
    };
    const cloneGs = (g) => Object.assign({}, g, { ctm: g.ctm.slice(), path: g.path.slice(), color: g.color.slice() });

    const systemdict = dict();
    const userdict = dict();
    const ds = [systemdict, userdict];
    const pop = () => { if (!os.length) throw new Error('stackunderflow'); return os.pop(); };
    const num = () => { const v = pop(); if (typeof v !== 'number') throw new Error('typecheck'); return v; };
    const key = (k) => (k && typeof k === 'object' && (k.t === 'name' || k.t === 'str') ? '/' + k.v : typeof k === 'number' ? '#' + k : String(k));
    const lookup = (k) => { const kk = key(k); for (let d = ds.length - 1; d >= 0; d--) if (ds[d].m.has(kk)) return ds[d].m.get(kk); return undefined; };
    const whereIs = (k) => { const kk = key(k); for (let d = ds.length - 1; d >= 0; d--) if (ds[d].m.has(kk)) return ds[d]; return null; };

    // paths are kept in device space
    const moveTo = (x, y) => { const p = apply(gs.ctm, x, y); gs.path.push(['M', p]); gs.cp = p; gs.start = p; };
    const lineTo = (x, y) => { if (!gs.cp) throw new Error('nocurrentpoint'); const p = apply(gs.ctm, x, y); gs.path.push(['L', p]); gs.cp = p; };
    const curveTo = (x1, y1, x2, y2, x3, y3) => {
      if (!gs.cp) throw new Error('nocurrentpoint');
      const a = apply(gs.ctm, x1, y1); const b = apply(gs.ctm, x2, y2); const c = apply(gs.ctm, x3, y3);
      gs.path.push(['C', a, b, c]); gs.cp = c;
    };
    const userCp = () => { if (!gs.cp) throw new Error('nocurrentpoint'); return apply(invert(gs.ctm), gs.cp[0], gs.cp[1]); };
    function arc(x, y, r, a1, a2, neg) {
      if (neg) { while (a2 > a1) a2 -= 360; } else { while (a2 < a1) a2 += 360; }
      const D = Math.PI / 180;
      const p0 = [x + r * Math.cos(a1 * D), y + r * Math.sin(a1 * D)];
      if (gs.cp) lineTo(p0[0], p0[1]); else moveTo(p0[0], p0[1]);
      const segs = Math.max(1, Math.ceil(Math.abs(a2 - a1) / 90));
      const step = (a2 - a1) / segs;
      const k = (4 / 3) * Math.tan((step * D) / 4);
      for (let s = 0; s < segs; s++) {
        const t0 = (a1 + s * step) * D; const t1 = (a1 + (s + 1) * step) * D;
        curveTo(
          x + r * (Math.cos(t0) - k * Math.sin(t0)), y + r * (Math.sin(t0) + k * Math.cos(t0)),
          x + r * (Math.cos(t1) + k * Math.sin(t1)), y + r * (Math.sin(t1) - k * Math.cos(t1)),
          x + r * Math.cos(t1), y + r * Math.sin(t1));
      }
    }
    const pathD = (path) => path.map((g) => (g[0] === 'Z' ? 'Z' : g[0] + g.slice(1).map((p) => `${f2(p[0])},${f2(-p[1])}`).join(' '))).join('');
    const rgb = (c) => `rgb(${c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)).join(',')})`;
    const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
    const clipAttr = () => (gs.clip ? ` clip-path="url(#${gs.clip})"` : '');
    function paint(kind) {
      if (gs.path.length) {
        const d = pathD(gs.path);
        if (kind === 'stroke') {
          const s = scaleOf(gs.ctm);
          const w = Math.max(gs.lw * s, 0.3);
          let style = `fill:none;stroke:${rgb(gs.color)};stroke-width:${f2(w)}`;
          style += `;stroke-linecap:${['butt', 'round', 'square'][gs.cap] || 'butt'};stroke-linejoin:${['miter', 'round', 'bevel'][gs.join] || 'miter'}`;
          if (gs.dash && gs.dash.length) style += `;stroke-dasharray:${gs.dash.map((x) => f2(Math.max(x * s, 0.01))).join(' ')};stroke-dashoffset:${f2(gs.dashOff * s)}`;
          out.push(`<path d="${d}" style="${style}"${clipAttr()}/>`);
        } else out.push(`<path d="${d}" style="fill:${rgb(gs.color)};fill-rule:${kind === 'eofill' ? 'evenodd' : 'nonzero'};stroke:none"${clipAttr()}/>`);
      }
      gs.path = []; gs.cp = null;
    }
    function clip(rule) {
      const id = `c${++clipId}`;
      defs.push(`<clipPath id="${id}"${gs.clip ? ` clip-path="url(#${gs.clip})"` : ''}><path d="${pathD(gs.path)}" clip-rule="${rule}"/></clipPath>`);
      gs.clip = id;
    }
    function show(s) {
      const f = gs.font;
      if (!f || !gs.cp) throw new Error('nocurrentpoint');
      const fname = f.name || '';
      let text = '';
      for (const ch of s) text += /Symbol/.test(fname) ? (SYMBOL[ch] || ch) : (STD[ch] || ch);
      const family = /Courier/.test(fname) ? 'monospace' : /Helvetica|Arial|Sans/.test(fname) ? 'sans-serif' : 'serif';
      const weight = /Bold/.test(fname) ? ';font-weight:bold' : '';
      const italic = /Italic|Oblique/.test(fname) ? ';font-style:italic' : '';
      // glyph space -> device: font matrix, then the CTM from the current point
      const m = mul(mul([1, 0, 0, -1, 0, 0], f.matrix), [gs.ctm[0], gs.ctm[1], gs.ctm[2], gs.ctm[3], gs.cp[0], gs.cp[1]]);
      const svgM = [m[0], -m[1], m[2], -m[3], m[4], -m[5]];
      out.push(`<text transform="matrix(${svgM.map(f2).join(' ')})" style="font-family:${family};font-size:1px${weight}${italic};fill:${rgb(gs.color)}"${clipAttr()}>${esc(text)}</text>`);
      // advance by an estimate of the width
      const w = textWidth(s, f);
      const d = dapply(f.matrix, w, 0);
      const dd = dapply(gs.ctm, d[0], d[1]);
      gs.cp = [gs.cp[0] + dd[0], gs.cp[1] + dd[1]];
    }
    // average advance widths (in em) of Times; good enough to centre or right-align labels
    const textWidth = (s, f) => {
      let w = 0;
      const mono = /Courier/.test(f.name || '');
      for (const ch of s) w += mono ? 0.6 : /[il.,:;'!|]/.test(ch) ? 0.28 : /[mwMW]/.test(ch) ? 0.85 : /[A-Z]/.test(ch) ? 0.68 : /[ \-]/.test(ch) ? 0.3 : 0.5;
      return w;
    };

    // --- operators
    const ops = {};
    const def = (n, f) => { ops[n] = f; systemdict.m.set('/' + n, { t: 'op', v: n, f }); };
    const execObj = (o) => {
      if (--budget < 0) throw new Quit('budget');
      if (o && o.t === 'proc') { for (const x of o.v) execToken(x); return; }
      if (o && o.t === 'op') { o.f(); return; }
      if (o && o.t === 'name' && !o.lit) { execToken(o); return; }
      os.push(o);
    };
    function execToken(tok) {
      if (--budget < 0) throw new Quit('budget');
      if (tok && tok.t === 'name' && !tok.lit) {
        const v = lookup(tok);
        if (v === undefined) {
          if (tok.v === '[' || tok.v === '<<') { os.push(MARK); return; }
          throw new Error('undefined ' + tok.v);
        }
        if (v && v.t === 'proc') { for (const x of v.v) execToken(x); return; }
        if (v && v.t === 'op') { v.f(); return; }
        os.push(v);
        return;
      }
      os.push(tok);
    }

    // stack
    def('pop', () => pop());
    def('exch', () => { const b = pop(); const a = pop(); os.push(b, a); });
    def('dup', () => { const a = pop(); os.push(a, a); });
    def('copy', () => {
      const n = pop();
      if (typeof n === 'number') { if (n > os.length) throw new Error('stackunderflow'); os.push(...os.slice(os.length - n)); return; }
      const a = pop();
      if (Array.isArray(a) && n.t === 'arr') { a.forEach((v, k) => { n.v[k] = v; }); os.push(n); } else os.push(n);
    });
    def('index', () => { const n = num(); os.push(os[os.length - 1 - n]); });
    def('roll', () => {
      const j = num(); const n = num();
      if (n > os.length) throw new Error('stackunderflow');
      if (!n) return;
      const part = os.splice(os.length - n, n);
      const s = ((j % n) + n) % n;
      os.push(...part.slice(n - s), ...part.slice(0, n - s));
    });
    def('clear', () => { os.length = 0; });
    def('count', () => os.push(os.length));
    def('mark', () => os.push(MARK));
    const toMark = () => { for (let k = os.length - 1; k >= 0; k--) if (os[k] === MARK) return k; throw new Error('unmatchedmark'); };
    def('cleartomark', () => { os.length = toMark(); });
    def('counttomark', () => os.push(os.length - 1 - toMark()));
    def('[', () => os.push(MARK));
    def(']', () => { const k = toMark(); const a = os.splice(k); a.shift(); os.push({ t: 'arr', v: a }); });
    def('<<', () => os.push(MARK));
    def('>>', () => { const k = toMark(); const a = os.splice(k); a.shift(); const d = dict(); for (let q = 0; q + 1 < a.length; q += 2) d.m.set(key(a[q]), a[q + 1]); os.push(d); });

    // arithmetic
    const bin = (f) => () => { const b = num(); const a = num(); os.push(f(a, b)); };
    def('add', bin((a, b) => a + b));
    def('sub', bin((a, b) => a - b));
    def('mul', bin((a, b) => a * b));
    def('div', bin((a, b) => a / b));
    def('idiv', bin((a, b) => Math.trunc(a / b)));
    def('mod', bin((a, b) => a % b));
    def('exp', bin((a, b) => Math.pow(a, b)));
    def('atan', bin((a, b) => { let r = Math.atan2(a, b) * 180 / Math.PI; if (r < 0) r += 360; return r; }));
    const un = (f) => () => os.push(f(num()));
    def('neg', un((a) => -a)); def('abs', un(Math.abs)); def('sqrt', un(Math.sqrt));
    def('sin', un((a) => Math.sin(a * Math.PI / 180))); def('cos', un((a) => Math.cos(a * Math.PI / 180)));
    def('ln', un(Math.log)); def('log', un(Math.log10));
    def('round', un(Math.round)); def('truncate', un(Math.trunc)); def('floor', un(Math.floor)); def('ceiling', un(Math.ceil));
    def('cvi', () => { const a = pop(); os.push(Math.trunc(typeof a === 'number' ? a : parseFloat(a.v) || 0)); });
    def('cvr', () => { const a = pop(); os.push(typeof a === 'number' ? a : parseFloat(a.v) || 0); });
    let seed = 1;
    def('rand', () => { seed = (seed * 16807) % 2147483647; os.push(seed); });
    def('srand', () => { seed = num() || 1; });
    def('rrand', () => os.push(seed));

    // comparison and logic
    const same = (a, b) => (a && b && typeof a === 'object' && typeof b === 'object' && (a.t === 'name' || a.t === 'str') && (b.t === 'name' || b.t === 'str') ? a.v === b.v : a === b);
    def('eq', () => { const b = pop(); const a = pop(); os.push(same(a, b)); });
    def('ne', () => { const b = pop(); const a = pop(); os.push(!same(a, b)); });
    const cmp = (f) => () => { const b = pop(); const a = pop(); os.push(f(typeof a === 'object' ? a.v : a, typeof b === 'object' ? b.v : b)); };
    def('gt', cmp((a, b) => a > b)); def('lt', cmp((a, b) => a < b)); def('ge', cmp((a, b) => a >= b)); def('le', cmp((a, b) => a <= b));
    const logic = (fb, fn) => () => { const b = pop(); const a = pop(); os.push(typeof a === 'boolean' ? fb(a, b) : fn(a, b)); };
    def('and', logic((a, b) => a && b, (a, b) => a & b));
    def('or', logic((a, b) => a || b, (a, b) => a | b));
    def('xor', logic((a, b) => a !== b, (a, b) => a ^ b));
    def('not', () => { const a = pop(); os.push(typeof a === 'boolean' ? !a : ~a); });
    def('bitshift', () => { const s = num(); const a = num(); os.push(s >= 0 ? a << s : a >> -s); });
    systemdict.m.set('/true', true);
    systemdict.m.set('/false', false);
    systemdict.m.set('/null', NULL);

    // control
    def('exec', () => execObj(pop()));
    def('if', () => { const p = pop(); const c = pop(); if (c === true) execObj(p); });
    def('ifelse', () => { const b = pop(); const a = pop(); const c = pop(); execObj(c === true ? a : b); });
    const loop = (body) => { try { body(); } catch (e) { if (!(e instanceof Exit)) throw e; } };
    def('for', () => {
      const p = pop(); const lim = num(); const inc = num(); const init = num();
      loop(() => { for (let v = init; inc > 0 ? v <= lim + 1e-9 : v >= lim - 1e-9; v += inc) { os.push(v); execObj(p); if (!inc) break; } });
    });
    def('repeat', () => { const p = pop(); const n = num(); loop(() => { for (let k = 0; k < n; k++) execObj(p); }); });
    def('loop', () => { const p = pop(); loop(() => { for (;;) execObj(p); }); });
    def('exit', () => { throw new Exit(); });
    def('stop', () => { throw new Stop(); });
    def('stopped', () => {
      const p = pop();
      const depth = os.length;
      try { execObj(p); os.push(false); } catch (e) { if (e instanceof Quit) throw e; os.length = Math.min(os.length, depth); os.push(true); }
    });
    def('forall', () => {
      const p = pop(); const a = pop();
      loop(() => {
        if (a && a.t === 'arr') for (const v of a.v.slice()) { os.push(v); execObj(p); }
        else if (a && a.t === 'proc') for (const v of a.v.slice()) { os.push(v); execObj(p); }
        else if (a && a.t === 'str') for (const ch of a.v) { os.push(ch.charCodeAt(0)); execObj(p); }
        else if (a && a.t === 'dict') for (const [k, v] of [...a.m]) { os.push(name(k.replace(/^[/#]/, ''), true), v); execObj(p); }
      });
    });
    def('quit', () => { throw new Quit('quit'); });

    // types and conversion
    def('cvx', () => { const a = pop(); os.push(a && a.t === 'arr' ? { t: 'proc', v: a.v } : a && a.t === 'name' ? name(a.v) : a); });
    def('cvlit', () => { const a = pop(); os.push(a && a.t === 'proc' ? { t: 'arr', v: a.v } : a && a.t === 'name' ? name(a.v, true) : a); });
    def('xcheck', () => { const a = pop(); os.push(!!(a && (a.t === 'proc' || (a.t === 'name' && !a.lit) || a.t === 'op'))); });
    def('cvn', () => { const a = pop(); os.push(name(a.v, true)); });
    def('cvs', () => { const s = pop(); const a = pop(); os.push(str(typeof a === 'number' || typeof a === 'boolean' ? String(a) : a && a.v !== undefined ? String(a.v) : '--nostringval--')); void s; });
    def('type', () => {
      const a = pop();
      const t = typeof a === 'number' ? (Number.isInteger(a) ? 'integertype' : 'realtype') : typeof a === 'boolean' ? 'booleantype'
        : { name: 'nametype', str: 'stringtype', arr: 'arraytype', proc: 'arraytype', dict: 'dicttype', op: 'operatortype', mark: 'marktype', null: 'nulltype', font: 'fonttype' }[a && a.t] || 'nulltype';
      os.push(name(t));
    });
    def('bind', () => {});
    def('readonly', () => {}); def('executeonly', () => {}); def('noaccess', () => {});

    // arrays, strings, dictionaries
    def('array', () => { const n = num(); os.push({ t: 'arr', v: new Array(n).fill(NULL) }); });
    def('string', () => { const n = num(); os.push(str('\0'.repeat(n))); });
    def('length', () => { const a = pop(); os.push(a.t === 'dict' ? a.m.size : a.t === 'name' ? a.v.length : a.v.length); });
    def('get', () => {
      const k = pop(); const a = pop();
      if (a.t === 'dict') { const v = a.m.get(key(k)); if (v === undefined) throw new Error('undefined'); os.push(v); } else if (a.t === 'str') os.push(a.v.charCodeAt(k)); else os.push(a.v[k]);
    });
    def('put', () => {
      const v = pop(); const k = pop(); const a = pop();
      if (a.t === 'dict') a.m.set(key(k), v); else if (a.t === 'str') a.v = a.v.slice(0, k) + String.fromCharCode(v) + a.v.slice(k + 1); else a.v[k] = v;
    });
    def('getinterval', () => { const n = num(); const i = num(); const a = pop(); os.push(a.t === 'str' ? str(a.v.substr(i, n)) : { t: a.t, v: a.v.slice(i, i + n) }); });
    def('putinterval', () => { const b = pop(); const i = num(); const a = pop(); if (a.t === 'str') a.v = a.v.slice(0, i) + b.v + a.v.slice(i + b.v.length); else b.v.forEach((x, k) => { a.v[i + k] = x; }); });
    def('aload', () => { const a = pop(); os.push(...a.v, a); });
    def('astore', () => { const a = pop(); const n = a.v.length; a.v = os.splice(os.length - n, n); os.push(a); });
    def('dict', () => { pop(); os.push(dict()); });
    def('begin', () => { const d = pop(); if (!d || d.t !== 'dict') throw new Error('typecheck'); ds.push(d); });
    def('end', () => { if (ds.length > 2) ds.pop(); });
    def('def', () => { const v = pop(); const k = pop(); ds[ds.length - 1].m.set(key(k), v); });
    def('store', () => { const v = pop(); const k = pop(); (whereIs(k) || ds[ds.length - 1]).m.set(key(k), v); });
    def('load', () => { const k = pop(); const v = lookup(k); if (v === undefined) throw new Error('undefined'); os.push(v); });
    def('where', () => { const k = pop(); const d = whereIs(k); if (d) os.push(d, true); else os.push(false); });
    def('known', () => { const k = pop(); const d = pop(); os.push(d.m.has(key(k))); });
    def('undef', () => { const k = pop(); const d = pop(); d.m.delete(key(k)); });
    def('currentdict', () => os.push(ds[ds.length - 1]));
    def('countdictstack', () => os.push(ds.length));
    def('maxlength', () => { pop(); os.push(1000); });
    systemdict.m.set('/systemdict', systemdict);
    systemdict.m.set('/userdict', userdict);
    for (const n of ['statusdict', 'errordict', 'globaldict', '$error']) systemdict.m.set('/' + n, dict());

    // VM and graphics state
    def('save', () => { gstack.push(cloneGs(gs)); os.push({ t: 'save', depth: gstack.length }); });
    def('restore', () => { const s = pop(); if (s && s.t === 'save') { gstack.length = Math.min(gstack.length, s.depth); if (gstack.length) gs = gstack.pop(); } });
    def('gsave', () => gstack.push(cloneGs(gs)));
    def('grestore', () => { if (gstack.length) gs = gstack.pop(); });
    def('grestoreall', () => { if (gstack.length) { gs = gstack[0]; gstack.length = 0; } });
    def('initgraphics', () => { gs.ctm = [1, 0, 0, 1, 0, 0]; gs.path = []; gs.cp = null; gs.color = [0, 0, 0]; gs.lw = 1; gs.dash = null; gs.clip = null; });
    def('setlinewidth', () => { gs.lw = num(); });
    def('currentlinewidth', () => os.push(gs.lw));
    def('setlinecap', () => { gs.cap = num(); });
    def('setlinejoin', () => { gs.join = num(); });
    def('setdash', () => { gs.dashOff = num(); const a = pop(); gs.dash = a.v.slice(); });
    def('currentdash', () => os.push({ t: 'arr', v: (gs.dash || []).slice() }, gs.dashOff));
    for (const n of ['setmiterlimit', 'setflat', 'setstrokeadjust', 'setoverprint', 'setsmoothness', 'setpagedevice', 'setcolorspace', 'setscreen',
      'settransfer', 'setblackgeneration', 'setundercolorremoval', 'sethalftone', 'setcolorrendering', 'setglobal', 'setpacking', 'setshared']) def(n, () => { pop(); });
    def('setgray', () => { const g = num(); gs.color = [g, g, g]; });
    def('setrgbcolor', () => { const b = num(); const g = num(); const r = num(); gs.color = [r, g, b]; });
    def('setcmykcolor', () => { const k = num(); const y = num(); const m = num(); const c = num(); gs.color = [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)]; });
    def('sethsbcolor', () => {
      const v = num(); const s = num(); const h = num();
      const i = Math.floor(h * 6); const f = h * 6 - i; const p = v * (1 - s); const q = v * (1 - f * s); const t = v * (1 - (1 - f) * s);
      gs.color = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6];
    });
    def('setcolor', () => { const n = os.length && typeof os[os.length - 1] === 'number' ? 1 : 0; if (n) { const g = num(); gs.color = [g, g, g]; } });
    def('currentrgbcolor', () => os.push(...gs.color));
    def('currentgray', () => os.push((gs.color[0] + gs.color[1] + gs.color[2]) / 3));

    // coordinates
    const matArg = () => { const t = os[os.length - 1]; return t && t.t === 'arr' ? pop() : null; };
    def('matrix', () => os.push({ t: 'arr', v: [1, 0, 0, 1, 0, 0] }));
    def('identmatrix', () => { const m = pop(); m.v = [1, 0, 0, 1, 0, 0]; os.push(m); });
    def('currentmatrix', () => { const m = pop(); m.v = gs.ctm.slice(); os.push(m); });
    def('defaultmatrix', () => { const m = pop(); m.v = [1, 0, 0, 1, 0, 0]; os.push(m); });
    def('setmatrix', () => { gs.ctm = pop().v.slice(); });
    def('initmatrix', () => { gs.ctm = [1, 0, 0, 1, 0, 0]; });
    def('concat', () => { gs.ctm = mul(pop().v, gs.ctm); });
    def('concatmatrix', () => { const r = pop(); const b = pop(); const a = pop(); r.v = mul(a.v, b.v); os.push(r); });
    def('invertmatrix', () => { const r = pop(); const a = pop(); r.v = invert(a.v); os.push(r); });
    const tfOp = (mk) => () => {
      const m = matArg();
      const args = [];
      for (let k = 0; k < mk.n; k++) args.unshift(num());
      const t = mk.f(...args);
      if (m) { m.v = mul(t, [1, 0, 0, 1, 0, 0]); os.push(m); } else gs.ctm = mul(t, gs.ctm);
    };
    def('translate', tfOp({ n: 2, f: (x, y) => [1, 0, 0, 1, x, y] }));
    def('scale', tfOp({ n: 2, f: (x, y) => [x, 0, 0, y, 0, 0] }));
    def('rotate', tfOp({ n: 1, f: (a) => { const r = a * Math.PI / 180; return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]; } }));
    const pointOp = (f) => () => { const m = matArg(); const y = num(); const x = num(); os.push(...f(m ? m.v : gs.ctm, x, y)); };
    def('transform', pointOp(apply));
    def('itransform', pointOp((m, x, y) => apply(invert(m), x, y)));
    def('dtransform', pointOp(dapply));
    def('idtransform', pointOp((m, x, y) => dapply(invert(m), x, y)));

    // paths and painting
    def('newpath', () => { gs.path = []; gs.cp = null; });
    def('moveto', () => { const y = num(); const x = num(); moveTo(x, y); });
    def('rmoveto', () => { const y = num(); const x = num(); const c = userCp(); moveTo(c[0] + x, c[1] + y); });
    def('lineto', () => { const y = num(); const x = num(); lineTo(x, y); });
    def('rlineto', () => { const y = num(); const x = num(); const c = userCp(); lineTo(c[0] + x, c[1] + y); });
    def('curveto', () => { const a = [num(), num(), num(), num(), num(), num()].reverse(); curveTo(...a); });
    def('rcurveto', () => { const a = [num(), num(), num(), num(), num(), num()].reverse(); const c = userCp(); curveTo(c[0] + a[0], c[1] + a[1], c[0] + a[2], c[1] + a[3], c[0] + a[4], c[1] + a[5]); });
    def('arc', () => { const a2 = num(); const a1 = num(); const r = num(); const y = num(); const x = num(); arc(x, y, r, a1, a2, false); });
    def('arcn', () => { const a2 = num(); const a1 = num(); const r = num(); const y = num(); const x = num(); arc(x, y, r, a1, a2, true); });
    const arcto = () => {
      const r = num(); const y2 = num(); const x2 = num(); const y1 = num(); const x1 = num();
      const [x0, y0] = userCp();
      const v1 = [x0 - x1, y0 - y1]; const v2 = [x2 - x1, y2 - y1];
      const l1 = Math.hypot(...v1) || 1; const l2 = Math.hypot(...v2) || 1;
      const ang = Math.acos(Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2))));
      const t = r / Math.tan(ang / 2 || 1e-9);
      const p1 = [x1 + v1[0] / l1 * t, y1 + v1[1] / l1 * t]; const p2 = [x1 + v2[0] / l2 * t, y1 + v2[1] / l2 * t];
      lineTo(p1[0], p1[1]);
      const k = (4 / 3) * Math.tan((Math.PI - ang) / 4) * r;
      curveTo(p1[0] - v1[0] / l1 * k, p1[1] - v1[1] / l1 * k, p2[0] - v2[0] / l2 * k, p2[1] - v2[1] / l2 * k, p2[0], p2[1]);
      return [p1, p2];
    };
    def('arcto', () => { const [p1, p2] = arcto(); os.push(p1[0], p1[1], p2[0], p2[1]); });
    def('arct', () => { arcto(); });
    def('closepath', () => { if (gs.cp) { gs.path.push(['Z']); gs.cp = gs.start; } });
    def('currentpoint', () => os.push(...userCp()));
    def('stroke', () => paint('stroke'));
    def('fill', () => paint('fill'));
    def('eofill', () => paint('eofill'));
    def('rectfill', () => { const h = num(); const w = num(); const y = num(); const x = num(); const p = gs.path; gs.path = []; moveTo(x, y); lineTo(x + w, y); lineTo(x + w, y + h); lineTo(x, y + h); gs.path.push(['Z']); paint('fill'); gs.path = p; });
    def('rectstroke', () => { const m = matArg(); void m; const h = num(); const w = num(); const y = num(); const x = num(); const p = gs.path; gs.path = []; moveTo(x, y); lineTo(x + w, y); lineTo(x + w, y + h); lineTo(x, y + h); gs.path.push(['Z']); paint('stroke'); gs.path = p; });
    def('clip', () => clip('nonzero'));
    def('eoclip', () => clip('evenodd'));
    def('rectclip', () => { const h = num(); const w = num(); const y = num(); const x = num(); gs.path = []; moveTo(x, y); lineTo(x + w, y); lineTo(x + w, y + h); lineTo(x, y + h); gs.path.push(['Z']); clip('nonzero'); gs.path = []; gs.cp = null; });
    def('initclip', () => { gs.clip = null; });
    def('clippath', () => {
      // the page, in device space
      gs.path = [['M', [-1e4, -1e4]], ['L', [1e4, -1e4]], ['L', [1e4, 1e4]], ['L', [-1e4, 1e4]], ['Z']];
      gs.cp = [-1e4, -1e4]; gs.start = gs.cp;
    });
    def('pathbbox', () => {
      const pts = [];
      for (const g of gs.path) for (const p of g.slice(1)) pts.push(apply(invert(gs.ctm), p[0], p[1]));
      if (!pts.length) throw new Error('nocurrentpoint');
      os.push(Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])));
    });
    for (const n of ['flattenpath', 'strokepath', 'reversepath']) def(n, () => {});
    def('showpage', () => {});
    def('copypage', () => {});
    def('erasepage', () => {});
    def('image', () => { partial = true; for (let k = 0; k < 5; k++) pop(); });
    def('colorimage', () => { partial = true; const ncomp = num(); const multi = pop(); const procs = multi === true ? ncomp : 1; for (let k = 0; k < procs + 5; k++) pop(); });
    def('imagemask', () => { partial = true; for (let k = 0; k < 5; k++) pop(); });

    // fonts and text
    def('findfont', () => { const n = pop(); os.push({ t: 'font', name: n.v, matrix: [1, 0, 0, 1, 0, 0] }); });
    def('scalefont', () => { const s = num(); const f = pop(); os.push(Object.assign({}, f, { matrix: mul(f.matrix, [s, 0, 0, s, 0, 0]) })); });
    def('makefont', () => { const m = pop(); const f = pop(); os.push(Object.assign({}, f, { matrix: mul(f.matrix, m.v) })); });
    def('selectfont', () => { const s = pop(); const n = pop(); const m = typeof s === 'number' ? [s, 0, 0, s, 0, 0] : s.v; gs.font = { t: 'font', name: n.v, matrix: m }; });
    def('setfont', () => { gs.font = pop(); });
    def('currentfont', () => os.push(gs.font || { t: 'font', name: 'Times-Roman', matrix: [10, 0, 0, 10, 0, 0] }));
    def('definefont', () => { const f = pop(); pop(); os.push(f); });
    def('show', () => show(pop().v));
    def('ashow', () => { const s = pop(); pop(); pop(); show(s.v); });
    def('widthshow', () => { const s = pop(); pop(); pop(); pop(); show(s.v); });
    def('awidthshow', () => { const s = pop(); for (let k = 0; k < 5; k++) pop(); show(s.v); });
    def('xshow', () => { pop(); show(pop().v); });
    def('kshow', () => { const s = pop(); pop(); show(s.v); });
    def('stringwidth', () => {
      const s = pop(); const f = gs.font || { matrix: [10, 0, 0, 10, 0, 0], name: '' };
      const d = dapply(f.matrix, textWidth(s.v, f), 0);
      os.push(d[0], d[1]);
    });
    def('charpath', () => { pop(); pop(); partial = true; });
    for (const n of ['languagelevel']) systemdict.m.set('/' + n, 2);
    systemdict.m.set('/product', str('TeXglass'));
    systemdict.m.set('/version', str('3010'));
    def('vmstatus', () => os.push(0, 0, 1e6));
    def('usertime', () => os.push(0));
    def('realtime', () => os.push(0));
    def('print', () => { pop(); });
    def('=', () => { pop(); });
    def('==', () => { pop(); });
    def('pstack', () => {});
    def('flush', () => {});
    def('echo', () => { pop(); });

    // run the program, skipping a statement that fails as a printer would stop
    const sc = scan(src);
    for (;;) {
      let tok;
      try { tok = sc.next(); } catch (e) { partial = true; break; }
      if (tok === undefined) break;
      if (tok === null) continue;
      try {
        if (tok.t === 'proc') os.push(tok); else execToken(tok);
      } catch (e) {
        if (e instanceof Quit) { if (e.message === 'budget') partial = true; break; }
        partial = true;
      }
    }
    return { out, defs, partial };
  }

  /** The figure as an SVG document, from the PostScript source of an EPS file. */
  function toSvg(text) {
    text = String(text);
    // DOS EPS binary header: the PostScript section is inside
    if (text.charCodeAt(0) === 0xc5 && text.charCodeAt(1) === 0xd0) {
      const at = (k) => text.charCodeAt(k) | (text.charCodeAt(k + 1) << 8) | (text.charCodeAt(k + 2) << 16) | (text.charCodeAt(k + 3) << 24);
      text = text.substr(at(4), at(8));
    }
    const bbM = /%%(?:HiRes)?BoundingBox:\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/.exec(text);
    let r;
    try { r = run(text); } catch (e) { return null; }
    if (!r.out.length) return null;
    const bb = bbM ? bbM.slice(1).map(parseFloat) : [0, 0, 612, 792];
    const w = Math.max(1, bb[2] - bb[0]);
    const h = Math.max(1, bb[3] - bb[1]);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${f2(w)}pt" height="${f2(h)}pt" viewBox="${f2(bb[0])} ${f2(-bb[3])} ${f2(w)} ${f2(h)}">` +
      (r.defs.length ? `<defs>${r.defs.join('')}</defs>` : '') +
      // white paper behind it, as in the PDF, so black lines show in the dark theme too
      `<rect x="${f2(bb[0])}" y="${f2(-bb[3])}" width="${f2(w)}" height="${f2(h)}" fill="#fff"/>` + r.out.join('') + '</svg>';
    return { svg, partial: r.partial };
  }

  return { toSvg, _: { scan, run } };
});
