/*
 * TeXglass for arXiv, on a .tex file opened in the browser (a file:// address,
 * Chrome and Edge, once the extension may "access file URLs"): asks the
 * background script to show the file in TeXglass instead of as plain text.
 * Going back to the plain text (the browser's Back button) leaves it there.
 */
'use strict';
(function () {
  const api = globalThis.browser || globalThis.chrome;
  let nav = null;
  try { nav = performance.getEntriesByType('navigation')[0]; } catch (e) { nav = null; }
  if (nav && nav.type === 'back_forward') return;
  try {
    api.runtime.sendMessage({ type: 'texglass-open-file', url: location.href });
  } catch (e) {
    // the extension was updated or removed since the page loaded
  }
})();
