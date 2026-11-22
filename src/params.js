/*
 * TeXglass live parameters: sliders for the parameters a paper declares with
 * texglass.sty's \tgparam[start]{name}{min}{max} (latex/texglass.sty). Moving
 * a slider changes every \tgvalue{name} and \name in the text at once, and
 * draws again each formula and TikZ picture that uses the parameter.
 *
 * The converter (src/texglass.js) leaves, at the end of the page, one hidden
 * .tg-param mark per parameter (name, min, max, step, start value, label), a
 * .tg-value span for each value in running text, and a hidden .tg-live mark
 * inside each formula or picture that uses a parameter, holding its TeX. To
 * draw one again the host renders that TeX with the new values, through
 * TeXglass.renderLive(source, piece, values) where the converter runs (the
 * page in the web viewer, the extension host in VS Code).
 *
 *   const params = TeXglassParams.attach({
 *     root,                          // the rendered document
 *     render: (piece, values) => …,  // Promise of the piece's new HTML, or null
 *   });
 *   params.refresh();                // after the document (or part of it) changed
 *   params.values();                 // { name: value } as now
 *   params.reset();                  // every parameter back to its start value
 *
 * A row of sliders goes with each paragraph, formula or picture that uses a
 * parameter, listing the ones it uses; sliders of the same parameter move
 * together. Ordinary LaTeX shows the start value.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TeXglassParams = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Decimal places of a step such as "0.05" (2) or "1" (0). */
  function decimals(step) {
    const s = String(step);
    if (/e-/i.test(s)) return Math.min(10, parseInt(s.split(/e-/i)[1], 10) || 0);
    const dot = s.indexOf('.');
    return dot < 0 ? 0 : Math.min(10, s.length - dot - 1);
  }

  /** A value as the sliders and the page write it: rounded to the step, without trailing zeros. */
  function format(v, step) {
    return String(+(+v).toFixed(decimals(step)));
  }

  /** Read the parameters' marks: Map name -> { name, min, max, step, start, label }. */
  function readDefs(doc) {
    const defs = new Map();
    for (const el of doc.querySelectorAll('.tg-params .tg-param')) {
      const d = el.dataset;
      if (!d.name || defs.has(d.name)) continue;
      const min = +d.min;
      const max = +d.max;
      if (!(min < max)) continue;
      const step = d.step && +d.step > 0 ? d.step : '1';
      defs.set(d.name, { name: d.name, min, max, step, start: format(d.value !== undefined ? d.value : min, step), label: d.label || d.name });
    }
    return defs;
  }

  /** The block a row of sliders goes with, and whether the row goes inside it (last) or after it. */
  function rowPlace(el) {
    const own = el.closest('.math-display') || el.closest('p, li, dd, td, th, figure, .figure, blockquote');
    if (own && own.matches('.math-display')) return { host: own, inside: false };
    if (own) return { host: own, inside: true };
    const pic = el.closest('.tg-diagram');
    return { host: pic || el, inside: false };
  }

  function attach(opts) {
    const doc = opts.root;
    const render = opts.render || null;
    let defs = new Map();
    const values = new Map(); // name -> value (string), where moved from the start
    const jobs = new Map(); // .tg-live mark -> { busy, again }

    const valueOf = (name) => (values.has(name) ? values.get(name) : defs.get(name).start);
    const allValues = () => {
      const o = {};
      for (const name of defs.keys()) o[name] = valueOf(name);
      return o;
    };

    /** Draw one formula or picture again with the current values. */
    function redraw(mark) {
      if (!render) return;
      const job = jobs.get(mark) || { busy: false, again: false };
      jobs.set(mark, job);
      if (job.busy) { job.again = true; return; }
      job.busy = true;
      job.again = false;
      const d = mark.dataset;
      const piece = { tex: d.tgTex || '', defs: d.tgDefs || '', display: 'tgDisplay' in d, picture: 'tgPicture' in d };
      Promise.resolve()
        .then(() => render(piece, allValues()))
        .then((html) => { if (typeof html === 'string' && mark.isConnected) put(mark, html); }, () => {})
        .then(() => {
          job.busy = false;
          if (job.again && mark.isConnected) redraw(mark);
          else jobs.delete(mark);
        });
    }

    /** Put new HTML for the piece that mark belongs to. */
    function put(mark, html) {
      const box = mark.parentElement;
      if (!box) return;
      if ('tgPicture' in mark.dataset) {
        // the picture's own element (.tg-diagram) is replaced; the mark moves into the new one
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        const pic = tmp.firstElementChild;
        if (!pic) return;
        pic.insertBefore(mark, pic.firstChild);
        box.replaceWith(pic);
        return;
      }
      // a formula: everything in its element but the mark
      for (const n of Array.from(box.childNodes)) if (n !== mark) n.remove();
      mark.insertAdjacentHTML('beforebegin', html);
    }

    /** Uses of each parameter in the page: { marks, values } (.tg-live marks, .tg-value spans). */
    function uses() {
      const marks = Array.from(doc.querySelectorAll('.tg-live[data-tg-params]')).filter((m) => m.parentElement && !m.closest('.tg-params'));
      const texts = Array.from(doc.querySelectorAll('.tg-value[data-tg-param]'));
      return { marks, texts };
    }

    function setValue(name, v, from) {
      const def = defs.get(name);
      if (!def) return;
      const val = format(Math.min(def.max, Math.max(def.min, +v)), def.step);
      if (val === def.start) values.delete(name); else values.set(name, val);
      for (const input of doc.querySelectorAll(`.tg-slider input[data-param="${CSS.escape(name)}"]`)) {
        if (input !== from) input.value = val;
        const out = input.parentElement.querySelector('output');
        if (out) out.textContent = val;
      }
      for (const span of doc.querySelectorAll(`.tg-value[data-tg-param="${CSS.escape(name)}"]`)) span.textContent = val;
      for (const m of uses().marks) if (m.dataset.tgParams.split(/\s+/).includes(name)) redraw(m);
      showResets();
    }

    function showResets() {
      for (const row of doc.querySelectorAll('.tg-sliders')) {
        const btn = row.querySelector('.tg-sliders-reset');
        const moved = Array.from(row.querySelectorAll('input[data-param]')).some((i) => values.has(i.dataset.param));
        if (btn) btn.hidden = !moved;
      }
    }

    function sliderRow(names) {
      const row = document.createElement('span');
      row.className = 'tg-sliders';
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', 'Parameters');
      row.contentEditable = 'false';
      for (const name of names) {
        const def = defs.get(name);
        const label = document.createElement('label');
        label.className = 'tg-slider';
        const nm = document.createElement('span');
        nm.className = 'tg-slider-name';
        nm.innerHTML = def.label;
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(def.min);
        input.max = String(def.max);
        input.step = def.step;
        input.value = valueOf(name);
        input.dataset.param = name;
        input.setAttribute('aria-label', `Value of ${name}`);
        input.title = `Drag to change ${name} (from ${def.min} to ${def.max})`;
        input.addEventListener('input', () => setValue(name, input.value, input));
        const out = document.createElement('output');
        out.textContent = valueOf(name);
        label.append(nm, document.createTextNode(' = '), input, out);
        row.append(label);
      }
      const reset = document.createElement('button');
      reset.type = 'button';
      reset.className = 'tg-sliders-reset';
      reset.textContent = 'Reset';
      reset.title = 'Back to the values the paper gives';
      reset.addEventListener('click', () => {
        for (const name of names) setValue(name, defs.get(name).start);
        reset.hidden = true;
      });
      row.append(reset);
      return row;
    }

    /** Read the page again: new parameters, new uses, rows of sliders by them. */
    function refresh() {
      defs = readDefs(doc);
      for (const name of Array.from(values.keys())) if (!defs.has(name)) values.delete(name);
      for (const row of doc.querySelectorAll('.tg-sliders')) row.remove();
      if (!defs.size) return;
      const { marks, texts } = uses();
      // group the uses by the block their row goes with, in page order
      const rows = new Map(); // host -> { inside, names: Set }
      const add = (el, names) => {
        const p = rowPlace(el);
        const r = rows.get(p.host) || { inside: p.inside, names: new Set() };
        for (const n of names) if (defs.has(n)) r.names.add(n);
        rows.set(p.host, r);
      };
      for (const m of marks) add(m.parentElement, m.dataset.tgParams.split(/\s+/));
      for (const t of texts) add(t, [t.dataset.tgParam]);
      const order = Array.from(defs.keys());
      for (const [host, r] of rows) {
        if (!r.names.size) continue;
        const row = sliderRow(order.filter((n) => r.names.has(n)));
        if (r.inside) host.append(row);
        else host.after(row);
      }
      // values moved before this render: show them in the new page too
      for (const t of texts) if (values.has(t.dataset.tgParam)) t.textContent = values.get(t.dataset.tgParam);
      for (const m of marks) if (m.dataset.tgParams.split(/\s+/).some((n) => values.has(n))) redraw(m);
      showResets();
    }

    function reset() {
      for (const name of Array.from(values.keys())) setValue(name, defs.get(name).start);
    }

    refresh();
    return { refresh, reset, values: allValues };
  }

  return { attach, format, decimals };
});
