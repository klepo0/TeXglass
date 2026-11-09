/* TeXdown viewer: file opening, live reload, editing and reference previews. */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const preview = $('preview');
  const source = $('source');
  const sourcePane = $('source-pane');
  const status = $('status');
  const fileName = $('file-name');
  const popover = $('ref-popover');

  let fileHandle = null; // File System Access handle, for live reload
  let lastModified = 0;
  let renderTimer = null;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
  };

  // --- rendering -------------------------------------------------------------

  function render(text) {
    const scroll = preview.parentElement.scrollTop;
    let result;
    try {
      result = TeXdown.render(text);
    } catch (e) {
      preview.innerHTML = `<pre class="render-error">${TeXdown.escapeHtml(e.stack || String(e))}</pre>`;
      status.textContent = 'Render failed';
      return;
    }
    preview.innerHTML = result.html;
    preview.parentElement.scrollTop = scroll;
    document.title = result.title ? `${result.title} — TeXdown` : 'TeXdown';
    const n = result.warnings.length;
    status.textContent = n ? `${n} warning${n > 1 ? 's' : ''}` : '';
    status.title = result.warnings.join('\n');
    status.classList.toggle('warn', n > 0);
  }

  function load(text, name) {
    source.value = text;
    fileName.textContent = name || '';
    render(text);
    store.set('texdown:last', text);
    store.set('texdown:last-name', name || '');
  }

  // --- opening files ---------------------------------------------------------

  async function openWithPicker() {
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: 'LaTeX', accept: { 'text/x-tex': ['.tex', '.ltx', '.latex'] } }],
        });
        await openHandle(handle);
      } catch (e) {
        if (e.name !== 'AbortError') console.error(e);
      }
    } else {
      $('file-input').click();
    }
  }

  async function openHandle(handle) {
    fileHandle = handle;
    const file = await handle.getFile();
    lastModified = file.lastModified;
    load(await file.text(), file.name);
    status.textContent = 'Watching for changes';
  }

  async function openFile(file) {
    fileHandle = null;
    load(await file.text(), file.name);
  }

  // Re-render when the file changes on disk (browsers with the File System Access API).
  setInterval(async () => {
    if (!fileHandle || document.hidden) return;
    try {
      const file = await fileHandle.getFile();
      if (file.lastModified !== lastModified) {
        lastModified = file.lastModified;
        const text = await file.text();
        source.value = text;
        render(text);
        store.set('texdown:last', text);
      }
    } catch (e) {
      fileHandle = null;
    }
  }, 1000);

  $('open').addEventListener('click', openWithPicker);
  $('file-input').addEventListener('change', (e) => {
    if (e.target.files[0]) openFile(e.target.files[0]);
    e.target.value = '';
  });

  // Drag and drop.
  const overlay = $('drop-overlay');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; overlay.hidden = false; });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; overlay.hidden = true; } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    const item = e.dataTransfer.items && e.dataTransfer.items[0];
    if (item && item.getAsFileSystemHandle) {
      try {
        const handle = await item.getAsFileSystemHandle();
        if (handle && handle.kind === 'file') return openHandle(handle);
      } catch (err) { /* fall back to a plain file */ }
    }
    const file = e.dataTransfer.files[0];
    if (file) openFile(file);
  });

  // --- editing ---------------------------------------------------------------

  function toggleSource() {
    const show = sourcePane.hidden;
    sourcePane.hidden = !show;
    $('toggle-source').setAttribute('aria-pressed', String(show));
    document.body.classList.toggle('editing', show);
    store.set('texdown:editing', show ? '1' : '');
    if (show) source.focus();
  }

  $('toggle-source').addEventListener('click', toggleSource);
  source.addEventListener('input', () => {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(() => {
      render(source.value);
      store.set('texdown:last', source.value);
    }, 150);
  });
  source.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      source.setRangeText('  ', source.selectionStart, source.selectionEnd, 'end');
      source.dispatchEvent(new Event('input'));
    }
  });

  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openWithPicker(); }
    if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); toggleSource(); }
  });

  // --- reference previews ----------------------------------------------------

  let hideTimer = null;
  preview.addEventListener('mouseover', (e) => {
    const a = e.target.closest('a.ref, .cite a');
    if (!a) return;
    const id = a.getAttribute('href').slice(1);
    const target = document.getElementById(id);
    if (!target || target.contains(a)) return;
    clearTimeout(hideTimer);
    popover.innerHTML = '';
    let node = target;
    if (node.classList.contains('caption') && node.parentElement.tagName === 'FIGURE') node = node.parentElement;
    if (/^H[1-6]$/.test(node.tagName)) {
      popover.innerHTML = `<p><strong>${node.innerHTML}</strong></p>`;
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
    const below = r.bottom + 8;
    const h = popover.offsetHeight;
    popover.style.top = (below + h > window.innerHeight && r.top - h - 8 > 0 ? r.top - h - 8 : below) + 'px';
  });
  preview.addEventListener('mouseout', (e) => {
    if (!e.target.closest('a.ref, .cite a')) return;
    hideTimer = setTimeout(() => { popover.hidden = true; }, 120);
  });
  preview.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    const target = document.getElementById(a.getAttribute('href').slice(1));
    if (!target) return;
    e.preventDefault();
    popover.hidden = true;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.remove('flash');
    void target.offsetWidth;
    target.classList.add('flash');
  });

  // --- start -----------------------------------------------------------------

  async function loadSample() {
    fileHandle = null;
    try {
      const res = await fetch('examples/sample.tex');
      if (!res.ok) throw new Error(res.statusText);
      load(await res.text(), 'sample.tex');
    } catch (e) {
      load(
        '\\section*{Welcome to \\TeX down}\nOpen a \\texttt{.tex} file with the button above, or drop one on this page.\n' +
          'Math such as $\\int_0^1 x^2\\,dx = \\tfrac13$ is rendered with KaTeX.',
        ''
      );
    }
  }

  $('load-sample').addEventListener('click', loadSample);

  function start() {
    if (store.get('texdown:editing')) toggleSource();
    const last = store.get('texdown:last');
    if (last) return load(last, store.get('texdown:last-name'));
    return loadSample();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
