/*
 * Run code written for a synchronous file system over an asynchronous one,
 * such as the virtual file systems of github.dev and vscode.dev.
 *
 * compute(get) is run with get(key) returning what is known so far (or null).
 * Every key it asked for that was not known is then fetched with
 * load(key) -> Promise, and compute runs again, until it asks for nothing new.
 * Results are kept in `cache` (a Map), so later runs are quick.
 */
'use strict';

async function withFiles(compute, load, cache, maxRounds) {
  const limit = maxRounds || 12;
  for (let round = 0; ; round++) {
    const wanted = new Set();
    const get = (key) => {
      if (cache.has(key)) return cache.get(key);
      wanted.add(key);
      return null;
    };
    const out = compute(get);
    if (!wanted.size || round >= limit) return out;
    await Promise.all(
      Array.from(wanted, async (key) => {
        let value = null;
        try {
          value = await load(key);
        } catch (e) {
          value = null;
        }
        cache.set(key, value == null ? null : value);
      })
    );
  }
}

module.exports = { withFiles };
