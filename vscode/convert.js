/*
 * Convert LaTeX to the preview's HTML blocks with KaTeX math. Runs in the
 * worker thread on the desktop (render-worker.js) and in the extension host
 * itself in the browser (github.dev, vscode.dev), which is a web worker there.
 *
 * job: { text, dir, base } for a document on disk: dir is its folder (for
 * figures) and base the webview URL of that folder; or { text, figures } with
 * figures mapping each \includegraphics name to a URL, found beforehand.
 * With job.plain set (Export to HTML) the result is one piece of HTML in
 * result.html, without the source ranges the preview needs; base may then be
 * a relative path ('.' for the same folder).
 * job: { snippets: [tex], defs } renders small formulas with a document's
 * macros (render(...).defs) into result.html, one piece per formula.
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
    (rel) => {
      const url = job.base + '/' + rel.split('/').map(encodeURIComponent).join('/');
      if (!/\.(pdf|eps|ps)$/i.test(rel)) return url;
      // the preview keeps a drawing per URL: a new one when the file changes
      try {
        return url + '?v=' + Math.round(fs.statSync(path.join(job.dir, rel)).mtimeMs);
      } catch (e) {
        return url;
      }
    }
  );
}

const renderMath = (tex, displayMode, macros) =>
  katex.renderToString(tex, { displayMode, macros, throwOnError: false, strict: 'ignore' });

function convert(job) {
  // Small formulas with the document's macros, for the notation index (job.snippets, job.defs).
  if (job.snippets) return { html: TeXglass.renderSnippets(job.defs, job.snippets, { renderMath }) };
  const result = TeXglass.render(job.text, {
    sourceMap: !job.plain,
    renderMath,
    resolveImage: resolverFor(job),
  });
  if (job.plain) return { html: result.html, title: result.title, toc: result.toc, warnings: result.warnings };
  delete result.html; // the blocks carry the same HTML
  return result;
}

module.exports = { convert };
