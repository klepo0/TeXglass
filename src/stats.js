/*
 * Visitor counter for the public web viewer (texglass.js.org).
 *
 * One request per page load to GoatCounter (https://www.goatcounter.com), a
 * cookieless, privacy-friendly counter. It sends only the site's path, the
 * referring site's address (origin only) and the screen width. Never the paper,
 * a file name, an arXiv id or anything typed: the page's query string and hash
 * are left out. No cookies, nothing stored on the device. GoatCounter turns the
 * IP address into an anonymous daily hash, so it counts unique visitors without
 * knowing who they are.
 *
 * It counts only on the public site, so local copies, `texglass serve`, the
 * arXiv browser extension, the VS Code extension and exported pages are never
 * counted. Offline, the request simply fails and nothing happens.
 */
(function () {
  'use strict';

  // The GoatCounter site code: counts go to https://<CODE>.goatcounter.com.
  // Empty turns counting off.
  const CODE = 'texglass';
  const HOSTS = ['texglass.js.org', 'klepo0.github.io'];

  if (!CODE || !HOSTS.includes(location.hostname)) return;
  if (navigator.doNotTrack === '1' || navigator.globalPrivacyControl) return;

  let ref = '';
  try {
    const r = new URL(document.referrer);
    if (r.origin !== location.origin && /^https?:$/.test(r.protocol)) ref = r.origin;
  } catch (e) { /* no referrer */ }

  const q = new URLSearchParams({
    p: location.pathname,
    t: 'TeXglass',
    r: ref,
    s: String(screen.width),
    rnd: Math.random().toString(36).slice(2),
  });
  const url = `https://${CODE}.goatcounter.com/count?${q}`;
  try {
    if (!navigator.sendBeacon || !navigator.sendBeacon(url)) new Image().src = url;
  } catch (e) { /* never let counting get in the way */ }
})();
