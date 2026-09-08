'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Output protocols
 * ----------------
 * This module hosts two complementary output protocols. Pick the one that
 * matches the consumer:
 *
 *   - `writeOutput(data, prefix)` — LLM-skill manifest protocol. Writes JSON
 *     to a randomized temp file under `os.tmpdir()` and prints ONLY the
 *     file path on stdout, then exits. Used by prepare-scripts whose output
 *     is read back by a SKILL.md prompt via `--output-file`.
 *
 *   - `writeJsonLine(obj)` / `emitText(s)` — streaming/polling protocol.
 *     Writes a single JSON line (or raw text) directly to stdout, then
 *     exits. Used by polling/CLI consumers that want to stream verdicts or
 *     a small textual payload (await-remote-review, verify-pipeline, etc.).
 *
 * Both protocols coexist intentionally: the LLM-manifest path needs a
 * stable file path so the SKILL.md can re-read large structured payloads
 * without cluttering stdout, while streaming consumers cannot afford the
 * tmpfile detour and need stdout to be the channel.
 */

/**
 * Write JSON data to a temp file with a crypto-random name.
 * Returns the file path.
 */
function createOutputFile(prefix) {
  const hash = crypto.randomBytes(4).toString('hex');
  return path.join(os.tmpdir(), `${prefix}-${hash}.json`);
}

/**
 * LLM-skill manifest protocol — writes JSON to a temp file under `os.tmpdir()`
 * and prints only the path on stdout. The previous stdout-JSON fallback was
 * removed (issue #209) because shell redirects of that fallback could
 * materialize transient `*-context-*.json` artifacts in the consumer cwd.
 * Callers that previously relied on stdout JSON must read the printed path.
 */
function writeOutput(data, prefix, exitCode = 0) {
  const filePath = createOutputFile(prefix);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  process.stdout.write(filePath + '\n');
  process.exit(exitCode);
}

/**
 * Streaming/polling protocol — writes a single JSON payload to stdout and
 * exits. Used by consumers that stream verdicts (await-remote-review,
 * verify-pipeline) or one-shot CLIs whose output is parsed by the caller.
 *
 * Defaults emit compact JSON (no whitespace) followed by a newline, which
 * is the format the polling consumers expect. `indent` is exposed for
 * one-shot CLIs (e.g. migrate-config) whose historical output was
 * `JSON.stringify(obj, null, 2)` — passing `indent: 2` preserves that.
 *
 * Back-compat: the legacy call shape `writeJsonLine(obj, exitCode)` —
 * with the second argument as a bare integer rather than an options
 * object — is still accepted and treated as `{ exitCode }`. New
 * callers should use the options-object form.
 *
 * @param {object} obj
 * @param {object|number} [opts]  Options object, or a bare integer exit code (legacy shim).
 * @param {number} [opts.exitCode=0]
 * @param {number|null} [opts.indent=null]  passed to JSON.stringify as 3rd arg
 */
function writeJsonLine(obj, opts = {}) {
  // Back-compat: legacy call shape `writeJsonLine(obj, exitCode)` where the
  // second arg was a bare integer. Detect and forward.
  if (typeof opts === 'number') {
    opts = { exitCode: opts };
  }
  const exitCode = typeof opts.exitCode === 'number' ? opts.exitCode : 0;
  const indent   = typeof opts.indent === 'number' ? opts.indent : null;
  process.stdout.write(JSON.stringify(obj, null, indent) + '\n');
  process.exit(exitCode);
}

/**
 * Streaming protocol for raw text — writes the string to stdout (with a
 * trailing newline if the input doesn't end in one) and exits. Used by
 * the small set of advisory scripts whose output is human-readable text
 * rather than JSON (plan-handoff-advisory).
 */
function emitText(s, exitCode = 0) {
  const out = s.endsWith('\n') ? s : s + '\n';
  process.stdout.write(out);
  process.exit(exitCode);
}

module.exports = { createOutputFile, writeOutput, writeJsonLine, emitText };
