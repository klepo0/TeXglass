'use strict';
// The web viewer's Content-Security-Policy (index.html) lets only the site's own
// scripts run, and lets the page talk only to the hosts it really uses. That keeps
// the notes-sync token in localStorage away from anything else.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
const policy = {};
if (meta) {
  for (const part of meta[1].split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) policy[name] = values;
  }
}

// Hosts the code names only in links, pages it opens or files it writes, never fetches.
const LINK_ONLY = new Set([
  'github.com', 'github.dev', 'doi.org', 'klepo0.github.io', 'buymeacoffee.com',
  'www.goatcounter.com', 'cdn.jsdelivr.net', 'www.w3.org',
]);

test('index.html has a Content-Security-Policy', () => {
  assert.ok(meta, 'no Content-Security-Policy meta tag');
  assert.deepStrictEqual(policy['script-src'], ["'self'"], 'only the site’s own scripts may run');
  assert.deepStrictEqual(policy['object-src'], ["'none'"]);
  assert.deepStrictEqual(policy['base-uri'], ["'self'"]);
  assert.ok(!/unsafe-eval/.test(meta[1]), 'no eval');
});

test('every host the viewer fetches from is in connect-src', () => {
  const allowed = new Set(policy['connect-src'] || []);
  const files = ['app.js', ...fs.readdirSync(path.join(ROOT, 'src')).filter((n) => n.endsWith('.js')).map((n) => 'src/' + n)];
  const missing = new Set();
  for (const f of files) {
    if (f === 'src/stats.js') continue; // checked below: its host is built from the site code
    const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of code.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]+)(\/[a-z]*)?/gi)) {
      const host = m[1].toLowerCase();
      if (LINK_ONLY.has(host) || LINK_ONLY.has(host + (m[2] || ''))) continue;
      if (!allowed.has('https://' + host)) missing.add(`${host} (${f})`);
    }
  }
  assert.deepStrictEqual([...missing], [], 'add these to connect-src in index.html, or to LINK_ONLY here if they are only links');
});

test('the visitor counter may reach its GoatCounter site', () => {
  const code = fs.readFileSync(path.join(ROOT, 'src/stats.js'), 'utf8');
  const site = /CODE\s*=\s*'([a-z0-9-]+)'/.exec(code)[1];
  assert.ok((policy['connect-src'] || []).includes(`https://${site}.goatcounter.com`));
});

test('the browser extension drops the web policy', () => {
  const build = fs.readFileSync(path.join(ROOT, 'browser/build.js'), 'utf8');
  assert.match(build, /Content-Security-Policy/);
});
