'use strict';

/**
 * workspace-context.js
 * Pure helper for workspace wizard context: path previews and .sdlc/ detection.
 *
 * Exports:
 *   buildPreview(cfg, repoContext) — compute a resolved path preview string.
 *   buildAllPreviews(repoContext)  — compute all 4 layout previews.
 *   detectconsumerCommitsSdlc(repoRoot) — returns true when .sdlc/ is committed (not gitignored).
 *   listExistingWorktrees(repoRoot) — returns [{branch, path}] for linked worktrees.
 *   computeMismatches(existing, layout, wtCfg, repoContext) — returns entries where
 *       current path differs from what layout would produce.
 *
 * Zero npm dependencies — Node.js built-ins only.
 */

const path = require('node:path');
const os   = require('node:os');
const { execFileSync } = require('node:child_process');
const { resolvePath } = require('./worktree-path');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SENTINEL_SLUG   = 'example-feature';
const SENTINEL_BRANCH = 'feat/351-example';

// ---------------------------------------------------------------------------
// buildPreview
// ---------------------------------------------------------------------------

/**
 * Compute a worktree path preview string using a sentinel slug.
 *
 * @param {object}  cfg          workspace.worktree config (may be partial or null).
 * @param {object}  repoContext  { repoRoot: string, repoName: string, home: string }
 * @returns {string}  Human-readable path preview, e.g. "/repo/.sdlc/worktrees/example-feature"
 *                    Returns empty string on resolution error.
 */
function buildPreview(cfg, repoContext) {
  const { repoRoot, repoName, home } = repoContext;
  const c = cfg || {};
  try {
    const result = resolvePath({
      layout:       c.layout       || 'inside',
      base:         c.base         || undefined,
      template:     c.template     || undefined,
      repoRoot,
      repoName,
      slug:         SENTINEL_SLUG,
      branch:       SENTINEL_BRANCH,
      home:         home || os.homedir(),
      nameTemplate: c.nameTemplate || '{slug}',
    });
    return result.path;
  } catch (_) {
    return '';
  }
}

/**
 * Compute path previews for all 4 layouts using the sentinel slug.
 *
 * @param {object} repoContext  { repoRoot: string, repoName: string, home: string }
 * @returns {{ inside: string, sibling: string, central: string, template: string }}
 */
function buildAllPreviews(repoContext) {
  const { repoRoot, repoName, home } = repoContext;
  const ctx = { repoRoot, repoName, home: home || os.homedir() };

  return {
    inside:   buildPreview({ layout: 'inside'   }, ctx),
    sibling:  buildPreview({ layout: 'sibling'  }, ctx),
    central:  buildPreview({ layout: 'central'  }, ctx),
    // template requires a valid template string — show placeholder
    template: path.join(home || os.homedir(), 'dev', 'wt', repoName, SENTINEL_SLUG),
  };
}

// ---------------------------------------------------------------------------
// detectconsumerCommitsSdlc
// ---------------------------------------------------------------------------

/**
 * Return true when the `.sdlc/` directory is NOT gitignored in the given
 * repo root — i.e. the consumer commits `.sdlc/` to version control.
 *
 * Uses `git check-ignore -q .sdlc/` (exit 0 = ignored, exit 1 = not ignored).
 * Returns false on any error (git not available, not a git repo, etc.).
 *
 * @param {string} repoRoot  Absolute path to the git repository root.
 * @returns {boolean}
 */
function detectconsumerCommitsSdlc(repoRoot) {
  try {
    execFileSync('git', ['check-ignore', '-q', '.sdlc/'], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    // exit 0 → .sdlc/ IS gitignored → consumer does NOT commit it
    return false;
  } catch (err) {
    if (err.status === 1) {
      // exit 1 → .sdlc/ is NOT gitignored → consumer commits it
      return true;
    }
    // Other errors (non-git dir, missing binary, etc.) — safe default
    return false;
  }
}

// ---------------------------------------------------------------------------
// listExistingWorktrees
// ---------------------------------------------------------------------------

/**
 * Parse `git worktree list --porcelain` and return the linked worktrees
 * (all entries except the first, which is always the main worktree).
 *
 * @param {string} repoRoot  Absolute path to the git repository root.
 * @returns {Array<{branch: string|null, worktreePath: string}>}
 *   Empty array when git fails or there are no linked worktrees.
 */
function listExistingWorktrees(repoRoot) {
  let out;
  try {
    out = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
  } catch (_) {
    return [];
  }

  const entries = [];
  let current = {};
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { worktreePath: line.slice(9).trim() };
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    } else if (line === '') {
      if (current.worktreePath) entries.push(current);
      current = {};
    }
  }
  if (current.worktreePath) entries.push(current);

  // Skip the first entry (main worktree) and bare worktrees
  return entries.slice(1).filter(e => !e.bare);
}

// ---------------------------------------------------------------------------
// computeMismatches
// ---------------------------------------------------------------------------

/**
 * For a given layout, identify which existing linked worktrees would be at
 * different paths than the layout would produce for their branch.
 *
 * Used by setup.js to pre-compute `mismatchesByLayout` so SKILL.md can
 * display a safety warning without any LLM logic.
 *
 * @param {Array<{branch: string|null, worktreePath: string}>} existing
 *   Result of listExistingWorktrees().
 * @param {string} layout  One of: 'inside', 'sibling', 'central', 'template'.
 * @param {object} wtCfg   workspace.worktree config (may be {}).
 * @param {object} repoContext  { repoRoot, repoName, home }
 * @returns {Array<{branch: string|null, currentPath: string, expectedPath: string}>}
 *   Only entries where currentPath !== expectedPath. Empty when all match.
 */
function computeMismatches(existing, layout, wtCfg, repoContext) {
  if (!existing || existing.length === 0) return [];
  const { repoRoot, repoName, home } = repoContext;
  const mismatches = [];

  for (const entry of existing) {
    const { worktreePath, branch } = entry;
    if (!branch) continue; // detached HEAD — skip, no slug to compute

    // Slugify: same logic as worktree-doctor and worktree-create
    const slug = branch.replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();

    let expectedPath;
    try {
      const resolved = resolvePath({
        layout,
        base:         wtCfg.base         || undefined,
        template:     wtCfg.template     || undefined,
        repoRoot,
        repoName,
        slug,
        branch,
        home:         home || os.homedir(),
        nameTemplate: wtCfg.nameTemplate || '{slug}',
      });
      expectedPath = resolved.path;
    } catch (_) {
      continue; // can't compute expected path — skip entry
    }

    if (worktreePath !== expectedPath) {
      mismatches.push({ branch, currentPath: worktreePath, expectedPath });
    }
  }

  return mismatches;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildPreview,
  buildAllPreviews,
  detectconsumerCommitsSdlc,
  listExistingWorktrees,
  computeMismatches,
};
