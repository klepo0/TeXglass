/*
 * TeXglass for Overleaf: the preview panel on Overleaf project pages.
 *
 * Adds a panel on the right of the page holding the extension's
 * overleaf.html, which renders the file open in Overleaf's editor as you
 * type. The editor's text comes from overleaf-page.js, which runs in the
 * page itself; this script only makes the panel, opens and closes it, and
 * lets the reader resize it.
 *
 * Open or close it with the "TeXglass" tab on the right edge of the page,
 * the toolbar button, or Alt+Shift+K. The page is narrowed to make room, so
 * Overleaf's editor and PDF stay visible beside it.
 */
(function () {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  if (document.documentElement.dataset.texglassOverleaf || !/^\/project\/[0-9a-f]{8,}\/?$/i.test(location.pathname)) return;
  document.documentElement.dataset.texglassOverleaf = '1';

  const TAG = 'texglass-overleaf';
  const FRAME_ID = 'texglass-overleaf-frame';
  const MIN = 260;
  const store = (api.storage && api.storage.local) || null;

  let panel = null;
  let frame = null;
  let tab = null;
  let width = Math.round(Math.min(560, window.innerWidth * 0.4));
  let open = false;

  const clampWidth = (w) => Math.round(Math.max(MIN, Math.min(window.innerWidth - 320, w)));

  function setWidth(w) {
    width = clampWidth(w);
    document.documentElement.style.setProperty('--texglass-ol-w', width + 'px');
  }

  function build() {
    panel = document.createElement('div');
    panel.id = 'texglass-overleaf-panel';
    panel.setAttribute('role', 'complementary');
    panel.setAttribute('aria-label', 'TeXglass preview');

    const grip = document.createElement('div');
    grip.className = 'texglass-ol-grip';
    grip.title = 'Drag to resize the TeXglass preview';
    grip.addEventListener('pointerdown', startResize);
    grip.addEventListener('dblclick', () => { setWidth(window.innerWidth * 0.4); remember(); relayout(); });

    frame = document.createElement('iframe');
    frame.id = FRAME_ID;
    frame.title = 'TeXglass preview';
    frame.src = api.runtime.getURL('overleaf.html');
    frame.dataset.open = '0';

    panel.append(grip, frame);
    // Beside <body>, not in it: the page is narrowed by narrowing <body> (see overleaf.css).
    document.documentElement.appendChild(panel);
  }

  function makeTab() {
    tab = document.createElement('button');
    tab.type = 'button';
    tab.id = 'texglass-overleaf-tab';
    tab.textContent = 'TeXglass';
    tab.title = 'Show a live TeXglass preview of the open file (Alt+Shift+K)';
    tab.addEventListener('click', () => setOpen(true));
    document.documentElement.appendChild(tab);
  }

  /** Overleaf lays out its panes when the window resizes; tell it the room it has changed. */
  function relayout() {
    window.dispatchEvent(new Event('resize'));
  }

  function remember() {
    try {
      if (store) store.set({ overleafOpen: open, overleafWidth: width });
    } catch (e) { /* the extension was updated since this page loaded */ }
  }

  function setOpen(on) {
    open = !!on;
    if (open && !panel) build();
    if (panel) panel.hidden = !open;
    if (frame) frame.dataset.open = open ? '1' : '0';
    if (tab) tab.hidden = open;
    document.documentElement.classList.toggle('texglass-ol-open', open);
    remember();
    relayout();
  }

  function startResize(e) {
    e.preventDefault();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    document.documentElement.classList.add('texglass-ol-resizing');
    const move = (ev) => setWidth(window.innerWidth - ev.clientX);
    const up = () => {
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      document.documentElement.classList.remove('texglass-ol-resizing');
      remember();
      relayout();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  }

  // The preview's close button.
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!frame || e.source !== frame.contentWindow || !d || d.texglass !== TAG) return;
    if (d.type === 'close') setOpen(false);
  });

  // The toolbar button and its keyboard shortcut.
  try {
    api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === 'texglass-overleaf-toggle') {
        setOpen(!open);
        sendResponse({ open });
      }
      return false;
    });
  } catch (e) { /* no runtime: nothing to listen to */ }

  window.addEventListener('resize', () => {
    if (open && clampWidth(width) !== width) setWidth(width);
  });

  function start() {
    makeTab();
    const begin = (saved) => {
      saved = saved || {};
      setWidth(saved.overleafWidth || width);
      if (saved.overleafOpen) setOpen(true);
      else tab.hidden = false;
    };
    try {
      if (store) {
        store.get({ overleafOpen: false, overleafWidth: 0 }).then(begin, () => begin(null));
      } else begin(null);
    } catch (e) {
      begin(null);
    }
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
})();
