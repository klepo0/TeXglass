/*
 * Runs TeXglass.render off the main thread, so the page stays responsive while
 * a long document (hundreds of pages, tens of thousands of formulas) converts.
 *
 * The page sends { katex: url } once, then { id, source, images } for each
 * render; images is an optional { path: objectURL } map from an arXiv import.
 * Replies are { id, result } or { id, error }.
 */
/* global importScripts, TeXglass, TeXglassArxiv */
'use strict';

let ready = false;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.katex) {
    try {
      importScripts(msg.katex, 'texglass.js', 'arxiv.js');
      ready = true;
      self.postMessage({ ready: true });
    } catch (err) {
      self.postMessage({ ready: false, error: String(err && err.message ? err.message : err) });
    }
    return;
  }
  if (!ready) {
    self.postMessage({ id: msg.id, error: 'not ready' });
    return;
  }
  try {
    const resolveImage = msg.images ? TeXglassArxiv.imageResolver(msg.images, msg.source) : undefined;
    const result = TeXglass.render(msg.source, { sourceMap: true, resolveImage });
    // `html` is just the blocks joined; leave it out to halve what gets copied back.
    delete result.html;
    self.postMessage({ id: msg.id, result });
  } catch (err) {
    self.postMessage({ id: msg.id, error: (err && err.stack) || String(err) });
  }
};
