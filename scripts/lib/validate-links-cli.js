'use strict';

/**
 * validate-links-cli.js — Shared `--file`/stdin-fallback CLI helper wrapping
 * scripts/lib/links.js's validateLinks(), for the link-verification hard
 * gates (issue #198).
 *
 * skills/plan-sdlc/scripts/validate_links.sh and
 * skills/received-review-sdlc/scripts/validate_links.sh were byte-for-byte
 * identical thin dispatchers (`node links.js --json --file "$INPUT_FILE"` /
 * `cat | node links.js --json`). Rather than duplicating that CLI-parsing
 * shell a second time in Node, this module is the single shared
 * implementation both migrated callers (scripts/util/plan-validate-links.js
 * and received-review-sdlc's equivalent) import and invoke.
 *
 * Contract mirrors the original shell scripts' documented I/O (see
 * skills/plan-sdlc/SKILL.md Step 6.5 and
 * skills/received-review-sdlc/SKILL.md Step 11.7):
 *   - Input: text via stdin, or via `--file <path>`.
 *   - Output: on success, a one-line OK message to stdout; on violations,
 *     the violation list to stderr (via links.js's formatViolations).
 *   - ctx is intentionally NOT constructed by callers — validateLinks()
 *     auto-derives expectedRepo (from the git remote) and jiraSite (from
 *     the ~/.sdlc-cache/jira/ cache) when ctx is empty.
 *
 * Exit codes (per project convention):
 *   0 = success (no violations)
 *   1 = link violations found (user-facing validation error)
 *   2 = usage error / unexpected crash (unknown flag, unreadable --file, stdin read failure)
 *
 * Usage (library):
 *   const { runValidateLinksCli } = require('./validate-links-cli');
 *   const exitCode = await runValidateLinksCli(process.argv);
 *   process.exit(exitCode);
 */

const fs = require('node:fs');

const { validateLinks, formatViolations } = require('./links');

/**
 * Parses CLI args (argv in process.argv shape: [node, script, ...args]).
 * Only recognized flag is `--file <path>`. Throws on unknown parameters,
 * mirroring the original shell scripts' `*) echo "Unknown parameter: $1" >&2; exit 2 ;;`.
 */
function parseArgs(argv) {
  const args = { file: null };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--file') {
      args.file = rest[++i] || null;
    } else {
      const err = new Error(`Unknown parameter: ${a}`);
      err.code = 'EARGS';
      throw err;
    }
  }
  return args;
}

function readStdin(stream = process.stdin) {
  return new Promise((resolve, reject) => {
    let buf = '';
    stream.setEncoding('utf8');

    const onData = (c) => { buf += c; };
    const onEnd = () => settle(() => resolve(buf));
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

/**
 * Runs the shared validate-links CLI flow. Writes to stdout/stderr and
 * resolves an exit code — never rejects, including when `validate()` itself
 * throws (caught and mapped to exit 2, mirroring the other failure branches
 * in this function). Does not call process.exit — callers decide when to
 * exit, and tests can inject stdout/stderr/IO deps instead of hitting the
 * real process streams or filesystem.
 *
 * @param {string[]} argv  process.argv-shaped array: [node, script, ...args]
 * @param {object} [deps]  injectable dependencies (for tests / reuse)
 * @param {() => Promise<string>} [deps.readInput]  stdin reader, defaults to real stdin
 * @param {(path: string, enc: string) => string} [deps.readFileSync]  defaults to fs.readFileSync
 * @param {(text: string, ctx: object) => Promise<object>} [deps.validate]  defaults to validateLinks
 * @param {(violations: object[]) => string} [deps.format]  defaults to formatViolations
 * @param {{write: (s: string) => void}} [deps.stdout]  defaults to process.stdout
 * @param {{write: (s: string) => void}} [deps.stderr]  defaults to process.stderr
 * @returns {Promise<number>} exit code
 */
async function runValidateLinksCli(argv, deps = {}) {
  const {
    readInput = readStdin,
    readFileSync = fs.readFileSync,
    validate = validateLinks,
    format = formatViolations,
    stdout = process.stdout,
    stderr = process.stderr,
  } = deps;

  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    stderr.write(`${err.message}\n`);
    return 2;
  }

  let body;
  if (args.file) {
    try {
      body = readFileSync(args.file, 'utf8');
    } catch (err) {
      stderr.write(`validate-links-cli: cannot read --file ${args.file}: ${err.message}\n`);
      return 2;
    }
  } else {
    try {
      body = await readInput();
    } catch (err) {
      stderr.write(`validate-links-cli: failed to read stdin: ${err.message}\n`);
      return 2;
    }
  }

  // ctx intentionally empty — validateLinks() auto-derives expectedRepo /
  // jiraSite. Callers MUST NOT construct ctx JSON (see module docstring).
  let result;
  try {
    result = await validate(body, {});
  } catch (err) {
    stderr.write(`validate-links-cli: validate() crashed: ${(err && err.stack) || err}\n`);
    return 2;
  }

  if (result.ok) {
    const skippedNote = result.skipped && result.skipped.length ? ` (${result.skipped.length} skipped)` : '';
    stdout.write(`OK: link verification passed${skippedNote}\n`);
    return 0;
  }

  stderr.write(format(result.violations));
  stderr.write('\n');
  return 1;
}

module.exports = { runValidateLinksCli, parseArgs, readStdin };
