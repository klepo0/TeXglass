#!/usr/bin/env node
/*
 * Builds the TeXglass for arXiv browser extension.
 *
 *   node browser/build.js
 *
 * writes two unpacked extensions and their zip files:
 *   browser/dist/chrome/   and browser/dist/texglass-arxiv-chrome-<version>.zip   (Chrome, Edge)
 *   browser/dist/firefox/  and browser/dist/texglass-arxiv-firefox-<version>.zip  (Firefox)
 *
 * The version is the VS Code extension's (vscode/package.json): one number for
 * the whole release, bumped only by the Release workflow. A plain build is a dev
 * build, labelled <version>-dev.<commit> so it can't be mistaken for the release;
 * the Release workflow passes --release for the clean name.
 *
 * Each one bundles a copy of the web viewer (index.html, app.js, styles.css,
 * src/*.js) with KaTeX from node_modules, so `npm install` must have run.
 * The two builds differ only in the manifest: Chrome runs the background
 * script as a service worker, Firefox as an event page.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(__dirname, 'src');
const DIST = path.join(__dirname, 'dist');
const KATEX = path.join(ROOT, 'vendor', 'katex');
const VERSION = require('../vscode/package.json').version;
const RELEASE = process.argv.includes('--release');

/** The commit this build comes from, for dev build names ("local" outside git). */
function commit() {
  try {
    return require('child_process').execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'local';
  }
}

/** The name a build goes by: the version for a release, <version>-dev.<commit> otherwise. */
const LABEL = RELEASE ? VERSION : `${VERSION}-dev.${commit()}`;

/** The default keyboard shortcut for the toolbar button; people can change it in the browser. */
const SHORTCUT = 'Alt+Shift+K';

/** Other sites with arXiv papers, where sites.js adds a "View in TeXglass" button. */
const SITE_MATCHES = [
  'https://alphaxiv.org/*', 'https://*.alphaxiv.org/*',
  'https://hal.science/*', 'https://*.hal.science/*', 'https://*.archives-ouvertes.fr/*', 'https://hal.inrae.fr/*',
  'https://www.researchgate.net/publication/*',
];

/** .tex files opened in the browser (Chrome and Edge, with "Allow access to file URLs"), which file-tex.js shows in TeXglass. */
const FILE_MATCHES = ['file:///*.tex', 'file:///*.ltx', 'file:///*.latex'];

/** Overleaf project pages, where overleaf.js adds a live preview of the open file. */
const OVERLEAF_MATCHES = ['https://overleaf.com/project/*', 'https://*.overleaf.com/project/*'];

function manifest(target) {
  const m = {
    manifest_version: 3,
    name: 'TeXglass for arXiv',
    short_name: 'TeXglass',
    version: VERSION,
    description: 'Open arXiv papers in TeXglass: their LaTeX source rendered as a readable page, with math, numbered theorems and working references. Also on alphaXiv, HAL and ResearchGate, a live preview beside the editor on Overleaf, and .tex files on your computer.',
    icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
    action: {
      default_title: 'View this arXiv paper in TeXglass',
      default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
    },
    // The keyboard shortcut does what the toolbar button does. Alt+Shift+K is
    // free in Chrome, Edge and Firefox and matches Ctrl+K inside the viewer
    // (Chromium refuses Alt+Shift+X; it takes Alt+Shift+A, B, I and T itself).
    commands: {
      _execute_action: {
        suggested_key: { default: SHORTCUT },
        description: 'View this paper in TeXglass, or search arXiv',
      },
    },
    permissions: ['activeTab', 'contextMenus', 'storage'],
    // arXiv for the papers and its search API; the HAL API to find the arXiv id of HAL deposits.
    host_permissions: ['https://arxiv.org/*', 'https://*.arxiv.org/*', 'https://api.archives-ouvertes.fr/*'],
    content_scripts: [
      {
        matches: ['https://arxiv.org/*', 'https://*.arxiv.org/*'],
        js: ['content.js'],
        css: ['content.css'],
        run_at: 'document_end',
      },
      {
        matches: SITE_MATCHES,
        js: ['sites.js'],
        css: ['content.css'],
        run_at: 'document_end',
      },
      // On Overleaf, overleaf-page.js runs in the page itself to read the
      // editor (CodeMirror), and overleaf.js adds the preview panel.
      {
        matches: OVERLEAF_MATCHES,
        js: ['overleaf-page.js'],
        run_at: 'document_start',
        world: 'MAIN',
      },
      {
        matches: OVERLEAF_MATCHES,
        js: ['overleaf.js'],
        css: ['overleaf.css'],
        run_at: 'document_idle',
      },
    ],
    // The preview panel is the extension's overleaf.html, framed in Overleaf's page.
    web_accessible_resources: [{ resources: ['overleaf.html'], matches: ['https://overleaf.com/*', 'https://*.overleaf.com/*'] }],
    options_ui: { page: 'options.html', open_in_tab: false },
    homepage_url: 'https://github.com/klepo0/TeXglass',
  };
  if (target === 'firefox') {
    m.background = { scripts: ['src/arxiv.js', 'background.js'] };
    m.browser_specific_settings = { gecko: {
        id: 'texglass-arxiv@klepo0.github.io',
        // 128 runs content scripts in the page's world ("world": "MAIN"), for Overleaf.
        strict_min_version: '128.0',
        // addons.mozilla.org asks every new extension to declare what it collects: nothing here.
        data_collection_permissions: { required: ['none'] },
      },
    };
  } else {
    m.background = { service_worker: 'background.js' };
    // .tex files on this computer: Chrome and Edge let an extension read file:// addresses
    // once the person turns on "Allow access to file URLs" for it (off by default).
    // Firefox never lets extensions read them, so there TeXglass opens files with a picker.
    m.host_permissions.push('file:///*');
    m.content_scripts.push({ matches: FILE_MATCHES, js: ['file-tex.js'], run_at: 'document_start' });
    m.minimum_chrome_version = '111'; // "world": "MAIN" content scripts, for Overleaf
    // Chrome shows version_name on chrome://extensions, so a dev build says which commit it is.
    // (The version itself must stay plain numbers; Firefox has no version_name.)
    if (LABEL !== VERSION) m.version_name = LABEL;
  }
  return m;
}

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(from, to, filter = () => true) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b, filter);
    else if (filter(e.name)) copy(a, b);
  }
}

