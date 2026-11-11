/*
 * Find the image file for an \includegraphics, the way LaTeX would: relative
 * to the document's folder and the \graphicspath folders, trying the usual
 * extensions. A .pdf or .eps figure cannot be shown in the preview, but a
 * .png of the same name often exists, so that is tried too.
 */
'use strict';

const IMAGE_EXTS = ['', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp'];

/** Normalize a relative path with "/" separators; null if it leaves the folder. */
function normalize(p) {
  if (p.startsWith('/') || /^[a-z]:/i.test(p)) return null;
  const out = [];
  for (const part of p.split('/')) {
    if (part === '..') {
      if (!out.length) return null;
      out.pop();
    } else if (part && part !== '.') out.push(part);
  }
  return out.join('/');
}

/**
 * A resolveImage function for TeXdown.render: name -> URL or null.
 * exists(rel) says whether the file at that path relative to the document's
 * folder exists; url(rel) is where the preview can load it.
 */
function imageResolver(text, exists, url) {
  const dirs = [''];
  const gp = /\\graphicspath\s*\{((?:\s*\{[^}]*\})+)\s*\}/.exec(text);
  if (gp) for (const m of gp[1].matchAll(/\{([^}]*)\}/g)) dirs.push(m[1].replace(/\/?$/, '/'));
  return (name) => {
    const clean = name.trim().replace(/^\.\//, '');
    for (const d of dirs) {
      const rel = normalize(d + clean);
      if (!rel) continue;
      const noExt = rel.replace(/\.(pdf|eps|ps)$/i, '');
      for (const stem of noExt === rel ? [rel] : [rel, noExt]) {
        for (const ext of IMAGE_EXTS) {
          const p = stem + ext;
          if (/\.(pdf|eps|ps)$/i.test(p)) continue;
          if (exists(p)) return url(p);
        }
      }
    }
    return null;
  };
}

/** The names given to \includegraphics in a text, outside comments. */
function figureNames(text) {
  const names = new Set();
  const re = /(?<!\\)%.*$|\\includegraphics\*?\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/gm;
  for (const m of text.matchAll(re)) if (m[1]) names.add(m[1]);
  return Array.from(names);
}

module.exports = { imageResolver, figureNames, normalize };
