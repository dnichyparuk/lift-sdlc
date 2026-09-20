'use strict';

/**
 * stdin.js
 * Shared stdin-reading helper for `scripts/util/` CLIs that parse a token
 * off stdin (parse-wave.js, parse-verify.js).
 *
 * Extracted out of `scripts/util/parse-wave.js` so that other `scripts/util/`
 * CLIs reuse it via the `lib` (shared logic) layer instead of cross-importing
 * another `util/` CLI's module surface. `parse-wave.js` re-exports this
 * function for backward compatibility with existing importers/tests.
 *
 * No I/O beyond stdin. Zero npm dependencies.
 */

/**
 * Read all of stdin as a UTF-8 string.
 * @param {NodeJS.ReadableStream} [stream]
 * @returns {Promise<string>}
 */
function readStdin(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf8');

    const onData = (chunk) => { data += chunk; };
    const onEnd = () => settle(() => resolve(data));
    const onError = (err) => settle(() => reject(err));

    function settle(action) {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      action();
    }

    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
    stream.resume();
  });
}

module.exports = { readStdin };
