/*
 * PDF figures as images.
 *
 * Browsers cannot show a PDF in an <img>, and most papers built with pdflatex
 * have their figures as .pdf files. This draws the first page of such a file
 * with pdf.js (vendor/pdfjs, loaded only when a paper has PDF figures) and
 * returns it as an SVG image of the figure's own size that holds the drawing,
 * rendered at twice that size so it stays sharp.
 *
 *   TeXglassPdf.isPdf(blob)          is this a PDF (by type or by its first bytes)?
 *   await TeXglassPdf.toImage(blob)  an image/svg+xml Blob, or null if it cannot be drawn
 *
 * Works in browser pages (the web viewer and the browser extension).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(null);
  else root.TeXglassPdf = factory(typeof document !== 'undefined' && document.currentScript ? document.currentScript.src : null);
})(typeof self !== 'undefined' ? self : this, function (scriptUrl) {
  'use strict';

  // vendor/pdfjs next to src/, wherever the viewer is served from.
  const VENDOR = scriptUrl ? new URL('../vendor/pdfjs/', scriptUrl).href : null;
  const MAX_SIDE = 3000; // pixels; a poster-sized figure is drawn smaller
  const SHARPNESS = 2; // pixels per CSS pixel

  let lib = null;
  function load() {
    if (!lib) {
      lib = import(VENDOR + 'pdf.min.js').then(async (m) => {
        const worker = VENDOR + 'pdf.worker.min.js';
        if (typeof location !== 'undefined' && new URL(worker).origin !== location.origin) {
          // A page may not start a worker from another origin (VS Code serves the
          // extension's files from one): start it from a copy of its code instead.
          try {
            const code = await (await fetch(worker)).blob();
            m.GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })), { type: 'module' });
            return m;
          } catch (e) { /* pdf.js then runs without a worker */ }
        }
        m.GlobalWorkerOptions.workerSrc = worker;
        return m;
      });
      lib.catch(() => { lib = null; });
    }
    return lib;
  }

  function isPdf(blob) {
    return !!blob && /pdf/i.test(blob.type || '');
  }

  /** "%PDF" at the start of the bytes (arXiv sometimes sends figures with no type). */
  function looksLikePdf(bytes) {
    return bytes && bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  }

  function dataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  }

  /** The SVG image around a picture of `width` × `height` points. */
  function svgAround(png, width, height) {
    const w = +width.toFixed(2);
    const h = +height.toFixed(2);
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}pt" height="${h}pt" viewBox="0 0 ${w} ${h}">` +
      `<image width="${w}" height="${h}" href="${png}"/></svg>`;
  }

  async function toImage(blob) {
    if (!VENDOR) return null;
    const pdfjs = await load();
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(await blob.arrayBuffer()),
      isEvalSupported: false, // extension pages refuse eval, and fonts do not need it
      disableFontFace: false,
      verbosity: 0,
    }).promise;
    try {
      const page = await doc.getPage(1);
      const size = page.getViewport({ scale: 1 }); // points
      if (!size.width || !size.height) return null;
      const scale = Math.min(SHARPNESS * 96 / 72, MAX_SIDE / Math.max(size.width, size.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width));
      canvas.height = Math.max(1, Math.ceil(viewport.height));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const png = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!png) return null;
      return new Blob([svgAround(await dataUrl(png), size.width, size.height)], { type: 'image/svg+xml' });
    } finally {
      doc.destroy();
    }
  }

  return { isPdf, looksLikePdf, toImage, svgAround };
});
