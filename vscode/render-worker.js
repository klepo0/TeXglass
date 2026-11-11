/*
 * Converts LaTeX to HTML in a worker thread, so that a long document (hundreds
 * of pages take a couple of seconds) never stalls the extension host.
 *
 * In:  { id, text, dir, base } or { id, text, figures } (see convert.js).
 * Out: { id, result } or { id, error }
 */
'use strict';
const { parentPort } = require('worker_threads');
const { convert } = require('./convert.js');

parentPort.on('message', (job) => {
  try {
    parentPort.postMessage({ id: job.id, result: convert(job) });
  } catch (e) {
    parentPort.postMessage({ id: job.id, error: (e && e.stack) || String(e) });
  }
});
