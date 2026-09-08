#!/usr/bin/env node
/**
 * create-pr.js
 *
 * Node port of skills/pr-sdlc/scripts/create_pr.sh — a thin passthrough
 * wrapper around `gh pr create` with a post-failure account-switch
 * recovery hook.
 *
 * The shell original used `mktemp` to capture gh's stderr into a scratch
 * file before handing it to scripts/skill/pr-recover-gh-account.js via
 * --error-file. This port replaces that ad-hoc mktemp mechanism with the
 * repo's established createOutputFile() os.tmpdir() helper
 * (scripts/lib/output.js) instead.
 *
 * Usage:
 *   node create-pr.js [gh pr create flags...]
 *   (every argument is forwarded verbatim to `gh pr create`)
 *
 * On `gh pr create` failure, its stderr is written to a temp file and
 * scripts/skill/pr-recover-gh-account.js is invoked with
 * --error-file <path> to attempt an account-switch recovery; that script's
 * single-line JSON verdict is printed on stdout. The temp file is removed
 * once the recovery attempt finishes.
 *
 * Exit codes:
 *   0 = gh pr create succeeded
 *   2 = could not locate scripts/skill/pr-recover-gh-account.js, or an
 *       unexpected crash invoking either child process
 *   <n> = gh pr create's own (non-zero) exit code, forwarded after the
 *         recovery attempt runs
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createOutputFile } = require('../lib/output');

const RECOVER_SCRIPT = path.join(__dirname, '..', 'skill', 'pr-recover-gh-account.js');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  // Every argument is forwarded unchanged to `gh pr create`.
  return { forwardArgs: argv.slice(2) };
}

// ---------------------------------------------------------------------------
// Core (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv  Full argv (process.argv shape).
 * @param {{
 *   spawnFn?: Function,
 *   recoverScript?: string,
 *   existsFn?: Function,
 *   writeErrFileFn?: Function,
 *   unlinkFn?: Function,
 *   createOutputFileFn?: Function,
 * }} [deps]
 * @returns {{exitCode:number, stdout:string|null, stderr:string|null}}
 */
function runCreatePr(argv, {
  spawnFn = spawnSync,
  recoverScript = RECOVER_SCRIPT,
  existsFn = fs.existsSync,
  writeErrFileFn = fs.writeFileSync,
  unlinkFn = fs.unlinkSync,
  createOutputFileFn = createOutputFile,
} = {}) {
  const { forwardArgs } = parseArgs(argv);

  let ghResult;
  try {
    ghResult = spawnFn('gh', ['pr', 'create', ...forwardArgs], {
      stdio: ['inherit', 'inherit', 'pipe'],
      encoding: 'utf8',
    });
  } catch (e) {
    return { exitCode: 2, stdout: null, stderr: `ERROR: failed to invoke gh pr create: ${e.message}\n` };
  }
  if (ghResult.error) {
    return { exitCode: 2, stdout: null, stderr: `ERROR: failed to invoke gh pr create: ${ghResult.error.message}\n` };
  }

  const ghExit = ghResult.status === null ? 2 : ghResult.status;

  if (ghExit === 0) {
    return { exitCode: 0, stdout: null, stderr: null };
  }

  if (!existsFn(recoverScript)) {
    return {
      exitCode: 2,
      stdout: null,
      stderr: 'ERROR: Could not locate scripts/skill/pr-recover-gh-account.js. Is the Lift-SDLC plugin installed?\n',
    };
  }

  const errFilePath = createOutputFileFn('gh-pr-create-err');
  writeErrFileFn(errFilePath, ghResult.stderr || '');

  let recoverResult;
  try {
    recoverResult = spawnFn(process.execPath, [recoverScript, '--error-file', errFilePath], { encoding: 'utf8' });
  } catch (e) {
    return { exitCode: ghExit, stdout: null, stderr: `ERROR: failed to invoke pr-recover-gh-account.js: ${e.message}\n` };
  } finally {
    try { unlinkFn(errFilePath); } catch { /* best-effort cleanup, mirrors the shell original's `rm -f` */ }
  }
  if (recoverResult.error) {
    return { exitCode: ghExit, stdout: null, stderr: `ERROR: failed to invoke pr-recover-gh-account.js: ${recoverResult.error.message}\n` };
  }

  return { exitCode: ghExit, stdout: recoverResult.stdout || null, stderr: null };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const { exitCode, stdout, stderr } = runCreatePr(argv);
  if (stdout) process.stdout.write(stdout.endsWith('\n') ? stdout : stdout + '\n');
  if (stderr) process.stderr.write(stderr);
  process.exit(exitCode);
}

module.exports = { main, parseArgs, runCreatePr };

if (require.main === module) {
  main(process.argv);
}
