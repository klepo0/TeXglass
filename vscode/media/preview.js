/*
 * The TeXdown preview inside VS Code. It receives the rendered blocks from the
 * extension, keeps the DOM of blocks that did not change, and reports where
 * it is scrolled to (as a source line) so the editor can follow, and back.
 */
/* global acquireVsCodeApi */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const preview = document.getElementById('preview');
  const pane = document.getElementById('preview-pane');
  const popover = document.getElementById('ref-popover');
  const status = document.getElementById('status');

  // --- theme ---------------------------------------------------------------------

  // Follow VS Code's colour theme rather than the system one.
  const applyTheme = () => {
    const dark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
    document.documentElement.dataset.theme = dark && !document.body.classList.contains('vscode-high-contrast-light') ? 'dark' : 'light';
  };
  applyTheme();
  new MutationObserver(applyTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // --- showing blocks ----------------------------------------------------------------

  let shown = []; // [{ html, nodes, line, end }] in document order

  const BLOCK_HEAD = /^<div class="src-block" data-s="\d+" data-e="\d+">/;
  const bodyOf = (html) => html.replace(BLOCK_HEAD, '');

  function toEntries(blocks, lines) {
    if (!blocks.length) return [];
    const tpl = document.createElement('template');
    tpl.innerHTML = blocks.join('<!--b-->');
    const entries = blocks.map((html, k) => ({ html, nodes: [], range: lines[k] }));
    let k = 0;
    for (const node of Array.from(tpl.content.childNodes)) {
      if (node.nodeType === 8 && node.data === 'b') k++;
      else entries[k].nodes.push(node);
    }
    return entries;
  }

  function show(blocks, lines) {
    if (!blocks.length) {
      blocks = ['<p class="empty-doc">This document is empty.</p>'];
      lines = [null];
    }
    const old = shown;
    const same = (entry, html) => entry.html === html || bodyOf(entry.html) === bodyOf(html);
    let p = 0;
    while (p < old.length && p < blocks.length && same(old[p], blocks[p])) p++;
    let q = 0;
    while (q < old.length - p && q < blocks.length - p && same(old[old.length - 1 - q], blocks[blocks.length - 1 - q])) q++;
    const keep = (entry, k) => {
      entry.html = blocks[k];
      entry.range = lines[k];
      return entry;
    };
    for (let k = 0; k < p; k++) keep(old[k], k);
    for (let k = 1; k <= q; k++) keep(old[old.length - k], blocks.length - k);
    for (const entry of old.slice(p, old.length - q)) entry.nodes.forEach((n) => n.remove());
    const fresh = toEntries(blocks.slice(p, blocks.length - q), lines.slice(p, blocks.length - q));
    const tail = old.slice(old.length - q);
    const ref = tail.length && tail[0].nodes.length ? tail[0].nodes[0] : null;
    for (const entry of fresh) entry.nodes.forEach((n) => preview.insertBefore(n, ref));
    shown = old.slice(0, p).concat(fresh, tail);
    // Blocks with a source range, for scrolling in step with the editor.
    anchors = shown.filter((e) => e.range && e.nodes[0] && e.nodes[0].nodeType === 1).map((e) => ({ el: e.nodes[0], line: e.range[0], end: e.range[1] }));
  }

  // --- scrolling in step with the editor -------------------------------------------

  let anchors = [];
  let ignoreScrollUntil = 0;

  const topOf = (el) => el.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;

  /** Scroll so that source line `line` is at the top. */
  function scrollToLine(line) {
    if (!anchors.length) return;
    let lo = 0;
    let hi = anchors.length - 1;
    if (line < anchors[0].line) {
      pane.scrollTop = 0;
    } else {
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (anchors[mid].line <= line) lo = mid;
        else hi = mid - 1;
      }
      const a = anchors[lo];
      const next = anchors[lo + 1];
      const top = topOf(a.el);
      let y = top;
      if (line > a.end && next) {
        // Between two blocks: interpolate across the gap.
        const t = (line - a.end) / Math.max(1, next.line - a.end);
        y = top + a.el.offsetHeight + t * (topOf(next.el) - top - a.el.offsetHeight);
      } else {
        y = top + ((line - a.line) / Math.max(1, a.end - a.line + 1)) * a.el.offsetHeight;
      }
      pane.scrollTop = Math.max(0, y - 8);
    }
    ignoreScrollUntil = Date.now() + 200;
  }

  /** The source line at the top of the preview. */
  function lineAtTop() {
    if (!anchors.length) return 0;
    const y = pane.scrollTop + 8;
    let lo = 0;
    let hi = anchors.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (topOf(anchors[mid].el) <= y) lo = mid;
      else hi = mid - 1;
    }
    const a = anchors[lo];
    const h = a.el.offsetHeight || 1;
    const t = Math.max(0, Math.min(1, (y - topOf(a.el)) / h));
    return a.line + t * (a.end - a.line + 1);
  }

  let scrollFrame = 0;
  pane.addEventListener('scroll', () => {
    if (Date.now() < ignoreScrollUntil || scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      vscode.postMessage({ type: 'scroll', line: lineAtTop() });
    });
  }, { passive: true });

  // Double-click a block to go to its source, like the Markdown preview.
  preview.addEventListener('dblclick', (e) => {
    if (e.target.closest('a')) return;
    const anchor = anchors.find((a) => a.el.contains(e.target));
    if (!anchor) return;
    const r = anchor.el.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientY - r.top) / (r.height || 1)));
    vscode.postMessage({ type: 'reveal', line: Math.round(anchor.line + t * (anchor.end - anchor.line)) });
  });

  // --- links and reference previews -----------------------------------------------------

  preview.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    e.preventDefault();
    if (!href.startsWith('#')) {
      vscode.postMessage({ type: 'open-link', href });
      return;
    }
    const target = document.getElementById(decodeURIComponent(href.slice(1)));
    if (!target) return;
    popover.hidden = true;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  });

  let hideTimer = null;
  preview.addEventListener('mouseover', (e) => {
    const a = e.target.closest('a.ref, .cite a');
    if (!a) return;
    const target = document.getElementById(a.getAttribute('href').slice(1));
    if (!target || target.contains(a)) return;
    clearTimeout(hideTimer);
    popover.innerHTML = '';
    let node = target;
    if (node.classList.contains('caption') && node.parentElement.tagName === 'FIGURE') node = node.parentElement;
    if (/^H[1-6]$/.test(node.tagName)) {
      const p = document.createElement('p');
      const b = document.createElement('strong');
      b.innerHTML = node.innerHTML;
      p.appendChild(b);
      popover.appendChild(p);
    } else {
      const clone = node.cloneNode(true);
      clone.removeAttribute('id');
      clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
      popover.appendChild(clone);
    }
    popover.hidden = false;
    const r = a.getBoundingClientRect();
    const width = Math.min(560, window.innerWidth - 32);
    popover.style.width = width + 'px';
    popover.style.left = Math.max(16, Math.min(r.left, window.innerWidth - width - 16)) + 'px';
    const h = popover.offsetHeight;
    popover.style.top = (r.bottom + 8 + h > window.innerHeight && r.top - h - 8 > 0 ? r.top - h - 8 : r.bottom + 8) + 'px';
  });
  preview.addEventListener('mouseout', (e) => {
    if (!e.target.closest('a.ref, .cite a')) return;
    hideTimer = setTimeout(() => { popover.hidden = true; }, 120);
  });

  // --- messages from the extension ----------------------------------------------------

  function setStatus(text) {
    status.textContent = text || '';
    status.hidden = !text;
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    switch (m.type) {
      case 'doc':
        if ((vscode.getState() || {}).uri !== m.uri) {
          shown = [];
          anchors = [];
          preview.replaceChildren();
        }
        vscode.setState({ uri: m.uri });
        break;
      case 'render': {
        show(m.blocks, m.lines);
        const n = m.warnings.length;
        setStatus(n ? `${n} warning${n > 1 ? 's' : ''}` : '');
        status.title = m.warnings.join('\n');
        vscode.postMessage({ type: 'shown', blocks: shown.length, math: preview.querySelectorAll('.katex').length });
        break;
      }
      case 'error':
        shown = [];
        anchors = [];
        preview.replaceChildren();
        preview.insertAdjacentHTML('beforeend', '<pre class="render-error"></pre>');
        preview.firstChild.textContent = m.text;
        setStatus('Render failed');
        break;
      case 'status':
        setStatus(m.text);
        break;
      case 'scroll-to':
        scrollToLine(m.line);
        break;
      default:
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
