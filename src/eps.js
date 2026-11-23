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
      if (c === '/') {
        const immediate = src[j] === '/'; // //name: the value the name has, not the name
        if (immediate) j++;
        while (j < n && !DELIM.test(src[j])) j++;
        const v = src.slice(i, j).replace(/^\/+/, '');
        i = j;
        return immediate ? { t: 'name', v, lit: true, imm: true } : name(v, true);
      }
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
    return {
      next() {
        const t = token();
        if (t && t.t === 'brace') return t.v === '{' ? { t: 'proc', v: group() } : null;
        return t;
      },
      // the program as a file (currentfile): data right after the token just read,
      // less the one white-space character that ended that token
      byte() {
        return i >= n ? -1 : src.charCodeAt(i++);
      },
      skipSeparator() {
        if (src[i] === '\r' && src[i + 1] === '\n') i += 2;
        else if (/\s/.test(src[i] || '')) i++;
      },
      peek() {
        return i >= n ? -1 : src.charCodeAt(i);
      },
      readLine() {
        const e = src.slice(i).search(/\r\n?|\n/);
        const line = e < 0 ? src.slice(i) : src.slice(i, i + e);
        i = e < 0 ? n : i + e + (src[i + e] === '\r' && src[i + e + 1] === '\n' ? 2 : 1);
        return line;
      },
    };
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

  // the glyph names of printable ASCII, for StandardEncoding (the rest are .notdef here)
  const ENCODING = (() => {
    const names = ('space exclam quotedbl numbersign dollar percent ampersand quoteright parenleft parenright asterisk plus comma ' +
      'hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at ' +
      'A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore quoteleft ' +
      'a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde').split(' ');
    const out = new Array(256).fill('.notdef');
    names.forEach((n, k) => { out[32 + k] = n; });
    return out;
  })();

  // --- the interpreter ------------------------------------------------------------

  function run(src) {
    const sc = scan(src);
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
      // Subset fonts can use control bytes as glyph IDs. Omit glyphs that
      // cannot be decoded so that the rest of the SVG remains valid XML.
      const visible = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
      if (visible !== text) partial = true;
      const family = /Courier/.test(fname) ? 'monospace' : /Helvetica|Arial|Sans/.test(fname) ? 'sans-serif' : 'serif';
      const weight = /Bold/.test(fname) ? ';font-weight:bold' : '';
      const italic = /Italic|Oblique/.test(fname) ? ';font-style:italic' : '';
      // glyph space -> device: font matrix, then the CTM from the current point
      const m = mul(mul([1, 0, 0, -1, 0, 0], f.matrix), [gs.ctm[0], gs.ctm[1], gs.ctm[2], gs.ctm[3], gs.cp[0], gs.cp[1]]);
      const svgM = [m[0], -m[1], m[2], -m[3], m[4], -m[5]];
      if (visible) out.push(`<text transform="matrix(${svgM.map(f2).join(' ')})" style="font-family:${family};font-size:1px${weight}${italic};fill:${rgb(gs.color)}"${clipAttr()}>${esc(visible)}</text>`);
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
      if (tok && tok.imm) { const v = lookup(tok); if (v === undefined) throw new Error('undefined ' + tok.v); os.push(v); return; }
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
    def('length', () => { const a = pop(); os.push(a.t === 'font' ? 0 : a.t === 'dict' ? a.m.size : a.t === 'name' ? a.v.length : a.v.length); });
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
    systemdict.m.set('/StandardEncoding', { t: 'arr', v: ENCODING.map((n) => name(n, true)) });
    systemdict.m.set('/ISOLatin1Encoding', { t: 'arr', v: ENCODING.map((n) => name(n, true)) });

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
    for (const n of ['setmiterlimit', 'setflat', 'setstrokeadjust', 'setoverprint', 'setsmoothness', 'setpagedevice', 'setscreen',
      'settransfer', 'setblackgeneration', 'setundercolorremoval', 'sethalftone', 'setcolorrendering', 'setglobal', 'setpacking', 'setshared']) def(n, () => { pop(); });
    // state that only matters to a printer: report the defaults
    def('currentglobal', () => os.push(false));
    def('currentpacking', () => os.push(false));
    def('currentshared', () => os.push(false));
    def('currentoverprint', () => os.push(false));
    def('currentstrokeadjust', () => os.push(false));
    def('currentflat', () => os.push(1));
    def('currentmiterlimit', () => os.push(10));
    def('currentlinecap', () => os.push(gs.cap));
    def('currentlinejoin', () => os.push(gs.join));
    def('currentscreen', () => os.push(60, 45, { t: 'proc', v: [name('pop'), name('pop'), 0] }));
    for (const n of ['currenttransfer', 'currentblackgeneration', 'currentundercolorremoval']) def(n, () => os.push({ t: 'proc', v: [] }));
    def('currentcolortransfer', () => { for (let k = 0; k < 4; k++) os.push({ t: 'proc', v: [] }); });
    def('setcolortransfer', () => { for (let k = 0; k < 4; k++) pop(); });
    def('currentcolorscreen', () => { for (let k = 0; k < 4; k++) os.push(60, 45, { t: 'proc', v: [name('pop'), name('pop'), 0] }); });
    def('setcolorscreen', () => { for (let k = 0; k < 12; k++) pop(); });
    def('currenthalftone', () => os.push(dict()));
    def('currentcolorrendering', () => os.push(dict()));
    def('currentpagedevice', () => os.push(dict()));
    def('currentcolorspace', () => os.push({ t: 'arr', v: [name('DeviceRGB', true)] }));
    def('gstate', () => os.push({ t: 'gstate', g: cloneGs(gs) }));
    def('currentgstate', () => { pop(); os.push({ t: 'gstate', g: cloneGs(gs) }); });
    def('setgstate', () => { const g = pop(); if (g && g.t === 'gstate') gs = cloneGs(g.g); });
    def('currentcmykcolor', () => { const [r, g, b] = gs.color; const k = 1 - Math.max(r, g, b); os.push(...(k >= 1 ? [0, 0, 0, 1] : [(1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k])); });
    // resources (Level 2 procsets and categories): kept in a dictionary per category
    const resources = new Map();
    const category = (c) => { const k = key(c); if (!resources.has(k)) resources.set(k, dict()); return resources.get(k); };
    def('findresource', () => { const c = pop(); const k = pop(); const v = category(c).m.get(key(k)); os.push(v === undefined ? (key(c) === '/Font' ? { t: 'font', name: k.v, matrix: [1, 0, 0, 1, 0, 0] } : dict()) : v); });
    def('defineresource', () => { const c = pop(); const v = pop(); const k = pop(); category(c).m.set(key(k), v); os.push(v); });
    def('undefineresource', () => { const c = pop(); const k = pop(); category(c).m.delete(key(k)); });
    def('resourcestatus', () => { const c = pop(); const k = pop(); if (category(c).m.has(key(k))) os.push(0, 0, true); else os.push(false); });
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
    // --- files and filters (image data that follows in the program itself)
    let afterToken = true; // the first read from currentfile skips the separator after the token
    const programFile = {
      t: 'file', program: true,
      byte: () => { if (afterToken) { afterToken = false; sc.skipSeparator(); } return sc.byte(); },
      peek: () => { if (afterToken) { afterToken = false; sc.skipSeparator(); } return sc.peek(); },
    };
    // one byte of look-ahead on a filter, to see its end-of-data marker before it is asked for more
    const peekable = (f) => {
      let next = null;
      const byte = f.byte;
      f.byte = () => { if (next !== null) { const b = next; next = null; return b; } return byte(); };
      f.peek = () => { if (next === null) next = byte(); return next; };
      return f;
    };
    def('currentfile', () => { afterToken = true; os.push(programFile); });
    const readBytes = (f, count) => { let out = ''; for (let k = 0; k < count; k++) { const b = f.byte(); if (b < 0) break; out += String.fromCharCode(b); } return out; };
    const hexFile = (f) => peekable({ t: 'file', ends: true, byte() {
      let hi = -1;
      for (;;) {
        const b = f.byte();
        if (b < 0 || b === 62) return -1; // '>' ends the data
        const v = b >= 48 && b <= 57 ? b - 48 : b >= 65 && b <= 70 ? b - 55 : b >= 97 && b <= 102 ? b - 87 : -1;
        if (v < 0) continue;
        if (hi < 0) hi = v; else return hi * 16 + v;
      }
    } });
    // white space, then perhaps the end-of-data marker: read it now (as printers, which read ahead, do)
    const markerNext = (f, marker) => {
      if (!f.peek) return false;
      while ([9, 10, 12, 13, 32, 0].includes(f.peek())) f.byte();
      if (f.peek() !== marker.charCodeAt(0)) return false;
      for (let k = 0; k < marker.length; k++) f.byte();
      return true;
    };
    const a85File = (f) => {
      let buf = []; let done = false;
      return peekable({ t: 'file', ends: true, byte() {
        while (!buf.length && !done) {
          const group = [];
          while (group.length < 5) {
            const b = f.byte();
            if (b < 0 || b === 126) { if (b === 126) f.byte(); done = true; break; } // '~>' ends the data
            if (b === 122 && !group.length) { buf = [0, 0, 0, 0]; break; }
            if (b >= 33 && b <= 117) group.push(b - 33);
          }
          if (buf.length || !group.length) continue;
          const len = group.length;
          while (group.length < 5) group.push(84);
          let v = 0;
          for (const g of group) v = v * 85 + g;
          buf = [v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255].slice(0, len - 1);
          if (markerNext(f, '~>')) done = true;
        }
        return buf.length ? buf.shift() : -1;
      } });
    };
    const rleFile = (f) => {
      let buf = [];
      let done = false;
      return peekable({ t: 'file', ends: true, byte() {
        while (!buf.length && !done) {
          const len = f.byte();
          if (len < 0 || len === 128) return -1;
          if (len < 128) { for (let k = 0; k <= len; k++) buf.push(f.byte()); } else { const b = f.byte(); for (let k = 0; k < 257 - len; k++) buf.push(b); }
          if (f.peek && f.peek() === 128) { f.byte(); done = true; }
        }
        return buf.length ? buf.shift() : -1;
      } });
    };
    const asFile = (src) => {
      if (src && src.t === 'file') return src;
      if (src && src.t === 'str') { let k = 0; return { t: 'file', byte: () => (k < src.v.length ? src.v.charCodeAt(k++) & 255 : -1) }; }
      if (src && src.t === 'proc') {
        let chunk = ''; let k = 0;
        return { t: 'file', byte() {
          while (k >= chunk.length) { execObj(src); const r = pop(); chunk = r && r.t === 'str' ? r.v : ''; k = 0; if (!chunk.length) return -1; }
          return chunk.charCodeAt(k++) & 255;
        } };
      }
      throw new Error('typecheck');
    };
    def('filter', () => {
      const n = pop().v;
      if (os.length && os[os.length - 1] && os[os.length - 1].t === 'dict' && !/^(ASCIIHex|ASCII85|RunLength)Decode$/.test(n)) pop(); // parameters
      if (n === 'SubFileDecode') { pop(); pop(); }
      const f = asFile(pop());
      if (n === 'ASCIIHexDecode') os.push(hexFile(f));
      else if (n === 'ASCII85Decode') os.push(a85File(f));
      else if (n === 'RunLengthDecode') os.push(rleFile(f));
      else if (n === 'DCTDecode') os.push({ t: 'file', byte: f.byte, dct: f, ends: f.ends, under: f });
      else if (n === 'SubFileDecode' || n === 'NullEncode') os.push(f);
      else throw new Error('unsupported filter ' + n);
    });
    def('readhexstring', () => { const s = pop(); const f = asFile(pop()); const h = hexFile(f); const r = readBytes(h, s.v.length); os.push(str(r), r.length === s.v.length); });
    def('readstring', () => { const s = pop(); const f = asFile(pop()); const r = readBytes(f, s.v.length); os.push(str(r), r.length === s.v.length); });
    def('readline', () => { const s = pop(); pop(); if (afterToken) { afterToken = false; sc.skipSeparator(); } const r = sc.readLine(); os.push(str(r.slice(0, s.v.length)), true); });
    def('read', () => { const f = asFile(pop()); const b = f.byte(); if (b < 0) os.push(false); else os.push(b, true); });
    def('closefile', () => { pop(); });
    def('flushfile', () => { const f = pop(); if (f && f.t === 'file' && !f.program) while (f.byte() >= 0); });

    // --- images
    gs.cs = { n: 1 };
    const colorSpace = (c) => {
      const nm = c && c.t === 'arr' ? c.v[0] && c.v[0].v : c && c.v;
      if (nm === 'DeviceRGB' || nm === 'CalRGB') return { n: 3 };
      if (nm === 'DeviceCMYK') return { n: 4, cmyk: true };
      if (nm === 'Indexed' && c.t === 'arr') {
        const base = colorSpace(c.v[1]);
        const look = c.v[3];
        return { n: 1, indexed: { base, table: look && look.t === 'str' ? look.v : '' } };
      }
      return { n: 1 }; // DeviceGray, CalGray, and anything else drawn as grey
    };
    def('setcolorspace', () => { gs.cs = colorSpace(pop()); });
    const crcTable = [];
    for (let k = 0; k < 256; k++) { let c = k; for (let q = 0; q < 8; q++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[k] = c >>> 0; }
    const be32 = (v) => String.fromCharCode(v >>> 24 & 255, v >>> 16 & 255, v >>> 8 & 255, v & 255);
    const chunk = (type, data) => {
      let c = 0xffffffff;
      const body = type + data;
      for (let k = 0; k < body.length; k++) c = crcTable[(c ^ body.charCodeAt(k)) & 255] ^ (c >>> 8);
      return be32(data.length) + body + be32((c ^ 0xffffffff) >>> 0);
    };
    /** An uncompressed PNG (stored deflate blocks) of RGBA rows, as a binary string. */
    function png(w, h, rgba) {
      const rows = [];
      for (let y = 0; y < h; y++) rows.push('\0' + rgba.slice(y * w * 4, (y + 1) * w * 4));
      const raw = rows.join('');
      let a = 1; let b = 0;
      for (let k = 0; k < raw.length; k++) { a = (a + raw.charCodeAt(k)) % 65521; b = (b + a) % 65521; }
      let z = '\x78\x01';
      for (let k = 0; k < raw.length || k === 0; k += 65535) {
        const part = raw.slice(k, k + 65535);
        const last = k + 65535 >= raw.length ? 1 : 0;
        z += String.fromCharCode(last, part.length & 255, part.length >>> 8, ~part.length & 255, (~part.length >>> 8) & 255) + part;
      }
      z += be32(((b << 16) | a) >>> 0);
      return '\x89PNG\r\n\x1a\n' + chunk('IHDR', be32(w) + be32(h) + '\x08\x06\x00\x00\x00') + chunk('IDAT', z) + chunk('IEND', '');
    }
    const base64 = (bin) => (typeof btoa === 'function' ? btoa(bin) : Buffer.from(bin, 'latin1').toString('base64'));
    function placeImage(w, h, matrix, href) {
      // image space (w × h, first row first) -> user space -> device
      const m = mul(invert(matrix), gs.ctm);
      const svgM = [m[0], -m[1], m[2], -m[3], m[4], -m[5]];
      out.push(`<image width="${w}" height="${h}" preserveAspectRatio="none" transform="matrix(${svgM.map((x) => String(Math.round(x * 1e4) / 1e4)).join(' ')})" href="${href}"${clipAttr()}/>`);
    }
    const MAX_PIXELS = 4e6;
    /** Read and draw an image: { w, h, bits, matrix, files: [file], cs, decode, mask }. */
    function drawImage(o) {
      try { paintImage(o); } finally {
        // data that ends with a marker (~> or >) is read to its end, so the program goes on after it
        for (const f of o.files) { const e = f.under || f; if (e.ends) while (e.byte() >= 0); }
      }
    }
    function paintImage(o) {
      const { w, h, bits } = o;
      if (!(w > 0 && h > 0) || w * h > MAX_PIXELS) { partial = true; return; }
      if (o.files[0].dct) {
        // a JPEG: hand the bytes over as they are, from the start marker to the end marker
        const f = o.files[0].dct;
        let jpg = ''; let prev = -1;
        for (let b = f.byte(); b >= 0; b = f.byte()) { jpg += String.fromCharCode(b); if (prev === 0xff && b === 0xd9) break; prev = b; }
        const at = jpg.indexOf('\xff\xd8');
        if (at < 0) { partial = true; return; }
        placeImage(w, h, o.matrix, 'data:image/jpeg;base64,' + base64(jpg.slice(at)));
        return;
      }
      const ncomp = o.mask ? 1 : o.cs.n;
      const perRow = o.files.length > 1 ? Math.ceil(w * bits / 8) : Math.ceil(w * ncomp * bits / 8);
      // one source per colour (colorimage with multi true) is read a row of each in turn
      const parts = o.files.map(() => []);
      for (let y = 0; y < h; y++) o.files.forEach((f, q) => parts[q].push(readBytes(f, perRow).padEnd(perRow, '\0')));
      const planes = parts.map((p) => p.join(''));
      const max = (1 << bits) - 1;
      const dec = o.decode || null;
      const sample = (plane, row, k) => {
        if (bits === 8) return plane.charCodeAt(row * perRow + k);
        const bit = k * bits;
        const byte = plane.charCodeAt(row * perRow + (bit >> 3)) || 0;
        return bits >= 8 ? byte : (byte >> (8 - bits - (bit & 7))) & max;
      };
      const color = o.mask ? gs.color.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)) : null;
      const px = [];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const c = [];
          for (let q = 0; q < ncomp; q++) {
            const s0 = o.files.length > 1 ? sample(planes[q], y, x) : sample(planes[0], y, x * ncomp + q);
            c.push(s0 === undefined || Number.isNaN(s0) ? 0 : s0);
          }
          if (o.mask) {
            // imagemask: paint where the sample is 1 (or 0 with the decode inverted)
            const on = (c[0] === 1) !== !!o.invert;
            px.push(String.fromCharCode(color[0], color[1], color[2], on ? 255 : 0));
            continue;
          }
          let v = c.map((s1, q) => { const d0 = dec ? dec[2 * q] : 0; const d1 = dec ? dec[2 * q + 1] : 1; return d0 + (s1 / max) * (d1 - d0); });
          let cs = o.cs;
          if (cs.indexed) {
            const i0 = Math.round(v[0] * (dec ? 1 : max));
            const bn = cs.indexed.base.n;
            v = []; for (let q = 0; q < bn; q++) v.push((cs.indexed.table.charCodeAt(i0 * bn + q) || 0) / 255);
            cs = cs.indexed.base;
          }
          let rgb;
          if (cs.n === 3) rgb = v;
          else if (cs.n === 4) rgb = [(1 - v[0]) * (1 - v[3]), (1 - v[1]) * (1 - v[3]), (1 - v[2]) * (1 - v[3])];
          else rgb = [v[0], v[0], v[0]];
          px.push(String.fromCharCode(...rgb.map((t) => Math.round(Math.max(0, Math.min(1, t)) * 255)), 255));
        }
      }
      placeImage(w, h, o.matrix, 'data:image/png;base64,' + base64(png(w, h, px.join(''))));
    }
    const imageDict = (d, mask) => {
      const g = (k) => d.m.get('/' + k);
      const src = g('DataSource');
      const dec = g('Decode');
      return {
        w: g('Width'), h: g('Height'), bits: g('BitsPerComponent') || 1, matrix: g('ImageMatrix').v, mask,
        files: [asFile(src)], cs: gs.cs, decode: dec && dec.v, invert: mask && !(dec && dec.v[0] === 1),
      };
    };
    def('image', () => {
      const top = os[os.length - 1];
      if (top && top.t === 'dict') { drawImage(imageDict(pop(), false)); return; }
      const src = pop(); const m = pop(); const bits = num(); const h = num(); const w = num();
      drawImage({ w, h, bits, matrix: m.v, files: [asFile(src)], cs: { n: 1 } });
    });
    def('colorimage', () => {
      const ncomp = num(); const multi = pop() === true;
      const srcs = []; for (let k = 0; k < (multi ? ncomp : 1); k++) srcs.unshift(pop());
      const m = pop(); const bits = num(); const h = num(); const w = num();
      drawImage({ w, h, bits, matrix: m.v, files: srcs.map(asFile), cs: ncomp === 4 ? { n: 4, cmyk: true } : ncomp === 3 ? { n: 3 } : { n: 1 } });
    });
    def('imagemask', () => {
      const top = os[os.length - 1];
      if (top && top.t === 'dict') { drawImage(imageDict(pop(), true)); return; }
      const src = pop(); const m = pop(); const inv = pop(); const h = num(); const w = num();
      drawImage({ w, h, bits: 1, matrix: m.v, files: [asFile(src)], mask: true, invert: inv !== true });
    });
    def('gcheck', () => { pop(); os.push(false); });
    def('wcheck', () => { pop(); os.push(true); });
    def('rcheck', () => { pop(); os.push(true); });

    // fonts and text
    def('findfont', () => { const n = pop(); os.push({ t: 'font', name: n.v, matrix: [1, 0, 0, 1, 0, 0] }); });
    def('scalefont', () => { const s = num(); const f = pop(); os.push(Object.assign({}, f, { matrix: mul(f.matrix, [s, 0, 0, s, 0, 0]) })); });
    def('makefont', () => { const m = pop(); const f = pop(); os.push(Object.assign({}, f, { matrix: mul(f.matrix, m.v) })); });
    def('selectfont', () => { const s = pop(); const n = pop(); const m = typeof s === 'number' ? [s, 0, 0, s, 0, 0] : s.v; gs.font = { t: 'font', name: n.v, matrix: m }; });
    def('setfont', () => { gs.font = pop(); });
    def('currentfont', () => os.push(gs.font || { t: 'font', name: 'Times-Roman', matrix: [10, 0, 0, 10, 0, 0] }));
    def('definefont', () => { const f = pop(); const k = pop(); os.push(f && f.t === 'dict' ? { t: 'font', name: k.v, matrix: [1, 0, 0, 1, 0, 0] } : f); });
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
    for (;;) {
      let tok;
      try { tok = sc.next(); } catch (e) { partial = true; break; }
      if (tok === undefined) break;
      if (tok === null) continue;
      afterToken = true;
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
