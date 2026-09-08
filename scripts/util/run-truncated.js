#!/usr/bin/env node
/**
 * run-truncated.js
 * Run a command and echo its combined output, truncating the middle when the
 * output is too long for an LLM context window.
 *
 * Node port of the former `skills/execute-plan-sdlc/scripts/run_truncated.sh`.
 * The shell version used `eval "$COMMAND"` plus `wc -l`, `head -n` and
 * `tail -n`. Here:
 *   - `eval` becomes `child_process.execSync(command, { shell: true })`. This
 *     is the same trust boundary, not a downgrade: the command string is
 *     orchestrator-constructed and was already being handed to a shell.
 *   - `wc`/`head`/`tail` become in-process line counting and slicing, so the
 *     script runs on Windows without any Unix coreutils.
 *   - `2>&1` becomes a single temp file opened as both the child's stdout and
 *     stderr, which preserves true interleaving without relying on shell
 *     redirection syntax.
 *
 * Usage:
 *   node run-truncated.js "<command>"
 *   node run-truncated.js --command "<command>" [--max-head <n>] [--max-tail <n>]
 *
 * Defaults mirror the shell original: --max-head 100, --max-tail 400.
 *
 * Output (stdout): the command's combined stdout+stderr, verbatim when it fits
 * within (maxHead + maxTail) lines, otherwise the first `maxHead` lines, a
 * `...[TRUNCATED_LOGS: N lines removed]...` marker, and the last `maxTail`
 * lines. Never JSON — the caller reads this as plain log text.
 *
 * Exit codes:
 *   the command's own exit code (0 on success), or 1 when no command was given.
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');

const DEFAULT_MAX_HEAD = 100;
const DEFAULT_MAX_TAIL = 400;

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

/**
 * Parse the CLI arguments.
 *
 * The shell original took the command as a single positional argument; that
 * form is preserved verbatim so existing call sites keep working. The
 * `--command` alias and the two line-count flags are additions that make the
 * previously hard-coded `MAX_HEAD`/`MAX_TAIL` constants overridable.
 *
 * @param {string[]} argv  Full argv (process.argv shape).
 * @returns {{command:string, maxHead:number, maxTail:number, scriptName:string, unknown:string|null}}
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    command: '',
    maxHead: DEFAULT_MAX_HEAD,
    maxTail: DEFAULT_MAX_TAIL,
    scriptName: argv[1] || 'run-truncated.js',
    unknown: null,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--command') {
      parsed.command = args[++i] || '';
    } else if (a === '--max-head') {
      parsed.maxHead = toCount(args[++i], DEFAULT_MAX_HEAD);
    } else if (a === '--max-tail') {
      parsed.maxTail = toCount(args[++i], DEFAULT_MAX_TAIL);
    } else if (a.startsWith('--')) {
      parsed.unknown = a;
      break;
    } else if (!parsed.command) {
      parsed.command = a;
    }
  }

  return parsed;
}

/**
 * @param {string|undefined} raw
 * @param {number} fallback
 * @returns {number} a non-negative integer
 */
function toCount(raw, fallback) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

/**
 * Reproduce `run_truncated.sh:15-27`'s line-count behavior without `wc`,
 * `head` or `tail`.
 *
 * The shell version captured the output in `$(...)`, which strips trailing
 * newlines, then measured it with `echo "$OUTPUT" | wc -l` — so an empty
 * capture counts as one (empty) line. `trimTrailingNewlines` + `split('\n')`
 * reproduces exactly that count.
 *
 * @param {string} output   Raw combined command output.
 * @param {number} maxHead  Lines to keep from the start.
 * @param {number} maxTail  Lines to keep from the end.
 * @returns {string} The (possibly truncated) text, newline-terminated.
 */
function truncateOutput(output, maxHead = DEFAULT_MAX_HEAD, maxTail = DEFAULT_MAX_TAIL) {
  const body = output.replace(/\n+$/, '');
  const lines = body.split('\n');
  const totalMax = maxHead + maxTail;

  if (lines.length <= totalMax) {
    return `${body}\n`;
  }

  const removed = lines.length - totalMax;
  const head = lines.slice(0, maxHead);
  const tail = maxTail > 0 ? lines.slice(lines.length - maxTail) : [];

  return [
    ...head,
    '',
    `...[TRUNCATED_LOGS: ${removed} lines removed]...`,
    '',
    ...tail,
  ].join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

/**
 * Run `command` through the platform shell, capturing stdout and stderr
 * interleaved into one buffer.
 *
 * Both streams are pointed at the same temp-file descriptor, which is what
 * `2>&1` does at the fd level — but without embedding shell redirection
 * syntax in the command string, and without the `maxBuffer` ceiling that
 * piped capture imposes (verification suites routinely emit megabytes).
 *
 * @param {string} command
 * @returns {{output: string, exitCode: number}}
 */
function runCommand(command) {
  const capturePath = path.join(
    os.tmpdir(),
    `run-truncated-${crypto.randomBytes(4).toString('hex')}.log`
  );

  let fd = null;
  let exitCode = 0;

  try {
    fd = fs.openSync(capturePath, 'w');
    try {
      execSync(command, { shell: true, stdio: ['ignore', fd, fd] });
    } catch (err) {
      exitCode = typeof err.status === 'number' ? err.status : 1;
      // A command the shell could not start at all (ENOENT on the shell
      // itself, signal kill) leaves nothing in the capture file; surface the
      // reason rather than an empty success-looking log.
      if (err.status === null || err.status === undefined) {
        try {
          fs.writeSync(fd, `${err.message}\n`);
        } catch (_) {
          // Capture file already unusable — the exit code still propagates.
        }
      }
    }
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) { /* already closed */ }
    }
  }

  let output = '';
  try {
    output = fs.readFileSync(capturePath, 'utf8');
  } catch (_) {
    output = '';
  }
  try {
    fs.unlinkSync(capturePath);
  } catch (_) {
    // Best effort — a leftover temp file must not fail the verification run.
  }

  return { output, exitCode };
}

/**
 * Full run: execute the command and truncate its output.
 *
 * @param {string[]} argv  Full argv (process.argv shape).
 * @param {{runCommandFn?: Function}} [deps]  Injectable for tests.
 * @returns {{stdout: string, stderr: string, exitCode: number}}
 */
function runTruncated(argv, { runCommandFn = runCommand } = {}) {
  const opts = parseArgs(argv);

  if (opts.unknown !== null) {
    return { stdout: '', stderr: `Unknown parameter passed: ${opts.unknown}\n`, exitCode: 1 };
  }

  if (!opts.command) {
    return { stdout: `Usage: ${opts.scriptName} <command>\n`, stderr: '', exitCode: 1 };
  }

  const { output, exitCode } = runCommandFn(opts.command);
  return {
    stdout: truncateOutput(output, opts.maxHead, opts.maxTail),
    stderr: '',
    exitCode,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const { stdout, stderr, exitCode } = runTruncated(argv);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(exitCode);
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    process.stderr.write(`run-truncated.js error: ${err.message}\n`);
    process.exit(2);
  }
}

module.exports = { parseArgs, truncateOutput, runCommand, runTruncated, main };
