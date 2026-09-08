#!/usr/bin/env node
/**
 * verify-ancestry.js
 *
 * Node port of skills/ship-sdlc/scripts/verify_ancestry.sh — the ship-sdlc
 * post-version ancestry HARD GATE (R-post-version-ancestry, fixes #349).
 *
 * The shell original read $NEW_TAG / $EXECUTE_BRANCH as ambient environment
 * variables. This CLI takes them as explicit --new-tag/--execute-branch
 * flags instead (no ambient env var reads) and delegates the actual
 * ancestry check to the pre-existing scripts/util/verify-tag-ancestry.js
 * rather than re-implementing the git plumbing.
 *
 * Usage:
 *   node verify-ancestry.js --new-tag <tag> --execute-branch <branch>
 *
 * When either flag is omitted, the gate is a no-op — this mirrors the shell
 * original's `[ -n "$NEW_TAG" ] && [ -n "$EXECUTE_BRANCH" ]` guard, which
 * only ran the check when both ambient vars were set.
 *
 * Exit codes:
 *   0 = ancestry OK, or the gate did not run (a flag was omitted)
 *   1 = tag is NOT an ancestor of the branch, or a bad flag was passed
 *   2 = could not locate verify-tag-ancestry.js, or an unexpected crash
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TARGET_SCRIPT = path.join(__dirname, 'verify-tag-ancestry.js');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  let newTag = null;
  let executeBranch = null;
  const errors = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--new-tag' && args[i + 1] !== undefined) {
      newTag = args[++i];
    } else if (a === '--execute-branch' && args[i + 1] !== undefined) {
      executeBranch = args[++i];
    } else {
      errors.push(`Unknown parameter passed: ${a}`);
    }
  }

  return { newTag, executeBranch, errors };
}

// ---------------------------------------------------------------------------
// Core (injectable for tests)
// ---------------------------------------------------------------------------

/**
 * @param {string[]} argv  Full argv (process.argv shape).
 * @param {{spawnFn?:Function, targetScript?:string, existsFn?:Function}} [deps]
 * @returns {{exitCode:number, stderr:string|null}}
 */
function runVerifyAncestry(argv, { spawnFn = spawnSync, targetScript = TARGET_SCRIPT, existsFn = fs.existsSync } = {}) {
  const args = parseArgs(argv);

  if (args.errors.length > 0) {
    return { exitCode: 1, stderr: args.errors.join('\n') + '\n' };
  }

  if (!existsFn(targetScript)) {
    return {
      exitCode: 2,
      stderr: 'ERROR: Could not locate scripts/util/verify-tag-ancestry.js. Is the Lift-SDLC plugin installed?\n',
    };
  }

  // Gate only runs when both values are present (mirrors verify_ancestry.sh).
  if (!args.newTag || !args.executeBranch) {
    return { exitCode: 0, stderr: null };
  }

  let result;
  try {
    result = spawnFn(
      process.execPath,
      [targetScript, '--tag', args.newTag, '--branch', args.executeBranch, '--remote', 'origin'],
      { stdio: 'inherit' }
    );
  } catch (e) {
    return { exitCode: 2, stderr: `ERROR: failed to invoke verify-tag-ancestry.js: ${e.message}\n` };
  }

  if (result.error) {
    return { exitCode: 2, stderr: `ERROR: failed to invoke verify-tag-ancestry.js: ${result.error.message}\n` };
  }

  const exitCode = result.status === null ? 2 : result.status;

  if (exitCode !== 0) {
    return {
      exitCode: 1,
      stderr:
        `Pipeline halted: tag ${args.newTag} is not an ancestor of ${args.executeBranch}.\n` +
        `Remediation: delete the tag (git push origin :refs/tags/${args.newTag}; git tag -d ${args.newTag}) and re-run version step on the correct branch.\n`,
    };
  }

  return { exitCode: 0, stderr: null };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const { exitCode, stderr } = runVerifyAncestry(argv);
  if (stderr) process.stderr.write(stderr);
  process.exit(exitCode);
}

module.exports = { main, parseArgs, runVerifyAncestry };

if (require.main === module) {
  main(process.argv);
}
