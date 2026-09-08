'use strict';

/**
 * worktree-path.js
 * Pure path resolver for worktree layout and name templates.
 * No I/O, no fs, no child_process — pure computation only.
 *
 * Zero npm dependencies — Node.js built-ins only.
 */

const path = require('node:path');
const os   = require('node:os');

// ---------------------------------------------------------------------------
// Name template resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a nameTemplate string against branch/slug/date context.
 *
 * Supported placeholders: {slug}, {branch}, {date}, {issue}
 *
 * @param {string} nameTemplate
 * @param {object} ctx
 * @param {string} ctx.slug     Branch slugified for filesystem use.
 * @param {string} ctx.branch   Raw branch name.
 * @param {Date}   ctx.now      Current date (for {date} substitution).
 * @returns {string} Resolved name segment.
 * @throws {TypeError} On invalid template, missing {issue} digits, or path separator in result.
 */
function resolveName(nameTemplate, ctx) {
  const { slug, branch, now } = ctx;

  // Check {issue} requirement before substitution
  if (nameTemplate.includes('{issue}')) {
    const issueMatch = branch.match(/\d+/);
    if (!issueMatch) {
      throw new TypeError(
        `branch '${branch}' has no digits but nameTemplate uses {issue}`
      );
    }
  }

  // Compute date string YYYY-MM-DD in local timezone
  const d = now instanceof Date ? now : new Date();
  const year  = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day   = String(d.getDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${day}`;

  // Sanitize branch for {branch} placeholder: replace / with -
  const branchSanitized = branch.replace(/\//g, '-');

  // Extract issue number for {issue} placeholder
  const issueMatch = branch.match(/\d+/);
  const issue = issueMatch ? issueMatch[0] : '';

  let resolved = nameTemplate
    .replace(/\{slug\}/g,   slug)
    .replace(/\{branch\}/g, branchSanitized)
    .replace(/\{date\}/g,   dateStr)
    .replace(/\{issue\}/g,  issue);

  // Validate resolved name
  if (resolved === '') {
    throw new TypeError(`nameTemplate resolved to empty string`);
  }
  if (resolved.includes('/') || resolved.includes('\\')) {
    throw new TypeError(
      `nameTemplate resolved to '${resolved}' which contains path separator`
    );
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Layout path resolution
// ---------------------------------------------------------------------------

/**
 * Expand a leading `~` in a path string to the home directory.
 * @param {string} p   Path string (may start with `~`)
 * @param {string} home Home directory.
 * @returns {string}
 */
function expandHome(p, home) {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(home, p.slice(2));
  }
  return p;
}

/**
 * Validate that a path does not contain `..` traversal sequences.
 * @param {string} p
 * @throws {TypeError}
 */
function assertNoTraversal(p) {
  // Check both forward-slash and backslash segments
  const parts = p.split(/[/\\]/);
  if (parts.some(s => s === '..')) {
    throw new TypeError(`path '${p}' contains path traversal (..)`);
  }
}

/**
 * Resolve the filesystem path for a new git worktree.
 *
 * @param {object}  opts
 * @param {string}  opts.layout       One of: 'inside' | 'sibling' | 'central' | 'template'
 * @param {string}  [opts.base]       Base directory override (for inside/sibling/central).
 * @param {string}  [opts.template]   Path template (required for 'template' layout).
 * @param {string}  opts.repoRoot     Absolute path to the repository root.
 * @param {string}  opts.repoName     Repository name (basename of repoRoot).
 * @param {string}  opts.slug         Branch name slugified for filesystem use.
 * @param {string}  opts.branch       Raw branch name.
 * @param {string}  opts.home         Home directory (os.homedir()).
 * @param {string}  [opts.nameTemplate='{slug}'] Worktree name pattern.
 * @param {Date}    [opts.now]        Current date (for {date} in nameTemplate). Defaults to new Date().
 *
 * @returns {{ path: string, requiresGitignore: boolean, parentDir: string }}
 * @throws {TypeError} On invalid options, path traversal, missing template placeholder, or bad nameTemplate.
 */
function resolvePath(opts) {
  const {
    layout,
    base,
    template,
    repoRoot,
    repoName,
    slug,
    branch,
    home,
    nameTemplate = '{slug}',
    now,
  } = opts;

  if (!['inside', 'sibling', 'central', 'template'].includes(layout)) {
    throw new TypeError(`Invalid layout: '${layout}'. Must be one of: inside, sibling, central, template`);
  }

  const nowDate = now instanceof Date ? now : new Date();

  // Resolve the worktree's final name segment from nameTemplate
  const name = resolveName(nameTemplate, { slug, branch, now: nowDate });

  let worktreePath;
  let requiresGitignore = false;

  switch (layout) {
    case 'inside': {
      // Default base is repoRoot/.sdlc/worktrees
      const baseDir = base
        ? expandHome(base, home)
        : path.join(repoRoot, '.sdlc', 'worktrees');

      if (base) {
        assertNoTraversal(base);
        // Reject relative non-~ paths
        if (!path.isAbsolute(baseDir)) {
          throw new TypeError(`base '${base}' must be an absolute path or start with ~`);
        }
      }

      worktreePath = path.join(baseDir, name);

      // requiresGitignore when using default base (under repoRoot)
      const resolvedBase = base ? baseDir : path.join(repoRoot, '.sdlc', 'worktrees');
      if (worktreePath.startsWith(repoRoot + path.sep) || worktreePath.startsWith(repoRoot + '/')) {
        requiresGitignore = true;
      }
      break;
    }

    case 'sibling': {
      // Default base is parent of repoRoot
      const baseDir = base
        ? expandHome(base, home)
        : path.dirname(repoRoot);

      if (base) {
        assertNoTraversal(base);
        if (!path.isAbsolute(baseDir)) {
          throw new TypeError(`base '${base}' must be an absolute path or start with ~`);
        }
      }

      worktreePath = path.join(baseDir, `${repoName}-${name}`);
      requiresGitignore = false;
      break;
    }

    case 'central': {
      // Default base is ~/.sdlc/worktrees/<repoName>
      const baseDir = base
        ? expandHome(base, home)
        : path.join(home, '.sdlc', 'worktrees', repoName);

      if (base) {
        assertNoTraversal(base);
        if (!path.isAbsolute(baseDir)) {
          throw new TypeError(`base '${base}' must be an absolute path or start with ~`);
        }
      }

      worktreePath = path.join(baseDir, name);
      requiresGitignore = false;
      break;
    }

    case 'template': {
      if (!template) {
        throw new TypeError('template is required for layout=template');
      }
      assertNoTraversal(template);

      // Template must contain {slug} or {branch}
      if (!template.includes('{slug}') && !template.includes('{branch}')) {
        throw new TypeError('template must contain {slug} or {branch}');
      }

      // Expand ~ in template
      const expandedTemplate = expandHome(template, home);

      // Substitute {slug} with the resolved name (nameTemplate applied result),
      // and other placeholders with their values.
      // The {slug} in the path template is replaced with `name` for consistency.
      const d = nowDate;
      const year  = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day   = String(d.getDate()).padStart(2, '0');
      const dateStr = `${year}-${month}-${day}`;
      const branchSanitized = branch.replace(/\//g, '-');
      const issueMatch = branch.match(/\d+/);
      const issue = issueMatch ? issueMatch[0] : '';

      const resolved = expandedTemplate
        .replace(/\{repo\}/g,   repoName)
        .replace(/\{slug\}/g,   name)
        .replace(/\{branch\}/g, branchSanitized)
        .replace(/\{date\}/g,   dateStr)
        .replace(/\{issue\}/g,  issue);

      // Reject .. traversal in resolved template output
      const resolvedParts = resolved.split(/[/\\]/);
      if (resolvedParts.some(s => s === '..')) {
        throw new TypeError(`template resolved to '${resolved}' which contains path traversal (..)`);
      }

      worktreePath = resolved;
      requiresGitignore = false;
      break;
    }
  }

  const parentDir = path.dirname(worktreePath);

  return {
    path: worktreePath,
    requiresGitignore,
    parentDir,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  resolvePath,
};
