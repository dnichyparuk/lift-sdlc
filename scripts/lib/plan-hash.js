'use strict';

/**
 * plan-hash.js
 * SHA-256 content hashing for plan files.
 *
 * Extracted from the inline `node -e` block of the former
 * `skills/execute-plan-sdlc/scripts/plan_hash.sh` (lines 14-24) so the hashing
 * logic lives in one requireable place. The thin CLI wrapper is
 * `scripts/util/plan-hash.js`.
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

const fs = require('node:fs');
const crypto = require('node:crypto');

/**
 * Compute the SHA-256 hex digest of a file's raw bytes.
 *
 * Reads the file as a Buffer (not a string) so the digest is byte-exact and
 * independent of encoding — identical to `sha256sum`/`shasum -a 256` output,
 * and identical to what the shell version's `node -e` block produced.
 *
 * @param {string} filePath  Path to the file to hash.
 * @returns {string} Lowercase 64-character hex digest.
 * @throws {Error} Propagates any fs read error (ENOENT, EISDIR, EACCES, …);
 *                 callers decide how to report it.
 */
function computePlanHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

module.exports = { computePlanHash };
