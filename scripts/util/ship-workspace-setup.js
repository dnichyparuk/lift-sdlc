#!/usr/bin/env node
/**
 * ship-workspace-setup.js
 * Unified workspace setup for the ship-sdlc pipeline.
 *
 * Node port of the former `skills/ship-sdlc/scripts/workspace_setup.sh`.
 * The shell version shelled out to seven separate `node -e` one-liners, two
 * `sed` filters and a `/dev/stdin` heredoc; every one of those is now a direct
 * `require()` of the shared libs (`lib/config`, `lib/branch-name`, `lib/state`,
 * `lib/git`) or an in-memory `JSON.parse`.
 *
 * Usage:
 *   node ship-workspace-setup.js \
 *     --workspace-flag <branch|worktree|continue> \
 *     --prepare-output-file <path> \
 *     --logical-type <string> \
 *     --derived-slug <string>
 *
 * Steps (1:1 with the shell original):
 *   1. Resolve workspace mode (flag, else `workspace.mode` from config)
 *   2. Default-branch guard (refuse `continue` while on the default branch)
 *   3. Cwd assertion against the prepare manifest's `assertions` block
 *   4. Resolve the execute branch name via `workspace.branch` config
 *   5. Pre-execute ship-state migration when the branch name changed
 *   6. Branch checkout or worktree creation
 *
 * Output (stdout, single JSON line — consumed by ship-sdlc/SKILL.md):
 *   Success: {"status":"success","workspaceMode":..,"executeBranch":..,"worktreePath":..}
 *   Error:   {"status":"error","error":"<message>"}
 *
 * Exit codes:
 *   0 = success
 *   1 = user-facing validation error (JSON error object on stdout)
 *   2 = unexpected crash / missing sibling script
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', 'lib');

let libs = null;

/**
 * Require all shared libs, memoized so repeated calls are free.
 *
 * Invoked at the top of `main()`, inside the `require.main === module`
 * try/catch: a missing lib throws `MODULE_NOT_FOUND` there, where it is
 * converted into the documented
 * `{"status":"error","error":"Could not locate scripts/lib/<name>.js"}` + exit
 * 2 payload instead of a raw stack trace. Also called lazily by the helpers
 * below so `runWorkspaceSetup()` keeps working when tests invoke it directly
 * without going through `main()`.
 * @returns {object}
 */
function loadLibs() {
  if (!libs) {
    libs = {
      config:     require(path.join(LIB, 'config.js')),
      branchName: require(path.join(LIB, 'branch-name.js')),
      state:      require(path.join(LIB, 'state.js')),
      git:        require(path.join(LIB, 'git.js')),
      output:     require(path.join(LIB, 'output.js')),
    };
  }
  return libs;
}

// Sibling CLI — resolved relative to __dirname, so the shell version's
// `plugins/lift-sdlc/...` fallback probing is no longer needed.
const WORKTREE_CREATE_SCRIPT = path.join(__dirname, 'worktree-create.js');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

// Usage text — one line per flag `parseArgs` accepts below, kept in the same
// order as the parsing branches so the two cannot drift apart.
const USAGE = [
  'Usage: node ship-workspace-setup.js \\',
  '  --workspace-flag <branch|worktree|continue> \\',
  '  --prepare-output-file <path> \\',
  '  --logical-type <string> \\',
  '  --derived-slug <string>',
  '',
  'Unified workspace setup for the ship-sdlc pipeline: resolves the workspace',
  'mode, guards against shipping on the default branch, checks the cwd against',
  'the prepare manifest, resolves the execute branch name, migrates ship state',
  'when the branch changed, then checks out the branch or creates a worktree.',
  '',
  'Options:',
  '  --workspace-flag <mode>       branch|worktree|continue (else workspace.mode from .sdlc/local.json)',
  '  --prepare-output-file <path>  prepare-step manifest read for cwd assertions',
  '  --logical-type <string>       branch-name type segment (default: feature)',
  '  --derived-slug <string>       branch-name slug segment (default: feature-branch)',
  '  --help, -h                    show this help and exit',
  '',
  'Output (stdout, single JSON line):',
  '  Success: {"status":"success","workspaceMode":..,"executeBranch":..,"worktreePath":..}',
  '  Error:   {"status":"error","error":"<message>"}',
  '',
  'Exit codes: 0 = success, 1 = validation error, 2 = unexpected crash',
].join('\n') + '\n';

