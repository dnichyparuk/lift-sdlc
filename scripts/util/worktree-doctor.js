#!/usr/bin/env node
'use strict';

/**
 * worktree-doctor.js — diagnostic CLI for git worktree health.
 *
 * Usage:
 *   node scripts/util/worktree-doctor.js [--json]
 *
 * Checks each linked worktree:
 *   - Layout match: is the path where the current config would place it?
 *   - Gitignore coverage: is the path ignored by git?
 *   - Config resolution: does .sdlc/local.json inside the linked cwd differ
 *     from the main worktree's .sdlc/local.json?
 *   - Orphan status: does the branch still exist?
 *
 * Exit codes:
 *   0 — all clean
 *   1 — issues found
 *
 * Zero npm dependencies — Node.js built-ins only (issue #351).
 */

const path     = require('node:path');
const fs       = require('node:fs');
const { execFileSync } = require('node:child_process');

const LIB = path.join(__dirname, '..', 'lib');

const { resolveMainWorktree, resolveMainWorktreeSafe } = require(path.join(LIB, 'worktree'));
const { readSection, resolveSdlcRoot }                  = require(path.join(LIB, 'config'));
const { resolvePath }                                    = require(path.join(LIB, 'worktree-path'));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run git command, return trimmed stdout or null on failure. */
function runGit(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  } catch (_) {
    return null;
  }
}

/** Parse `git worktree list --porcelain` output into an array of entries. */
function parseWorktreeList(output) {
  const entries = [];
  let current = {};
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { worktreePath: line.slice(9).trim() };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice(5).trim();
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    } else if (line === 'bare') {
      current.bare = true;
    } else if (line === '') {
      if (current.worktreePath) entries.push(current);
      current = {};
    }
  }
  if (current.worktreePath) entries.push(current);
  return entries;
}

