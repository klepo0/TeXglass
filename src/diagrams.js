/*
 * TeXglass diagrams, part 2: lay out and draw the diagrams that src/tikz.js
 * emitted. Runs in the page (the web viewer and the VS Code preview).
 *
 * Arrows depend on the size of rendered math, so they are drawn here, after
 * the browser has laid the cells out: each diagram is watched with a
 * ResizeObserver and redrawn when its size or the font size changes. New
 * diagrams are found with a MutationObserver, so callers only load this file.
 *
 * Strokes use currentColor and gaps use the page background, so diagrams
 * follow the light and dark themes without being redrawn.
 */
(function () {
  'use strict';

  const SVG = 'http://www.w3.org/2000/svg';
  const LINE = 0.045; // line width in em (0.45pt at 10pt)

  // ---------------------------------------------------------------------------
  // Vector helpers
  // ---------------------------------------------------------------------------

  const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const mul = (a, k) => [a[0] * k, a[1] * k];
  const len = (a) => Math.hypot(a[0], a[1]);
  const unit = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };
  const rot = (a, deg) => {
    const t = (deg * Math.PI) / 180;
    return [a[0] * Math.cos(t) - a[1] * Math.sin(t), a[0] * Math.sin(t) + a[1] * Math.cos(t)];
  };
  /** Left of the direction of travel, on screen (y down). */
  const leftOf = (d) => unit([d[1], -d[0]]);

  function bez(c, t) {
    const u = 1 - t;
    return [
      u * u * u * c[0][0] + 3 * u * u * t * c[1][0] + 3 * u * t * t * c[2][0] + t * t * t * c[3][0],
      u * u * u * c[0][1] + 3 * u * u * t * c[1][1] + 3 * u * t * t * c[2][1] + t * t * t * c[3][1],
    ];
  }
  function bezTan(c, t) {
    const u = 1 - t;
    const d = [
      3 * u * u * (c[1][0] - c[0][0]) + 6 * u * t * (c[2][0] - c[1][0]) + 3 * t * t * (c[3][0] - c[2][0]),
      3 * u * u * (c[1][1] - c[0][1]) + 6 * u * t * (c[2][1] - c[1][1]) + 3 * t * t * (c[3][1] - c[2][1]),
    ];
    return len(d) < 1e-9 ? sub(c[3], c[0]) : d;
  }
  /** The part of cubic c between parameters t0 < t1. */
  function bezSlice(c, t0, t1) {
    const split = (c, t) => {
      const l = (a, b) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const p01 = l(c[0], c[1]); const p12 = l(c[1], c[2]); const p23 = l(c[2], c[3]);
      const a = l(p01, p12); const b = l(p12, p23); const m = l(a, b);
      return [[c[0], p01, a, m], [m, b, p23, c[3]]];
    };
    const right = split(c, t0)[1];
    return split(right, t0 >= 1 ? 1 : (t1 - t0) / (1 - t0))[0];
  }
  function bezLength(c) {
    let L = 0;
    let p = c[0];
    for (let k = 1; k <= 16; k++) { const q = bez(c, k / 16); L += len(sub(q, p)); p = q; }
    return L;
  }
  /** Parameter at arc length s from the start (or from the end when s < 0). */
  function bezAt(c, s) {
    const total = bezLength(c);
    if (s < 0) s = total + s;
    return Math.max(0, Math.min(1, s / (total || 1)));
  }

  /** Is p inside shape (box {x,y,w,h} or ellipse)? */
  function inside(shape, p) {
    if (!shape) return false;
    if (shape.round) {
      const rx = shape.w / 2; const ry = shape.h / 2;
      if (rx <= 0 || ry <= 0) return false;
      const dx = (p[0] - shape.x - rx) / rx; const dy = (p[1] - shape.y - ry) / ry;
      return dx * dx + dy * dy < 1;
    }
    return p[0] > shape.x && p[0] < shape.x + shape.w && p[1] > shape.y && p[1] < shape.y + shape.h;
  }

  /** First t where the curve leaves `a` (from the start) and enters `b` (at the end). */
  function clipCurve(c, a, b) {
    const search = (shape, fromStart) => {
      if (!shape || shape.w <= 0 || shape.h <= 0) return fromStart ? 0 : 1;
      const at = (t) => inside(shape, bez(c, fromStart ? t : 1 - t));
      if (!at(0)) return fromStart ? 0 : 1;
      let lo = 0; let hi = 1;
      // find a point outside first (coarse), then bisect
      let found = false;
      for (let k = 1; k <= 40; k++) { if (!at(k / 40)) { hi = k / 40; lo = (k - 1) / 40; found = true; break; } }
      if (!found) return fromStart ? 0 : 1;
      for (let k = 0; k < 24; k++) { const m = (lo + hi) / 2; if (at(m)) lo = m; else hi = m; }
      return fromStart ? hi : 1 - hi;
    };
    return [search(a, true), search(b, false)];
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------

  function el(name, attrs) {
    const e = document.createElementNS(SVG, name);
    for (const k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
    return e;
  }
  const f2 = (x) => Math.round(x * 100) / 100;
  const pt = (p) => `${f2(p[0])},${f2(p[1])}`;
  const curveD = (c) => `M${pt(c[0])}C${pt(c[1])} ${pt(c[2])} ${pt(c[3])}`;

  /** Offset a cubic sideways by d (positive = left), approximately. */
  function offsetCurve(c, d) {
    const n0 = leftOf(bezTan(c, 0));
    const n1 = leftOf(bezTan(c, 1));
    return [add(c[0], mul(n0, d)), add(c[1], mul(n0, d)), add(c[2], mul(n1, d)), add(c[3], mul(n1, d))];
  }

  function squiggle(c, em, stop) {
    const total = bezLength(c);
    const wave = 0.42 * em; const amp = 0.1 * em;
    const n = Math.max(2, Math.floor((total - stop) / wave * 8));
    const pts = [];
    for (let k = 0; k <= n; k++) {
      const s = ((total - stop) * k) / n;
      const t = s / (total || 1);
      const p = bez(c, t);
      const off = Math.sin((s / wave) * 2 * Math.PI) * amp;
      pts.push(add(p, mul(leftOf(bezTan(c, t)), off)));
    }
    pts.push(c[3]);
    return 'M' + pts.map(pt).join('L');
  }

  /**
   * A tip at point p pointing along direction d. kind: to | 2h | harp |
   * harp2 | bar | hook | hook2 | tail | stealth | dot | circle.
   * `wide` widens it for double lines.
   */
  function tip(g, kind, p, d, em, wide, style) {
    const u = unit(d);
    const n = leftOf(u);
    const L = 0.3 * em; // length of the barbs
    const W = (wide ? 0.33 : 0.21) * em;
    const at = (x, y) => add(p, add(mul(u, x), mul(n, y)));
    const path = (dd, extra) => g.appendChild(el('path', Object.assign({ d: dd, fill: 'none', style }, extra || {})));
    const barb = (o, side) => `M${pt(at(o - L, side * W))}Q${pt(at(o - L * 0.25, side * W * 0.15))} ${pt(at(o, 0))}`;
    switch (kind) {
      case 'to': path(barb(0, 1) + barb(0, -1)); break;
      case '2h': path(barb(0, 1) + barb(0, -1) + barb(-L * 0.8, 1) + barb(-L * 0.8, -1)); break;
      case 'harp': path(barb(0, 1)); break;
      case 'harp2': path(barb(0, -1)); break;
      case 'bar': path(`M${pt(at(0, W))}L${pt(at(0, -W))}`); break;
      case 'hook': case 'hook2': {
        // a half circle opening forwards, on the left (hook) or right (hook2)
        const s = kind === 'hook' ? 1 : -1;
        const r = 0.13 * em;
        const pts = [];
        for (let k = 0; k <= 10; k++) {
          const a = (Math.PI * k) / 10;
          pts.push(at(-r * Math.sin(a), s * (r - r * Math.cos(a))));
        }
        pts.reverse();
        path('M' + pts.map(pt).join('L'));
        break;
      }
      case 'tail': path(barb(L, 1) + barb(L, -1)); break;
      case 'stealth': {
        const S = 0.32 * em;
        g.appendChild(el('path', {
          d: `M${pt(at(0, 0))}L${pt(at(-S, 0.42 * S))}L${pt(at(-0.72 * S, 0))}L${pt(at(-S, -0.42 * S))}Z`,
          style: style + ';fill:' + (/stroke:([^;]+)/.exec(style) || [0, 'currentColor'])[1] + ';stroke-linejoin:round',
        }));
        break;
      }
      case 'dot': case 'circle': {
        const r = 0.09 * em;
        const col = (/stroke:([^;]+)/.exec(style) || [0, 'currentColor'])[1];
        g.appendChild(el('circle', { cx: f2(at(-r, 0)[0]), cy: f2(at(-r, 0)[1]), r: f2(r), style: style + ';fill:' + (kind === 'dot' ? col : 'var(--diagram-bg, var(--paper, #fff))') }));
        break;
      }
      default: break;
    }
  }

  /** How far a tip reaches back from the end point, so the line can stop short. */
  function tipBack(kind, em, dbl) {
    if (kind === 'stealth') return 0.22 * em;
    if (kind === 'dot' || kind === 'circle') return 0.18 * em;
    if (dbl && (kind === 'to' || kind === '2h')) return 0.12 * em;
    return 0;
  }

  /**
   * Draw a stroked cubic with tips. o: { head, tail, dbl, dash, sq, lw, col,
   * cross } as in the diagram model. Returns nothing; appends to g.
   */
  function drawArrow(g, c, o, em, bg) {
    const color = o.col || 'currentColor';
    const w = LINE * em * (o.lw || 1);
    const style = `stroke:${color};stroke-width:${f2(w)}px;stroke-linecap:round;stroke-linejoin:round`;
    const head = o.head || 'none';
    const tail = o.tail || 'none';
    // shorten the shaft under filled or wide tips
    const b1 = tipBack(head, em, o.dbl);
    const b0 = tipBack(tail === 'to' || tail === '2h' || tail === 'stealth' ? tail : 'none', em, o.dbl);
    let shaft = c;
    if (b0 || b1) shaft = bezSlice(c, bezAt(c, b0), bezAt(c, -b1));
    const dash = o.dash === 'dashed' ? `${f2(0.28 * em)} ${f2(0.2 * em)}` : o.dash === 'dotted' ? `0 ${f2(0.16 * em)}` : null;
    const shaftStyle = style + (dash ? `;stroke-dasharray:${dash}` : '');
    if (o.cross) {
      const gap = `stroke:${bg};stroke-width:${f2(w + 0.28 * em)}px;fill:none`;
      g.appendChild(el('path', { d: curveD(shaft), style: gap }));
    }
    if (o.dbl) {
      const gapW = 0.075 * em;
      for (const s of [1, -1]) g.appendChild(el('path', { d: curveD(offsetCurve(shaft, (s * gapW) / 2 + (s * w) / 2)), fill: 'none', style: shaftStyle }));
    } else if (o.sq) {
      g.appendChild(el('path', { d: squiggle(shaft, em, head !== 'none' ? 0.3 * em : 0), fill: 'none', style }));
    } else {
      g.appendChild(el('path', { d: curveD(shaft), fill: 'none', style: shaftStyle }));
    }
    const end = c[3];
    const endDir = bezTan(c, 1);
    const start = c[0];
    const startDir = bezTan(c, 0);
    if (head !== 'none') tip(g, head, end, endDir, em, o.dbl, style);
    if (tail === 'to' || tail === '2h' || tail === 'stealth' || tail === 'harp' || tail === 'harp2' || tail === 'dot' || tail === 'circle') {
      tip(g, tail, start, mul(startDir, -1), em, o.dbl, style);
    } else if (tail !== 'none') {
      tip(g, tail, start, startDir, em, o.dbl, style);
    }
  }

  /** Background colour behind an element (for gaps under labels and crossings). */
  function backgroundOf(node) {
    for (let e = node; e && e.nodeType === 1; e = e.parentElement) {
      const c = getComputedStyle(e).backgroundColor;
      // only an opaque colour hides what is behind it
      const a = /rgba?\(([^)]*)\)/.exec(c || '');
      const alpha = a ? a[1].split(/[,/\s]+/).filter(Boolean)[3] : undefined;
      if (c && c !== 'transparent' && (alpha === undefined || parseFloat(alpha) >= 1)) return c;
    }
    return getComputedStyle(document.body).backgroundColor || '#fff';
  }

  /** How far a w×h box reaches from its centre in direction n (unit). */
  const support = (n, w, h) => (Math.abs(n[0]) * w) / 2 + (Math.abs(n[1]) * h) / 2;

  /** Place a label box of size (w, h) beside point p, on side `side` of direction d. */
  function labelCenter(p, d, side, w, h, em) {
    if (side === 'c') return p;
    let n;
    switch (side) {
      case 'above': n = [0, -1]; break;
      case 'below': n = [0, 1]; break;
      case 'left': n = [-1, 0]; break;
      case 'right': n = [1, 0]; break;
      case 'above left': n = unit([-1, -1]); break;
      case 'above right': n = unit([1, -1]); break;
      case 'below left': n = unit([-1, 1]); break;
      case 'below right': n = unit([1, 1]); break;
      default: n = side === 'r' ? mul(leftOf(d), -1) : leftOf(d);
    }
    // keep the whole box off the line: its nearest corner touches the offset
    return add(p, mul(n, 0.14 * em + support(n, w, h)));
  }

  // ---------------------------------------------------------------------------
  // Commutative diagrams
  // ---------------------------------------------------------------------------

  const ANCHOR = {
    north: [0.5, 0], south: [0.5, 1], east: [1, 0.5], west: [0, 0.5], center: [0.5, 0.5],
    'north east': [1, 0], 'north west': [0, 0], 'south east': [1, 1], 'south west': [0, 1],
  };

  function layoutCd(wrap) {
    const grid = wrap.querySelector(':scope > .cd-grid');
    if (!grid) return;
    const em = parseFloat(getComputedStyle(wrap).fontSize) || 16;
    const gr = grid.getBoundingClientRect();
    if (gr.width === 0 && gr.height === 0) return;
    let data;
    try { data = JSON.parse(wrap.getAttribute('data-cd')); } catch (e) { return; }
    const scale = gr.width / (grid.offsetWidth || gr.width) || 1; // CSS transforms (zoom)
    const box = (e) => {
      const r = e.getBoundingClientRect();
      return { x: (r.left - gr.left) / scale, y: (r.top - gr.top) / scale, w: r.width / scale, h: r.height / scale };
    };
    const nodes = Object.create(null);
    for (const n of grid.querySelectorAll('.cd-node')) {
      const b = box(n);
      if (n.classList.contains('cd-empty')) {
        const cell = box(n.parentElement);
        nodes[n.getAttribute('data-rc')] = { x: cell.x + cell.w / 2, y: cell.y + cell.h / 2, w: 0, h: 0 };
      } else nodes[n.getAttribute('data-rc')] = b;
    }
    const labelEls = Object.create(null);
    for (const l of wrap.querySelectorAll(':scope > .cd-label')) labelEls[l.getAttribute('data-k')] = l;
    const sizes = Object.create(null);
    for (const k in labelEls) {
      const l = labelEls[k];
      sizes[k] = { w: l.offsetWidth, h: l.offsetHeight };
    }

    const bg = backgroundOf(wrap);
    const svg = el('svg', { class: 'cd-svg', 'aria-hidden': 'true' });
    const g = el('g', {});
    svg.appendChild(g);
    const named = Object.create(null);
    const placed = [];
    const center = (b) => [b.x + b.w / 2, b.y + b.h / 2];
    // KaTeX line boxes are taller than the glyphs; trim them so vertical arrows are not stubby.
    const pad = (b) => (b.w || b.h ? { x: b.x - 0.06 * em, y: b.y + 0.1 * em, w: b.w + 0.12 * em, h: Math.max(0, b.h - 0.2 * em) } : b);

    // arrows between cells first, then those that start or end at a named label
    const order = data.arrows.map((a, i) => i).sort((i, j) => {
      const late = (a) => (nodes[a.f] && nodes[a.t] ? 0 : 1);
      return late(data.arrows[i]) - late(data.arrows[j]);
    });
    let minX = 0; let minY = 0; let maxX = gr.width / scale; let maxY = gr.height / scale;
    const grow = (x, y) => { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); };

    for (const i of order) {
      const a = data.arrows[i];
      const A = nodes[a.f] || named[a.f];
      const B = nodes[a.t] || named[a.t];
      if (!A || !B) continue;
      const pA = a.sa ? [A.x + ANCHOR[a.sa][0] * A.w, A.y + ANCHOR[a.sa][1] * A.h] : center(A);
      const pB = a.ea ? [B.x + ANCHOR[a.ea][0] * B.w, B.y + ANCHOR[a.ea][1] * B.h] : center(B);
      const d = sub(pB, pA);
      if (len(d) < 1e-6) continue;
      const off = add(mul(leftOf(d), (a.sh || 0) * em), [(a.xs || 0) * em, (a.ys || 0) * em]);
      const p0 = add(pA, off);
      const p1 = add(pB, off);
      let c;
      if (a.out !== undefined && a.in !== undefined) {
        const k = 0.3915 * len(d) * (a.loose || 1);
        const dirOf = (deg) => [Math.cos((deg * Math.PI) / 180), -Math.sin((deg * Math.PI) / 180)];
        c = [p0, add(p0, mul(dirOf(a.out), k)), add(p1, mul(dirOf(a.in), k)), p1];
      } else if (a.bend) {
        const k = 0.3915 * len(d) * (a.loose || 1);
        const u = unit(d);
        c = [p0, add(p0, mul(rot(u, -a.bend), k)), add(p1, mul(rot(mul(u, -1), a.bend), k)), p1];
      } else {
        c = [p0, add(p0, mul(d, 1 / 3)), add(p0, mul(d, 2 / 3)), p1];
      }
      const [t0, t1] = clipCurve(c, a.sa ? null : pad(A), a.ea ? null : pad(B));
      if (t1 <= t0) continue;
      c = bezSlice(c, t0, t1);
      if (a.s0 || a.s1) {
        const u0 = bezAt(c, (a.s0 || 0) * em);
        const u1 = bezAt(c, -(a.s1 || 0) * em);
        if (u1 > u0) c = bezSlice(c, u0, u1);
      }
      if (!a.ph) drawArrow(g, c, a, em, bg);
      for (const p of c) grow(p[0], p[1]);
      for (const L of a.L || []) {
        const t = L.p === undefined ? 0.5 : L.p;
        const p = bez(c, t);
        const dir = bezTan(c, t);
        const s = L.k >= 0 ? sizes[L.k] : { w: 0, h: 0 };
        const ctr = labelCenter(p, dir, L.s || 'l', s.w, s.h, em);
        const lb = { x: ctr[0] - s.w / 2, y: ctr[1] - s.h / 2, w: s.w, h: s.h };
        if (L.n) named[L.n] = L.k >= 0 ? lb : { x: ctr[0], y: ctr[1], w: 0, h: 0 };
        if (L.k >= 0 && labelEls[L.k]) {
          placed.push({ e: labelEls[L.k], b: lb, d: L.d, sl: L.sl ? Math.atan2(dir[1], dir[0]) : 0, col: L.col });
          grow(lb.x, lb.y);
          grow(lb.x + lb.w, lb.y + lb.h);
        }
      }
    }

    // Room for curves and labels that stick out of the grid.
    const m = 0.1 * em;
    const padL = Math.max(0, -minX + m); const padT = Math.max(0, -minY + m);
    const padR = Math.max(0, maxX - gr.width / scale + m); const padB = Math.max(0, maxY - gr.height / scale + m);
    wrap.style.padding = `${f2(padT)}px ${f2(padR)}px ${f2(padB)}px ${f2(padL)}px`;
    const W = gr.width / scale; const H = gr.height / scale;
    svg.setAttribute('width', f2(W + padL + padR));
    svg.setAttribute('height', f2(H + padT + padB));
    svg.setAttribute('viewBox', `${f2(-padL)} ${f2(-padT)} ${f2(W + padL + padR)} ${f2(H + padT + padB)}`);
    const old = wrap.querySelector(':scope > .cd-svg');
    if (old) old.replaceWith(svg); else wrap.insertBefore(svg, wrap.firstChild);
    for (const l of Object.values(labelEls)) l.style.visibility = 'hidden';
    for (const p of placed) {
      p.e.style.left = `${f2(p.b.x + padL)}px`;
      p.e.style.top = `${f2(p.b.y + padT)}px`;
      p.e.style.visibility = 'visible';
      p.e.classList.toggle('cd-desc', !!p.d);
      if (p.d) p.e.style.background = bg;
      if (p.col) p.e.style.color = p.col;
      let ang = (p.sl * 180) / Math.PI;
      if (ang > 90) ang -= 180; else if (ang < -90) ang += 180;
      p.e.style.transform = p.sl ? `rotate(${f2(ang)}deg)` : '';
    }
  }

  // ---------------------------------------------------------------------------
  // tikzpicture
  // ---------------------------------------------------------------------------

  const COMPASS = {
    north: 90, south: 270, east: 0, west: 180, 'north east': 45, 'north west': 135, 'south east': 315, 'south west': 225,
  };

  /** Point on the border of node box b (centre cx, cy) in screen direction d. */
  function border(b, d) {
    const u = unit(d);
    if (!b.w && !b.h) return [b.cx, b.cy];
    if (b.shape === 'circle' || b.shape === 'ellipse') {
      const rx = b.w / 2; const ry = b.h / 2;
      const k = 1 / Math.sqrt((u[0] * u[0]) / (rx * rx) + (u[1] * u[1]) / (ry * ry));
      return [b.cx + u[0] * k, b.cy + u[1] * k];
    }
    const tx = Math.abs(u[0]) > 1e-9 ? b.w / 2 / Math.abs(u[0]) : Infinity;
    const ty = Math.abs(u[1]) > 1e-9 ? b.h / 2 / Math.abs(u[1]) : Infinity;
    const k = Math.min(tx, ty);
    return [b.cx + u[0] * k, b.cy + u[1] * k];
  }

  /** A named anchor ("north east", "30") of node box b. */
  function anchorPoint(b, a) {
    if (!a || a === 'center') return [b.cx, b.cy];
    const comp = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0], 'north east': [1, -1], 'north west': [-1, -1], 'south east': [1, 1], 'south west': [-1, 1] };
    if (comp[a]) {
      if (b.shape === 'circle' || b.shape === 'ellipse') return border(b, comp[a]);
      return [b.cx + (comp[a][0] * b.w) / 2, b.cy + (comp[a][1] * b.h) / 2];
    }
    if (a === 'base' || a === 'mid') return [b.cx, b.cy + (a === 'base' ? b.h / 4 : 0)];
    const ang = parseFloat(a);
    if (!isNaN(ang)) return border(b, [Math.cos((ang * Math.PI) / 180), -Math.sin((ang * Math.PI) / 180)]);
    return [b.cx, b.cy];
  }

  function layoutTikz(wrap) {
    let data;
    try { data = JSON.parse(wrap.getAttribute('data-tikz')); } catch (e) { return; }
    const em = parseFloat(getComputedStyle(wrap).fontSize) || 16;
    const S = em * 2.8453; // px per cm
    const pt = em / 10; // px per pt
    const toPx = (p) => [p[0] * S, -p[1] * S];
    const els = Object.create(null);
    for (const e of wrap.querySelectorAll(':scope > .tikz-node')) els[e.getAttribute('data-k')] = e;

    // node sizes
    const boxes = data.nodes.map((n) => {
      const e = n.k >= 0 ? els[n.k] : null;
      let tw = 0; let th = 0;
      if (e) {
        e.style.fontSize = n.scale && n.scale !== 1 ? `${n.scale}em` : '';
        if (n.tw) { e.style.width = `${n.tw * S}px`; e.classList.add('tikz-multi'); } else if (n.multi) e.classList.add('tikz-multi');
        if (n.col) e.style.color = n.col;
        tw = e.offsetWidth; th = e.offsetHeight;
        // the line box is taller than the text; TikZ boxes hug the glyphs more closely
        th = Math.max(0, th - 0.18 * em * (n.scale || 1));
      }
      const is = (n.is || 0) * S;
      let w = 0; let h = 0;
      if (n.shape !== 'coord') {
        w = tw + 2 * is; h = th + 2 * is;
        if (n.shape === 'circle') { const d = Math.max(Math.hypot(tw, th) + 2 * is, (n.mw || 0) * S, (n.mh || 0) * S); w = h = d; }
        else if (n.shape === 'ellipse') { w = tw * 1.4142 + 2 * is; h = th * 1.4142 + 2 * is; }
        w = Math.max(w, (n.mw || 0) * S); h = Math.max(h, (n.mh || 0) * S);
        const os = (n.os || 0) * S;
        w += 2 * os; h += 2 * os;
      }
      return { n, e, tw, th, w, h, shape: n.shape, cx: 0, cy: 0, ok: false };
    });

    const place = (b, P) => {
      // P is where the node's anchor goes
      const n = b.n;
      let c = add(P, [(n.dx || 0) * S, -(n.dy || 0) * S]);
      if (n.anchor && n.anchor !== 'center') {
        b.cx = 0; b.cy = 0;
        const a = anchorPoint(b, n.anchor);
        c = sub(c, a);
      }
      b.cx = c[0]; b.cy = c[1]; b.ok = true;
    };
    for (const b of boxes) if (b.n.at) place(b, toPx(b.n.at));

    // paths
    const resolved = data.paths.map(() => []); // per segment: [start, ...controls, end]
    const ref = (p, toward) => {
      if (Array.isArray(p)) return toPx(p);
      const b = boxes[p.n];
      if (!b) return [0, 0];
      let q;
      if (!b.ok) q = [b.cx, b.cy];
      else if (p.a) q = anchorPoint(b, p.a);
      else if (toward && b.shape !== 'coord') q = border(b, sub(toward, [b.cx, b.cy]));
      else q = [b.cx, b.cy];
      return add(q, [(p.dx || 0) * S, -(p.dy || 0) * S]);
    };
    const center = (p) => (Array.isArray(p) ? toPx(p) : boxes[p.n] ? [boxes[p.n].cx, boxes[p.n].cy] : [0, 0]);
    const drawn = [];
    data.paths.forEach((path, pi) => {
      const pieces = []; // {d, start, startDir, end, endDir}
      let d = '';
      let cur = null; // resolved current point
      let curRaw = null; // the raw point (maybe a ref)
      let startPt = null;
      let first = null; let firstDir = null; let last = null; let lastDir = null;
      const segs = path.segs;
      segs.forEach((g, si) => {
        const type = g[0];
        if (type === 'M') {
          const next = segs[si + 1];
          const toward = next && next[0] !== 'M' && next[0] !== 'Z' ? center(next[1]) : null;
          cur = ref(g[1], toward);
          curRaw = g[1];
          startPt = cur;
          d += `M${f2(cur[0])},${f2(cur[1])}`;
          resolved[pi][si] = [cur, cur];
          return;
        }
        if (type === 'Z') {
          if (startPt) { d += 'Z'; resolved[pi][si] = [cur, startPt]; cur = startPt; }
          return;
        }
        if (!cur) { cur = [0, 0]; d += 'M0,0'; }
        const ctrls = g.slice(1, -1).map(center);
        const endRaw = g[g.length - 1];
        // a segment leaving a node starts at the node's border
        let s0 = cur;
        if (curRaw && !Array.isArray(curRaw) && !curRaw.a) {
          s0 = ref(curRaw, ctrls[0] || center(endRaw));
          if (Math.hypot(s0[0] - cur[0], s0[1] - cur[1]) > 0.01) d += `M${f2(s0[0])},${f2(s0[1])}`;
        }
        const end = ref(endRaw, ctrls.length ? ctrls[ctrls.length - 1] : center(curRaw || cur) && s0);
        if (type === 'L') d += `L${f2(end[0])},${f2(end[1])}`;
        else d += `C${pt2(ctrls[0])} ${pt2(ctrls[1])} ${pt2(end)}`;
        resolved[pi][si] = [s0, ...ctrls, end];
        if (!first) { first = s0; firstDir = sub(ctrls[0] || end, s0); }
        last = end; lastDir = sub(end, ctrls.length ? ctrls[ctrls.length - 1] : s0);
        cur = end;
        curRaw = endRaw;
      });
      drawn.push({ path, d, first, firstDir, last, lastDir });
    });
    function pt2(p) { return `${f2(p[0])},${f2(p[1])}`; }

    // nodes along paths
    for (const b of boxes) {
      const on = b.n.on;
      if (!on || b.ok) continue;
      const r = resolved[on.path] && resolved[on.path][on.seg];
      if (!r) { place(b, [0, 0]); continue; }
      const t = on.t === undefined ? 0.5 : on.t;
      const P = r.length === 4 ? bez(r, t) : [r[0][0] + (r[r.length - 1][0] - r[0][0]) * t, r[0][1] + (r[r.length - 1][1] - r[0][1]) * t];
      place(b, P);
    }
    // labels of nodes
    for (const b of boxes) {
      if (b.n.of === undefined) continue;
      const parent = boxes[b.n.of];
      if (!parent || !parent.ok) { b.ok = false; continue; }
      const ang = ((b.n.dir || 0) * Math.PI) / 180;
      const dir = [Math.cos(ang), -Math.sin(ang)];
      const P = border(parent, dir);
      const reach = support(dir, b.w, b.h);
      b.cx = P[0] + dir[0] * reach; b.cy = P[1] + dir[1] * reach; b.ok = true;
    }

    // bounding box
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    const grow = (p, r) => { r = r || 0; x0 = Math.min(x0, p[0] - r); y0 = Math.min(y0, p[1] - r); x1 = Math.max(x1, p[0] + r); y1 = Math.max(y1, p[1] + r); };
    resolved.forEach((segs, pi) => {
      const lw = ((data.paths[pi].lw || 0.4) * pt) / 2 + (data.paths[pi].head !== 'none' || data.paths[pi].tail !== 'none' ? 0.25 * em : 0);
      for (const r of segs) if (r) {
        if (r.length === 4) for (let k = 0; k <= 8; k++) grow(bez(r, k / 8), lw);
        else for (const p of r) grow(p, lw);
      }
    });
    for (const b of boxes) if (b.ok && b.shape !== 'coord') { grow([b.cx - b.w / 2, b.cy - b.h / 2]); grow([b.cx + b.w / 2, b.cy + b.h / 2]); }
    if (x0 === Infinity) { x0 = y0 = 0; x1 = y1 = 1; }
    const m = 1;
    x0 -= m; y0 -= m; x1 += m; y1 += m;
    const W = x1 - x0; const H = y1 - y0;

    const svg = el('svg', { class: 'tikz-svg', 'aria-hidden': 'true', width: f2(W), height: f2(H), viewBox: `${f2(x0)} ${f2(y0)} ${f2(W)} ${f2(H)}` });
    for (const p of drawn) {
      const P = p.path;
      if (!P.draw && !P.fill) continue;
      const w = (P.lw || 0.4) * pt;
      let style = `stroke-width:${f2(w)}px;stroke-linejoin:round`;
      style += `;stroke:${P.draw || 'none'};fill:${P.fill || 'none'}`;
      if (P.fill) style += ';fill-rule:nonzero';
      if (P.op) style += `;opacity:${P.op}`;
      if (P.dash) {
        style += `;stroke-dasharray:${P.dash.map((x) => f2(Math.max(x * pt, 0.001))).join(' ')}`;
        if (P.dash.includes(0)) style += ';stroke-linecap:round';
      }
      svg.appendChild(el('path', { d: p.d, style }));
      if (P.draw && p.last) {
        const ts = `stroke:${P.draw};stroke-width:${f2(w)}px;stroke-linecap:round;stroke-linejoin:round`;
        const big = Math.max(1, (P.lw || 0.4) / 0.4) * em * 0.85;
        if (P.head && P.head !== 'none') tip(svg, P.head, p.last, p.lastDir, big, false, ts);
        if (P.tail && P.tail !== 'none') tip(svg, P.tail, p.first, mul(p.firstDir, -1), big, false, ts);
      }
    }
    for (const b of boxes) {
      if (!b.ok || b.shape === 'coord' || (!b.n.draw && !b.n.fill)) continue;
      const w = (b.n.lw || 0.4) * pt;
      let style = `stroke:${b.n.draw || 'none'};fill:${b.n.fill || 'none'};stroke-width:${f2(w)}px`;
      if (b.n.dash) style += `;stroke-dasharray:${b.n.dash.map((x) => f2(Math.max(x * pt, 0.001))).join(' ')}`;
      if (b.shape === 'circle' || b.shape === 'ellipse') svg.appendChild(el('ellipse', { cx: f2(b.cx), cy: f2(b.cy), rx: f2(b.w / 2), ry: f2(b.h / 2), style }));
      else svg.appendChild(el('rect', { x: f2(b.cx - b.w / 2), y: f2(b.cy - b.h / 2), width: f2(b.w), height: f2(b.h), rx: b.n.rc ? f2(b.n.rc * em) : null, style }));
    }
    const old = wrap.querySelector(':scope > .tikz-svg');
    if (old) old.replaceWith(svg); else wrap.insertBefore(svg, wrap.firstChild);
    wrap.style.width = `${f2(W)}px`;
    wrap.style.height = `${f2(H)}px`;
    for (const b of boxes) {
      if (!b.e) continue;
      if (!b.ok) { b.e.style.visibility = 'hidden'; continue; }
      b.e.style.left = `${f2(b.cx - b.tw / 2 - x0)}px`;
      b.e.style.top = `${f2(b.cy - b.e.offsetHeight / 2 - y0)}px`;
      b.e.style.visibility = 'visible';
    }
  }

  // ---------------------------------------------------------------------------
  // Watching the page
  // ---------------------------------------------------------------------------

  const LAYOUT = { 'data-cd': layoutCd, 'data-tikz': layoutTikz };
  const sel = Object.keys(LAYOUT).map((a) => `[${a}]`).join(',');
  const seen = new WeakMap(); // element -> last layout key

  function layout(e) {
    const em = parseFloat(getComputedStyle(e).fontSize) || 0;
    const r = e.getBoundingClientRect();
    if (!r.width && !r.height) return;
    const key = `${em}|${Math.round(r.width)}|${Math.round(r.height)}`;
    if (seen.get(e) === key) return;
    for (const a in LAYOUT) if (e.hasAttribute(a)) { try { LAYOUT[a](e); } catch (err) { console.warn('TeXglass diagram', err); } }
    const r2 = e.getBoundingClientRect();
    seen.set(e, `${em}|${Math.round(r2.width)}|${Math.round(r2.height)}`);
  }

  let ro = null;
  function observe(root) {
    if (!ro && typeof ResizeObserver !== 'undefined') ro = new ResizeObserver((entries) => { for (const en of entries) layout(en.target); });
    const list = root.matches && root.matches(sel) ? [root] : [];
    if (root.querySelectorAll) list.push(...root.querySelectorAll(sel));
    for (const e of list) {
      if (ro) ro.observe(e);
      layout(e);
    }
  }

  function start() {
    observe(document.body);
    new MutationObserver((records) => {
      for (const rec of records) for (const n of rec.addedNodes) if (n.nodeType === 1) observe(n);
    }).observe(document.body, { childList: true, subtree: true });
    // Fonts change the size of every label once they load.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { for (const e of document.querySelectorAll(sel)) { seen.delete(e); layout(e); } });
  }

  const api = { observe, refresh: () => { for (const e of document.querySelectorAll(sel)) { seen.delete(e); layout(e); } }, _: { drawArrow, bez, bezTan, bezSlice, clipCurve, labelCenter, backgroundOf, el, tip, f2, LINE } };
  if (typeof window !== 'undefined') {
    window.TeXglassDiagrams = api;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})();
