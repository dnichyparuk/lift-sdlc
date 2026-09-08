#!/usr/bin/env node
/**
 * fetch-logs.js
 * Resolve the CI failure log excerpt for a PR's latest failed check.
 *
 * Node port of `skills/verify-pipeline-sdlc/scripts/fetch_logs.sh`. That
 * script had two Windows-portability problems this file fixes:
 *   - Line 6 required `$SDLC_ROOT/scripts/skill/git.js`, a path that does
 *     not exist. The real module is `scripts/lib/git.js` (corrected below).
 *   - The PR number arrived via the `$PR_NUMBER` environment variable,
 *     which does not carry across a `node -e` invocation the same way on
 *     every shell. It is now an explicit `--pr-number <n>` flag.
 *
 * Usage:
 *   node fetch-logs.js --pr-number <n>
 *
 * Contract (skills/verify-pipeline-sdlc/SKILL.md Step 1):
 *   - Input: a PR number via --pr-number.
 *   - Output (stdout): the raw CI failure log excerpt, verbatim — never
 *     JSON. When there is no failed check, no run id in its link, or the
 *     log fetch itself fails, stdout is empty and a short reason is
 *     written to stderr; this mirrors the shell original's soft-fail
 *     behavior (SKILL.md Step 1 treats an empty result as "no logs
 *     resolved", not a hard error).
 *
 * Exit codes:
 *   0 = success (including the soft-fail "no logs found" cases above)
 *   1 = user-facing validation error (missing/non-numeric --pr-number, an
 *       unrecognized flag) or gh not authenticated / PR lookup failed — do
 *       not treat as passing
 *   2 = unexpected crash
 *
 * Uses only Node.js built-in modules plus the shared `lib/git.js` helpers
 * (which shell out to `gh`). No npm install required.
 */

'use strict';

const fs = require('node:fs');
const { fetchPrChecks, fetchFailedCheckLogs } = require('../lib/git');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv  Full argv (process.argv shape).
 * @returns {{prNumber: string|null, logs: string|null, unknown: string|null}}
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = { prNumber: null, logs: null, unknown: null };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--pr-number') {
      parsed.prNumber = args[++i] !== undefined ? args[i] : null;
    } else if (a === '--logs') {
      parsed.logs = args[++i] !== undefined ? args[i] : null;
    } else if (a.startsWith('--')) {
      parsed.unknown = a;
      break;
    }
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Logs flag resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the --logs flag value: read file if path exists, else treat as inline text.
 *
 * @param {string} value  The --logs flag value.
 * @returns {string}  Either the file contents or the literal value.
 */
function resolveLogsFlag(value) {
  if (fs.existsSync(value)) {
    return fs.readFileSync(value, 'utf8');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Log resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the failure-log excerpt for `--pr-number`'s latest failed check,
 * or return the resolved content of `--logs`.
 *
 * When --pr-number is supplied, mirrors fetch_logs.sh's inline `node -e` logic 1:1:
 * find the first check whose bucket is 'fail', pull the run id out of its link URL,
 * then fetch a tail-trimmed log excerpt for that run.
 *
 * When --logs is supplied, read the file at that path (if it exists) or treat it
 * as inline text (if it doesn't).
 *
 * @param {string[]} argv  Full argv (process.argv shape).
 * @param {{fetchPrChecksFn?: Function, fetchFailedCheckLogsFn?: Function}} [deps]  Injectable for tests.
 * @returns {{stdout: string, stderr: string, exitCode: number}}
 */
function fetchLogs(argv, { fetchPrChecksFn = fetchPrChecks, fetchFailedCheckLogsFn = fetchFailedCheckLogs } = {}) {
  const opts = parseArgs(argv);

  if (opts.unknown !== null) {
    return { stdout: '', stderr: `Unknown parameter passed: ${opts.unknown}\n`, exitCode: 1 };
  }

  // Validate mutual exclusivity
  if (opts.prNumber !== null && opts.logs !== null) {
    return { stdout: '', stderr: '--pr-number and --logs are mutually exclusive\n', exitCode: 1 };
  }

  // --logs path
  if (opts.logs !== null) {
    const content = resolveLogsFlag(opts.logs);
    return { stdout: content, stderr: '', exitCode: 0 };
  }

  // --pr-number path
  if (!opts.prNumber || !/^\d+$/.test(opts.prNumber)) {
    return { stdout: '', stderr: '--pr-number <n> is required and must be numeric\n', exitCode: 1 };
  }

  const { checks, ghAuthenticated, errorMessage } = fetchPrChecksFn(opts.prNumber);
  if (!ghAuthenticated) {
    return { stdout: '', stderr: `${errorMessage}\n`, exitCode: 1 };
  }
  const failed = checks.find((c) => c && c.bucket === 'fail');
  if (!failed || !failed.link) {
    return { stdout: '', stderr: 'no failed check found\n', exitCode: 0 };
  }

  const m = failed.link.match(/\/actions\/runs\/(\d+)/);
  if (!m) {
    return { stdout: '', stderr: 'no runId in link\n', exitCode: 0 };
  }

  const out = fetchFailedCheckLogsFn(m[1], { maxLines: 200 });
  if (!out || !out.ok) {
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  return { stdout: out.excerpt, stderr: '', exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const { stdout, stderr, exitCode } = fetchLogs(argv);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(exitCode);
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    process.stderr.write(`fetch-logs.js error: ${err.message}\n`);
    process.exit(2);
  }
}

module.exports = { parseArgs, resolveLogsFlag, fetchLogs, main };
