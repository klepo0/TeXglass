/*
 * Converts LaTeX to HTML in a worker thread, so that a long document (hundreds
 * of pages take a couple of seconds) never stalls the extension host.
 *
 * In:  { id, text, dir, base }  text is the source, dir the folder of the file
 *      on disk (for figures), base the webview URL of that folder.
 * Out: { id, result } or { id, error }
 */
'use strict';
const { parentPort } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const katex = require('katex');
const TeXdown = require('./shared/texdown.js');

const IMAGE_EXTS = ['', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp'];

/** Find a figure next to the document, trying the extensions LaTeX would. */
function imageResolver(text, dir, base) {
  if (!dir || !base) return () => null;
  const dirs = [''];
  const gp = /\\graphicspath\s*\{((?:\s*\{[^}]*\})+)\s*\}/.exec(text);
  if (gp) for (const m of gp[1].matchAll(/\{([^}]*)\}/g)) dirs.push(m[1].replace(/\/?$/, '/'));
  return (name) => {
    const clean = name.trim().replace(/^\.\//, '');
    for (const d of dirs) {
      const rel = path.posix.normalize(d + clean);
      if (rel.startsWith('../') || path.isAbsolute(rel)) continue;
      const noExt = rel.replace(/\.(pdf|eps|ps)$/i, '');
      // A .pdf or .eps figure cannot be shown; a .png of the same name often exists.
      for (const stem of noExt === rel ? [rel] : [rel, noExt]) {
        for (const ext of IMAGE_EXTS) {
          const p = stem + ext;
          if (/\.(pdf|eps|ps)$/i.test(p)) continue;
          try {
            if (fs.statSync(path.join(dir, p)).isFile()) return base + '/' + p.split('/').map(encodeURIComponent).join('/');
          } catch (e) {
            /* not there */
          }
        }
      }
    }
    return null;
  };
}

parentPort.on('message', ({ id, text, dir, base }) => {
  try {
    const result = TeXdown.render(text, {
      sourceMap: true,
      renderMath: (tex, displayMode, macros) =>
        katex.renderToString(tex, { displayMode, macros, throwOnError: false, strict: 'ignore' }),
      resolveImage: imageResolver(text, dir, base),
    });
    delete result.html; // the blocks carry the same HTML
    parentPort.postMessage({ id, result });
  } catch (e) {
    parentPort.postMessage({ id, error: (e && e.stack) || String(e) });
  }
});