/** The web viewer's index.html, which loads KaTeX from vendor/katex (bundled below), never a CDN. */
function viewerHtml() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  if (html.includes('cdn.jsdelivr.net')) throw new Error('index.html still loads something from a CDN');
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) throw new Error('index.html has an inline script, which extension pages refuse');
  // The web site's visitor counter stays out of the extension.
  // So do the web app's manifest and home-screen icons (the extension has its own).
  return html
    .replace(/[ \t]*<script[^>]*src="src\/stats\.js"[^>]*><\/script>\n?/, '')
    .replace(/[ \t]*<link rel="(?:manifest|icon|apple-touch-icon)"[^>]*>\n?/g, '');
}

function build(target) {
  const out = path.join(DIST, target);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  // The extension's own files.
  copyDir(SRC, out, (name) => name !== 'icon.svg');
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest(target), null, 2) + '\n');

  // The viewer.
  fs.writeFileSync(path.join(out, 'index.html'), viewerHtml());
  for (const f of ['app.js', 'styles.css', 'LICENSE']) {
    if (fs.existsSync(path.join(ROOT, f))) copy(path.join(ROOT, f), path.join(out, f));
  }
  copyDir(path.join(ROOT, 'src'), path.join(out, 'src'), (name) => name.endsWith('.js') && name !== 'stats.js');
  // The handwritten-notes look, shared with the VS Code extension; the viewer writes in Kalam.
  copy(path.join(ROOT, 'vscode/media/notes.css'), path.join(out, 'vscode/media/notes.css'));
  copy(path.join(ROOT, 'vscode/ink.js'), path.join(out, 'vscode/ink.js'));
  copyDir(path.join(ROOT, 'vscode/media/fonts'), path.join(out, 'vscode/media/fonts'), (name) => /^kalam-|OFL-kalam/.test(name));
  copyDir(KATEX, path.join(out, 'vendor/katex'));
  copyDir(path.join(ROOT, 'vendor/pdfjs'), path.join(out, 'vendor/pdfjs'));

  const zip = path.join(DIST, `texglass-arxiv-${target}-${LABEL}.zip`);
  fs.writeFileSync(zip, zipDir(out));
  return { out, zip };
}

// --- a small zip writer (deflate), so the build needs no zip tool ---------------

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function listFiles(dir, base = '') {
  const files = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) files.push(...listFiles(path.join(dir, e.name), rel));
    else files.push(rel);
  }
  return files;
}

function zipDir(dir) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  // A fixed timestamp (2026-01-01 00:00) keeps the zip byte-identical between builds.
  const time = 0;
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const rel of listFiles(dir)) {
    const data = fs.readFileSync(path.join(dir, rel));
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const name = Buffer.from(rel, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

if (require.main === module) {
  for (const target of ['chrome', 'firefox']) {
    const { out, zip } = build(target);
    console.log(`${target}: ${path.relative(ROOT, out)}/ and ${path.relative(ROOT, zip)}`);
  }
}

module.exports = { build, manifest, viewerHtml, zipDir, VERSION, LABEL, SITE_MATCHES, OVERLEAF_MATCHES, FILE_MATCHES, SHORTCUT };
