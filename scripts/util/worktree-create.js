#!/usr/bin/env node
/**
 * worktree-create.js
 * Collision-safe git worktree creation for Lift-SDLC.
 *
 * Usage:
 *   node worktree-create.js --name <branch-name>
 *
 * Outputs JSON to stdout:
 *   Success: { "branch": "<final-name>", "path": "<abs-worktree-path>" }
 *   Failure: { "error": "<message>" }
 *
 * Exit codes:
 *   0 = success
 *   1 = failure (JSON error object on stdout)
 *
 * Worktree placement is driven by workspace.worktree config (issue #351).
 * Falls back to inside layout at .sdlc/worktrees/<slug> when no config exists.
 *
 * Zero npm dependencies — Node.js built-ins only.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { execFileSync } = require('node:child_process');
const LIB  = path.join(__dirname, '..', 'lib');

const { exec }                          = require(path.join(LIB, 'git'));
const { readSection, resolveSdlcRoot }  = require(path.join(LIB, 'config'));
const { resolvePath }                   = require(path.join(LIB, 'worktree-path'));
const { resolveMainWorktreeSafe }       = require(path.join(LIB, 'worktree'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a branch name to a filesystem-safe slug.
 * Replaces any character that is not alphanumeric or a hyphen with `-`.
 * @param {string} name
 * @returns {string}
 */
function slugify(name) {
  return name.replace(/[^a-zA-Z0-9-]/g, '-');
}

/**
 * Validate that a branch name contains only safe characters for git refs.
 * Rejects shell metacharacters to prevent command injection via exec().
 * Allowed: alphanumeric, forward slash, hyphen, underscore, dot.
 * @param {string} name
 * @returns {boolean}
 */
function isValidBranchName(name) {
  return /^[a-zA-Z0-9/_.\-]+$/.test(name) && !/\.\./.test(name) && !name.endsWith('.lock');
}

/**
 * Check whether a local git branch already exists.
 * Uses execFileSync (no shell) so the branch name cannot be interpreted as a
 * shell expression — defense-in-depth alongside isValidBranchName.
 * @param {string} branchName
 * @returns {boolean}
 */
function branchExists(branchName) {
  try {
    execFileSync(
      'git',
      ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
      { stdio: 'ignore' }
    );
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Check whether a worktree directory already exists on disk.
 * @param {string} worktreePath
 * @returns {boolean}
 */
function worktreePathExists(worktreePath) {
  return fs.existsSync(worktreePath);
}

/**
 * Generate a short unique suffix from the last 5 digits of Date.now().
 * @returns {string}
 */
function shortSuffix() {
  return String(Date.now()).slice(-5);
}

/**
 * Load the workspace.worktree config section from the main worktree.
 * Returns null when no config is available (non-git, no .sdlc, etc.).
 * @returns {object|null}
 */
function loadWorktreeConfig() {
  try {
    const projectRoot = resolveSdlcRoot();
    const workspace = readSection(projectRoot, 'workspace');
    return (workspace && workspace.worktree) ? workspace.worktree : null;
  } catch (_) {
    return null;
  }
}

/**
 * Given a desired branch name and worktree config, find a path+name variant
 * that does not collide with any existing branch name or worktree directory.
 *
 * @param {string} desiredName   Raw branch name (not yet slugified).
 * @param {object} wtCfg         workspace.worktree config (may be null).
 * @returns {{ finalName: string, worktreePath: string }}
 */
function resolveUniquePath(desiredName, wtCfg) {
  const cfg = wtCfg || {};
  const layout = cfg.layout || 'inside';
  const mainWorktree = resolveMainWorktreeSafe();
  const repoName = path.basename(mainWorktree);
  const home = os.homedir();

  let candidate = desiredName;

  // Retry up to 10 times (astronomically unlikely to need more than 1-2)
  for (let i = 0; i < 10; i++) {
    const slug = slugify(candidate);

    let resolvedPath;
    try {
      const resolved = resolvePath({
        layout,
        base:         cfg.base,
        template:     cfg.template,
        repoRoot:     mainWorktree,
        repoName,
        slug,
        branch:       candidate,
        home,
        nameTemplate: cfg.nameTemplate || '{slug}',
      });
      resolvedPath = resolved.path;
    } catch (err) {
      // Config is invalid / nameTemplate fails for this branch name.
      // Warn the user so they know their workspace.worktree config did not
      // apply, then fall back to the inside layout default.
      process.stderr.write(
        `warning: workspace.worktree config did not resolve for branch "${candidate}" ` +
        `(layout=${layout}): ${err.message}. Falling back to inside layout default.\n`
      );
      resolvedPath = path.join(mainWorktree, '.sdlc', 'worktrees', slug);
    }

    if (!branchExists(candidate) && !worktreePathExists(resolvedPath)) {
      return { finalName: candidate, worktreePath: resolvedPath };
    }

    // Append suffix to the original desired name (not to a previously suffixed one)
    candidate = `${desiredName}-${shortSuffix()}`;
  }

  throw new Error(`Could not find a unique branch name for "${desiredName}" after 10 attempts`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  let name = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) {
      name = args[++i];
    }
  }

  return { name };
}

function fail(message) {
  process.stdout.write(JSON.stringify({ error: message }) + '\n');
  process.exit(1);
}

function main() {
  const { name } = parseArgs(process.argv);

  if (!name) {
    fail('Missing required argument: --name <branch-name>');
    return;
  }

  if (!isValidBranchName(name)) {
    fail(`Invalid branch name "${name}". Only alphanumeric, /, -, _, and . characters are allowed.`);
    return;
  }

  // Load config-driven layout
  const wtCfg = loadWorktreeConfig();

  // Resolve a unique branch name / worktree path
  let finalName, worktreePath;
  try {
    ({ finalName, worktreePath } = resolveUniquePath(name, wtCfg));
  } catch (err) {
    fail(err.message);
    return;
  }

  // Ensure the parent directory exists
  const parentDir = path.dirname(worktreePath);
  try {
    fs.mkdirSync(parentDir, { recursive: true });
  } catch (err) {
    fail(`Failed to create parent directory "${parentDir}": ${err.message}`);
    return;
  }

  // Create the worktree (git creates the worktree directory itself)
  try {
    exec(
      `git worktree add ${worktreePath} -b ${finalName}`,
      { throwOnError: true }
    );
  } catch (err) {
    fail(`git worktree add failed for branch "${finalName}" at path "${worktreePath}": ${err.message}`);
    return;
  }

  process.stdout.write(JSON.stringify({ branch: finalName, path: worktreePath }) + '\n');
  process.exit(0);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({ error: `Unexpected error: ${err.message}` }) + '\n');
    process.exit(1);
  }
}