/** Slug a branch name for filesystem use (replaces non-alphanumeric with -). */
function slugify(branch) {
  return branch.replace(/[^a-z0-9]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args    = process.argv.slice(2);
  const wantJson = args.includes('--json');

  let mainWorktree;
  try {
    mainWorktree = resolveMainWorktree();
  } catch (err) {
    if (wantJson) {
      console.log(JSON.stringify({ ok: false, error: err.message }));
    } else {
      process.stderr.write(`worktree-doctor: could not resolve main worktree — ${err.message}\n`);
    }
    process.exit(1);
  }

  const rawList = runGit(['worktree', 'list', '--porcelain'], mainWorktree);
  if (!rawList) {
    const msg = 'worktree-doctor: git worktree list failed';
    if (wantJson) console.log(JSON.stringify({ ok: false, error: msg }));
    else process.stderr.write(msg + '\n');
    process.exit(1);
  }

  const entries = parseWorktreeList(rawList);
  // First entry is always the main worktree — skip it.
  const linked = entries.slice(1).filter(e => !e.bare);

  if (linked.length === 0) {
    if (wantJson) {
      console.log(JSON.stringify({ ok: true, worktrees: [], issues: [], message: '0 issues found' }));
    } else {
      console.log('0 issues found (no linked worktrees)');
    }
    process.exit(0);
  }

  // Load workspace config for layout-match checks.
  const projectRoot  = resolveSdlcRoot({ cwd: mainWorktree });
  const workspaceCfg = readSection(projectRoot, 'workspace') || {};
  const wtCfg        = workspaceCfg.worktree || {};
  const layout       = wtCfg.layout || 'inside';
  const repoName     = path.basename(mainWorktree);
  const home         = process.env.HOME || process.env.USERPROFILE || '/tmp';

  const issues = [];
  const worktrees = [];
  const migrations = [];

  for (const entry of linked) {
    const { worktreePath, branch, head } = entry;
    const checks = [];
    const slug = branch ? slugify(branch) : path.basename(worktreePath);

    // 1. Layout match check
    let expectedPath = null;
    try {
      const resolved = resolvePath({
        layout,
        base: wtCfg.base,
        template: wtCfg.template,
        repoRoot: mainWorktree,
        repoName,
        slug,
        branch: branch || slug,
        home,
        nameTemplate: wtCfg.nameTemplate || '{slug}',
      });
      expectedPath = resolved.path;
    } catch (_) {
      // Config may be invalid — skip layout check
    }

    const layoutMatch = expectedPath ? worktreePath === expectedPath : null;
    if (expectedPath && !layoutMatch) {
      checks.push({ check: 'layout-match', status: 'fail', current: worktreePath, expected: expectedPath });
      issues.push({
        worktreePath,
        branch: branch || null,
        type: 'layout-mismatch',
        detail: `path differs from configured layout=${layout}: expected ${expectedPath}`,
      });
      // Emit migration hint
      migrations.push({ from: worktreePath, to: expectedPath, branch: branch || null });
    } else {
      checks.push({ check: 'layout-match', status: layoutMatch === null ? 'skip' : 'pass' });
    }

    // 2. Gitignore coverage check
    const ignored = runGit(['check-ignore', '-q', worktreePath], mainWorktree);
    // git check-ignore: exits 0 when ignored, 1 when not
    const isIgnored = ignored !== null;
    checks.push({ check: 'gitignore', status: isIgnored ? 'pass' : 'warn' });
    if (!isIgnored) {
      issues.push({
        worktreePath,
        branch: branch || null,
        type: 'not-gitignored',
        detail: `worktree path is not covered by .gitignore — may be accidentally committed`,
      });
    }

    // 3. Config resolution check: linked cwd .sdlc/local.json vs main
    const linkedLocalPath = path.join(worktreePath, '.sdlc', 'local.json');
    if (fs.existsSync(linkedLocalPath)) {
      let linkedData, mainData;
      try {
        linkedData = JSON.parse(fs.readFileSync(linkedLocalPath, 'utf8'));
        const mainLocalPath = path.join(mainWorktree, '.sdlc', 'local.json');
        mainData = fs.existsSync(mainLocalPath)
          ? JSON.parse(fs.readFileSync(mainLocalPath, 'utf8'))
          : null;
      } catch (_) {
        linkedData = null;
      }
      const mismatch = linkedData !== null && JSON.stringify(linkedData) !== JSON.stringify(mainData);
      checks.push({ check: 'config-resolution', status: mismatch ? 'fail' : 'pass' });
      if (mismatch) {
        issues.push({
          worktreePath,
          branch: branch || null,
          type: 'config-resolution-mismatch',
          detail: `linked cwd has .sdlc/local.json different from main worktree — reads will return stale values`,
        });
      }
    } else {
      checks.push({ check: 'config-resolution', status: 'pass' });
    }

    // 4. Orphan check: branch should still exist
    if (branch) {
      const branchExists = runGit(['rev-parse', '--verify', `refs/heads/${branch}`], mainWorktree);
      const isOrphan = branchExists === null;
      checks.push({ check: 'orphan', status: isOrphan ? 'fail' : 'pass' });
      if (isOrphan) {
        issues.push({
          worktreePath,
          branch,
          type: 'orphan-worktree',
          detail: `branch '${branch}' no longer exists but worktree directory remains`,
        });
      }
    } else {
      checks.push({ check: 'orphan', status: 'skip' });
    }

    worktrees.push({
      path: worktreePath,
      branch: branch || null,
      head: head || null,
      checks,
    });
  }

  if (wantJson) {
    const result = {
      ok: issues.length === 0,
      worktrees,
      issues,
      migrations,
      message: `${issues.length} issue${issues.length === 1 ? '' : 's'} found`,
    };
    console.log(JSON.stringify(result, null, 2));
  } else {
    // Human-readable output
    for (const wt of worktrees) {
      const label = wt.branch ? `${wt.path}  (branch: ${wt.branch})` : wt.path;
      const wtIssues = issues.filter(i => i.worktreePath === wt.path);
      if (wtIssues.length === 0) {
        console.log(`✓  ${label}`);
      } else {
        for (const issue of wtIssues) {
          console.log(`✗  ${label}`);
          console.log(`   ${issue.type}: ${issue.detail}`);
        }
      }
    }

    // Migration hints
    if (migrations.length > 0) {
      console.log('');
      console.log('Migration hints (layout has changed — worktrees not moved automatically):');
      for (const m of migrations) {
        console.log(`  git worktree move ${m.from} ${m.to}`);
      }
      console.log('');
      console.log('Run `node scripts/util/worktree-doctor.js` again after migrating to verify.');
    }

    const count = issues.length;
    console.log(`\n${count} issue${count === 1 ? '' : 's'} found`);
  }

  process.exit(issues.length === 0 ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = { parseWorktreeList, slugify };
