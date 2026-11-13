/*
 * Convert LaTeX to the preview's HTML blocks with KaTeX math. Runs in the
 * worker thread on the desktop (render-worker.js) and in the extension host
 * itself in the browser (github.dev, vscode.dev), which is a web worker there.
 *
 * job: { text, dir, base } for a document on disk: dir is its folder (for
 * figures) and base the webview URL of that folder; or { text, figures } with
 * figures mapping each \includegraphics name to a URL, found beforehand.
 */
'use strict';
const katex = require('katex');
const TeXglass = require('./shared/texglass.js');
const { imageResolver } = require('./images.js');

function resolverFor(job) {
  if (job.figures) return (name) => job.figures[name] || null;
  if (!job.dir || !job.base) return () => null;
  const fs = require('fs');
  const path = require('path');
  return imageResolver(
    job.text,
    (rel) => {
      try {
        return fs.statSync(path.join(job.dir, rel)).isFile();
      } catch (e) {
        return false;
      }
    },
    (rel) => job.base + '/' + rel.split('/').map(encodeURIComponent).join('/')
  );
}

function convert(job) {
  const result = TeXglass.render(job.text, {
    sourceMap: true,
    renderMath: (tex, displayMode, macros) =>
      katex.renderToString(tex, { displayMode, macros, throwOnError: false, strict: 'ignore' }),
    resolveImage: resolverFor(job),
  });
  delete result.html; // the blocks carry the same HTML
  return result;
}

module.exports = { convert };