/**
 * Parse the four workspace-setup flags. Mirrors the shell `while`/`case` loop:
 * a missing value yields an empty string, and the first unrecognised token
 * aborts parsing (the shell exited immediately on `Unknown parameter passed`).
 *
 * `--help`/`-h` is handled inline, bypassing the JSON protocol entirely (same
 * shape as `scripts/lib/links.js` and `scripts/lib/ship-todos.js`): it prints
 * usage to stdout and exits 0 before any other flag is parsed.
 *
 * @param {string[]} argv  Full argv (process.argv shape).
 * @returns {{workspaceFlag:string, prepareOutputFile:string, logicalType:string, derivedSlug:string, unknown:string|null}}
 */
function parseArgs(argv) {
  const args = argv.slice(2);
  const parsed = {
    workspaceFlag:     '',
    prepareOutputFile: '',
    logicalType:       '',
    derivedSlug:       '',
    unknown:           null,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--workspace-flag') {
      parsed.workspaceFlag = args[++i] || '';
    } else if (a === '--prepare-output-file') {
      parsed.prepareOutputFile = args[++i] || '';
    } else if (a === '--logical-type') {
      parsed.logicalType = args[++i] || '';
    } else if (a === '--derived-slug') {
      parsed.derivedSlug = args[++i] || '';
    } else if (a === '--help' || a === '-h') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else {
      parsed.unknown = a;
      break;
    }
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read a section of the unified config, tolerating any resolution failure
 * (non-git cwd, missing `.sdlc/`, unreadable JSON).
 * @param {string} section
 * @returns {object}
 */
function readSectionSafe(section) {
  try {
    const { readSection, resolveSdlcRoot } = loadLibs().config;
    return readSection(resolveSdlcRoot(), section) || {};
  } catch (_) {
    return {};
  }
}

/**
 * Step 1 — resolve the workspace mode: explicit flag wins, else
 * `workspace.mode` from `.sdlc/local.json`.
 * @param {string} flag
 * @returns {string}
 */
function resolveWorkspaceMode(flag) {
  if (flag) return flag;
  const ws = readSectionSafe('workspace');
  return ws.mode || '';
}

/**
 * Resolve the repository default branch.
 * Replaces `git symbolic-ref … | sed 's|^origin/||'` with String#replace.
 * @returns {string}
 */
function resolveDefaultBranch() {
  const { exec } = loadLibs().git;
  const ref = exec('git symbolic-ref --short refs/remotes/origin/HEAD', {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const stripped = ref ? ref.replace(/^origin\//, '') : '';
  return stripped || 'main';
}

/**
 * @returns {string} current branch, or '' when it cannot be determined.
 */
function resolveCurrentBranch() {
  const { exec } = loadLibs().git;
  return exec('git branch --show-current') || '';
}

/**
 * Step 3 — read the prepare manifest's cwd assertions. Returns an empty
 * assertion set when the file is absent or unparseable (the shell version
 * silently produced empty strings in the same situations).
 * @param {string} prepareOutputFile
 * @returns {{requireMainWorktreeCwd: boolean, expectedMainWorktreeRoot: string}}
 */
function readCwdAssertions(prepareOutputFile) {
  const empty = { requireMainWorktreeCwd: false, expectedMainWorktreeRoot: '' };
  if (!prepareOutputFile || !fs.existsSync(prepareOutputFile)) return empty;

  let data;
  try {
    data = JSON.parse(fs.readFileSync(prepareOutputFile, 'utf8'));
  } catch (_) {
    return empty;
  }

  const assertions = (data && data.assertions) || {};
  return {
    requireMainWorktreeCwd:   assertions.requireMainWorktreeCwd === true,
    expectedMainWorktreeRoot: assertions.expectedMainWorktreeRoot || '',
  };
}

/**
 * Step 5 — read the ship-state file for the current branch and return the
 * branch it was created for. Delegates to `lib/state.js` (the same module the
 * `state/ship.js read` subcommand uses) instead of spawning that CLI and
 * piping its stdout through `node -e`.
 * @returns {string} recorded branch, or '' when there is no readable state.
 */
function readShipStateBranch() {
  try {
    const { readState, resolveBranch, slugifyBranch } = loadLibs().state;
    const branch = resolveBranch();
    const found  = readState('ship', slugifyBranch(branch));
    if (found && found.data && typeof found.data.branch === 'string') {
      return found.data.branch;
    }
  } catch (_) {
    // No git branch / no state dir — nothing to migrate.
  }
  return '';
}

/**
 * Run a git subcommand without a shell, capturing stderr for diagnostics.
 * @param {string[]} args
 * @returns {{ok: boolean, stderr: string}}
 */
function runGit(args) {
  try {
    execFileSync('git', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    return { ok: true, stderr: '' };
  } catch (err) {
    return { ok: false, stderr: String(err.stderr || err.message).trim() };
  }
}

/**
 * Step 6 (worktree mode) — invoke the sibling `worktree-create.js` CLI once and
 * parse its JSON straight from the in-memory buffer. The shell version echoed
 * the payload into two further `node -e` processes reading `/dev/stdin`.
 * @param {string} branchName
 * @returns {{branch: string, path: string, error: string}}
 */
function createWorktree(branchName) {
  let raw = '';
  try {
    raw = execFileSync(process.execPath, [WORKTREE_CREATE_SCRIPT, '--name', branchName], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    // worktree-create.js prints its `{"error": …}` payload on stdout before
    // exiting non-zero; keep it so the reason can be surfaced on stderr.
    raw = (err && typeof err.stdout === 'string') ? err.stdout : '';
  }

  if (!raw.trim()) return { branch: '', path: '', error: '' };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return { branch: '', path: '', error: '' };
  }

  return {
    branch: parsed.branch || '',
    path:   parsed.path   || '',
    error:  parsed.error  || '',
  };
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Run the full six-step workspace setup.
 *
 * @param {string[]} argv  Full argv (process.argv shape).
 * @param {{runGitFn?: Function}} [options]
 * @returns {{json: object|null, stderr: string, exitCode: number}}
 */
function runWorkspaceSetup(argv, options = {}) {
  const { runGitFn = runGit } = options;
  const opts = parseArgs(argv);

  if (opts.unknown !== null) {
    return { json: null, stderr: `Unknown parameter passed: ${opts.unknown}\n`, exitCode: 1 };
  }

  // --- 1. Resolve workspace mode -------------------------------------------
  const workspaceMode = resolveWorkspaceMode(opts.workspaceFlag);
  if (!workspaceMode) {
    return {
      json: {
        status: 'error',
        error: 'Workspace mode not set. Pass --workspace-flag branch|worktree|continue or set workspace.mode in .sdlc/local.json.',
      },
      stderr: '',
      exitCode: 1,
    };
  }

  // --- 2. Default-branch guard ---------------------------------------------
  const defaultBranch = resolveDefaultBranch();
  const currentBranch = resolveCurrentBranch();
  if (currentBranch === defaultBranch && workspaceMode === 'continue') {
    return {
      json: {
        status: 'error',
        error: `Cannot ship on default branch '${defaultBranch}'. Pass --workspace-flag branch or --workspace-flag worktree.`,
      },
      stderr: '',
      exitCode: 1,
    };
  }

  // --- 3. Cwd assertion -----------------------------------------------------
  const assertions = readCwdAssertions(opts.prepareOutputFile);
  if (assertions.requireMainWorktreeCwd && assertions.expectedMainWorktreeRoot) {
    const { exec } = loadLibs().git;
    const actualCwd = exec('git rev-parse --show-toplevel', {
      stdio: ['ignore', 'pipe', 'ignore'],
    }) || '';
    if (actualCwd !== assertions.expectedMainWorktreeRoot) {
      return {
        json: {
          status: 'error',
          error: `ship-sdlc cwd assertion failed. actual cwd: ${actualCwd}, expected root: ${assertions.expectedMainWorktreeRoot}. ship.workspace: ${workspaceMode}.`,
        },
        stderr: '',
        exitCode: 1,
      };
    }
  }

  // --- 4. Resolve branch name ----------------------------------------------
  const branchCfg = readSectionSafe('workspace').branch || {};
  let executeBranch;
  try {
    const { resolveBranchName } = loadLibs().branchName;
    executeBranch = resolveBranchName({
      type:   opts.logicalType || 'feature',
      slug:   opts.derivedSlug || 'feature-branch',
      config: branchCfg,
    });
  } catch (err) {
    return {
      json: { status: 'error', error: `Could not resolve branch name: ${err.message}` },
      stderr: '',
      exitCode: 1,
    };
  }

  // --- 5. Pre-execute ship state migration ---------------------------------
  const stateBranch = readShipStateBranch();
  if (stateBranch && stateBranch !== executeBranch) {
    // Mirrors the shell `sed 's|[^a-zA-Z0-9-]|-|g'` (same rule as slugifyBranch).
    const fromSlug = stateBranch.replace(/[^a-zA-Z0-9-]/g, '-');
    try {
      const { migrateBranchSlug } = loadLibs().state;
      migrateBranchSlug({ prefix: 'ship', fromSlug, toBranch: executeBranch });
    } catch (_) {
      // Migration is best-effort — the shell version discarded errors too.
    }
  }

  // --- 6. Branch / worktree creation ---------------------------------------
  let worktreePath = '';
  let stderr = '';

  if (workspaceMode === 'branch') {
    const checkoutResult = runGitFn(['checkout', executeBranch]);
    if (!checkoutResult.ok) {
      const createResult = runGitFn(['checkout', '-b', executeBranch]);
      if (!createResult.ok) {
        // Fall back to the first checkout's stderr when the -b attempt
        // produced none, so the reported reason is never empty.
        const reason = createResult.stderr || checkoutResult.stderr || 'unknown error';
        return {
          json: {
            status: 'error',
            error: `Could not switch to or create branch ${executeBranch}: ${reason}`,
          },
          stderr: '',
          exitCode: 2,
        };
      }
    }
  } else if (workspaceMode === 'worktree') {
    if (!fs.existsSync(WORKTREE_CREATE_SCRIPT)) {
      return {
        json: { status: 'error', error: 'Could not locate scripts/util/worktree-create.js' },
        stderr: '',
        exitCode: 2,
      };
    }

    const created = createWorktree(executeBranch);
    if (created.path)   worktreePath  = created.path;
    if (created.branch) executeBranch = created.branch;
    if (created.error)  stderr += `worktree-create.js: ${created.error}\n`;
  }

  return {
    json: { status: 'success', workspaceMode, executeBranch, worktreePath },
    stderr,
    exitCode: 0,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(argv) {
  const { writeJsonLine } = loadLibs().output;
  const { json, stderr, exitCode } = runWorkspaceSetup(argv);
  if (stderr) process.stderr.write(stderr);
  if (json === null) process.exit(exitCode);
  writeJsonLine(json, { exitCode });
}

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      const match = err.message.match(/scripts[\\/]lib[\\/][\w-]+\.js/);
      const name = match ? match[0] : 'a required lib module';
      process.stdout.write(JSON.stringify({ status: 'error', error: `Could not locate ${name}` }) + '\n');
      process.exit(2);
    }
    process.stdout.write(JSON.stringify({ status: 'error', error: `Unexpected error: ${err.message}` }) + '\n');
    process.exit(2);
  }
}

module.exports = { parseArgs, runWorkspaceSetup, main };
