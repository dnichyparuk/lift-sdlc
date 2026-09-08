'use strict';

/**
 * workspace-fields.js
 * Field descriptors for the workspace.worktree wizard step.
 *
 * Shape follows ship-fields.js:
 *   { name, label, type, options, default, description, validate?, preview? }
 *
 * The `validate` function is called with the raw user input string.
 * The `preview` function is called with (value, repoContext) and returns a
 * human-readable preview string for inline display during the wizard.
 *
 * Zero npm dependencies — Node.js built-ins only.
 */

const path = require('node:path');
const { resolvePath } = require('./worktree-path');

// Sentinel branch/slug used for live previews during validation.
const SENTINEL_SLUG   = 'example-feature';
const SENTINEL_BRANCH = 'feat/351-example';

// ---------------------------------------------------------------------------
// Field: layout
// ---------------------------------------------------------------------------

/**
 * layout — enum, required.
 * Controls where git worktrees are placed relative to the repo root.
 */
const LAYOUT_FIELD = {
  name:    'layout',
  label:   'Worktree placement layout',
  type:    'enum',
  options: ['inside', 'sibling', 'central', 'template'],
  default: 'inside',
  description:
    'Controls where /worktree-create, /execute-plan-sdlc, and /ship-sdlc place git worktrees. ' +
    '`inside` (default) puts them under .sdlc/worktrees/ in the repo; ' +
    '`sibling` places them adjacent to the repo directory; ' +
    '`central` stores them under ~/.sdlc/worktrees/<repo>; ' +
    '`template` uses a fully custom path template with {slug}/{branch}/{repo}/{date}/{issue} placeholders.',
  /**
   * Generate the numbered-menu help text including live path previews.
   * Called from SKILL.md with repoContext = { repoRoot, repoName, home, consumerCommitsSdlc }.
   */
  help(repoContext) {
    const { repoRoot, repoName, home, consumerCommitsSdlc } = repoContext;
    const { buildAllPreviews } = require('./workspace-context');
    const previews = buildAllPreviews({ repoRoot, repoName, home });

    const antigravityStatus = consumerCommitsSdlc
      ? '.sdlc/ IS committed — worktree contents will be tracked unless gitignored'
      : '.sdlc/ is gitignored — safe to use inside layout';

    return [
      'Where should sdlc create git worktrees?',
      '(Affects /ship-sdlc --workspace worktree and /execute-plan-sdlc --workspace worktree.)',
      '',
      `  1. inside    ${previews.inside}`,
      '              → Standard Antigravity Code convention. Auto-adds the path to',
      '                .gitignore if your project commits .sdlc/.',
      `              → Detected: ${antigravityStatus}`,
      '',
      `  2. sibling   ${previews.sibling}`,
      '              → Stays out of .sdlc/. Best when you keep multiple worktrees',
      '                open in your editor side-by-side.',
      '',
      `  3. central   ${previews.central}`,
      '              → Centralizes worktrees across all repos. Good for power users.',
      '',
      `  4. template  Custom path with placeholders (advanced)`,
      `              → e.g. ~/dev/wt/{repo}/{branch}`,
      '              → Available placeholders: {repo} {slug} {branch} {date} {issue}',
    ].join('\n');
  },
  validate(v) {
    if (!['inside', 'sibling', 'central', 'template'].includes(v)) {
      throw new TypeError(`Invalid layout "${v}". Must be one of: inside, sibling, central, template`);
    }
    return true;
  },
};

// ---------------------------------------------------------------------------
// Field: base
// ---------------------------------------------------------------------------

/**
 * base — string, optional, shown for inside/sibling/central layouts.
 * Override the default base directory for the chosen layout.
 */
const BASE_FIELD = {
  name:    'base',
  label:   'Base directory override',
  type:    'string',
  options: null,
  default: '',
  description:
    'Optional override for the base directory where worktrees are placed. ' +
    'Leave blank to use the layout default. ' +
    'Must be an absolute path or start with ~ (e.g. ~/dev/worktrees). ' +
    'Relative paths and path traversal sequences (..) are rejected.',
  help(layout, repoContext) {
    const defaults = {
      inside:  `${repoContext.repoRoot}/.sdlc/worktrees/`,
      sibling: `${path.dirname(repoContext.repoRoot)}/`,
      central: `${repoContext.home}/.sdlc/worktrees/${repoContext.repoName}/`,
    };
    return [
      'Override the base directory? Leave blank to use the layout\'s default.',
      '',
      'Accepted formats:',
      '  /absolute/path    e.g. /Users/you/dev/worktrees',
      '  ~/path            e.g. ~/dev/worktrees   (expanded to your home dir)',
      '',
      'Relative paths (../foo, ./foo) are rejected — worktree paths must be',
      'resolvable from any cwd. Path-traversal sequences (..) anywhere in the',
      'string are rejected.',
      '',
      `Default for ${layout} layout: ${defaults[layout] || '(see layout docs)'}`,
    ].join('\n');
  },
  validate(v, layout, repoContext) {
    if (!v || v.trim() === '') return true; // blank = use default, OK
    // Path traversal check
    const parts = v.split(/[/\\]/);
    if (parts.some(p => p === '..')) {
      throw new TypeError(`base "${v}" contains path traversal (..)`);
    }
    // Relative non-~ paths rejected
    if (!path.isAbsolute(v) && !v.startsWith('~')) {
      throw new TypeError(`base "${v}" must be an absolute path or start with ~`);
    }
    // Dry-run with sentinel to confirm layout resolves
    const home = repoContext.home;
    const expandedBase = v.startsWith('~/') ? path.join(home, v.slice(2)) : v;
    resolvePath({
      layout: layout || 'inside',
      base: v,
      repoRoot: repoContext.repoRoot,
      repoName: repoContext.repoName,
      slug: SENTINEL_SLUG,
      branch: SENTINEL_BRANCH,
      home,
    });
    return true;
  },
  preview(v, layout, repoContext) {
    if (!v || v.trim() === '') return '';
    const home = repoContext.home;
    try {
      const result = resolvePath({
        layout: layout || 'inside',
        base: v,
        repoRoot: repoContext.repoRoot,
        repoName: repoContext.repoName,
        slug: SENTINEL_SLUG,
        branch: SENTINEL_BRANCH,
        home,
      });
      return `Preview: ${result.path}`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },
};

// ---------------------------------------------------------------------------
// Field: template
// ---------------------------------------------------------------------------

/**
 * template — string, required when layout=template.
 * Full path template with {slug}/{branch}/{repo}/{date}/{issue} placeholders.
 */
const TEMPLATE_FIELD = {
  name:    'template',
  label:   'Custom path template',
  type:    'string',
  options: null,
  default: '',
  description:
    'Required for layout=template. Full path template using {slug}, {branch}, {repo}, {date}, {issue} ' +
    'placeholders. Must contain at least {slug} or {branch}. ' +
    'Example: ~/dev/wt/{repo}/{slug} → ~/dev/wt/myapp/example-feature.',
  help() {
    return [
      'Template syntax — at least one of {slug} or {branch} required.',
      '',
      '  {repo}    your repo\'s directory name (basename)',
      '  {slug}    branch name slugified for filesystem use (recommended)',
      '  {branch}  raw branch name with \'/\' replaced by \'-\'',
      '  {date}    today\'s date as YYYY-MM-DD (local timezone)',
      '  {issue}   first digit-run extracted from the branch name',
      '            (e.g. feat/351-foo → \'351\'; error if branch has no digits)',
      '',
      'Examples:',
      '  ~/dev/wt/{repo}/{slug}     → ~/dev/wt/myapp/example-feature',
      '  /tmp/sdlc-worktrees/{slug} → /tmp/sdlc-worktrees/example-feature',
      '  ~/wt/{repo}-{branch}       → ~/wt/myapp-feat-login-redesign',
    ].join('\n');
  },
  validate(v, repoContext) {
    if (!v || v.trim() === '') {
      throw new TypeError('template is required for layout=template');
    }
    if (!v.includes('{slug}') && !v.includes('{branch}')) {
      throw new TypeError('template must contain {slug} or {branch}');
    }
    // Dry-run to catch traversal and other errors
    resolvePath({
      layout: 'template',
      template: v,
      repoRoot: repoContext.repoRoot,
      repoName: repoContext.repoName,
      slug: SENTINEL_SLUG,
      branch: SENTINEL_BRANCH,
      home: repoContext.home,
    });
    return true;
  },
  preview(v, repoContext) {
    if (!v || v.trim() === '') return '';
    try {
      const result = resolvePath({
        layout: 'template',
        template: v,
        repoRoot: repoContext.repoRoot,
        repoName: repoContext.repoName,
        slug: SENTINEL_SLUG,
        branch: SENTINEL_BRANCH,
        home: repoContext.home,
      });
      return `Preview: ${result.path}`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },
};

// ---------------------------------------------------------------------------
// Field: ensureGitignore
// ---------------------------------------------------------------------------

/**
 * ensureGitignore — boolean, optional, shown for inside layout.
 * When true, adds .sdlc/worktrees/ to root .gitignore managed block.
 */
const ENSURE_GITIGNORE_FIELD = {
  name:    'ensureGitignore',
  label:   'Auto-update root .gitignore',
  type:    'boolean',
  options: ['yes', 'no'],
  default: true,
  description:
    'When true and layout=inside, each session start automatically adds `.sdlc/worktrees/` to ' +
    'the repo\'s root .gitignore managed block so worktree contents are never tracked by git. ' +
    'Recommended when your project commits .sdlc/ to version control. ' +
    'Only applies to layout=inside.',
  help() {
    return [
      'Auto-add `.sdlc/worktrees/` to your repo\'s root .gitignore (managed block)',
      'so worktree contents are never tracked? Recommended when your project',
      'commits `.sdlc/`. [Y/n]',
    ].join('\n');
  },
  validate(v) {
    if (typeof v === 'boolean') return true;
    if (v === true || v === false || v === 'yes' || v === 'no' || v === 'true' || v === 'false') {
      return true;
    }
    throw new TypeError(`ensureGitignore must be yes/no, got "${v}"`);
  },
};

// ---------------------------------------------------------------------------
// Field: nameTemplate
// ---------------------------------------------------------------------------

/**
 * nameTemplate — string, optional, shown for all layouts.
 * Controls the final directory name component of the worktree path.
 */
const NAME_TEMPLATE_FIELD = {
  name:    'nameTemplate',
  label:   'Worktree name pattern',
  type:    'string',
  options: null,
  default: '{slug}',
  description:
    'Pattern for the worktree\'s final directory name. Default `{slug}` is the branch slugified. ' +
    'Placeholders: {slug} {branch} {date} {issue}. ' +
    'Example `{date}-{slug}` produces `2026-05-12-feat-login-redesign`.',
  help() {
    return [
      'Worktree directory name pattern. Controls the final folder name, separate',
      'from where it\'s placed.',
      '',
      'Placeholders:',
      '  {slug}    branch slugified (default behavior)',
      '  {branch}  raw branch name with \'/\' replaced by \'-\'',
      '  {date}    today\'s date as YYYY-MM-DD (local timezone)',
      '  {issue}   first digit-run extracted from the branch name',
      '            (e.g. feat/351-foo → \'351\'; error if branch has no digits)',
      '',
      'Examples:',
      '  {slug}           feat-login-redesign         (default)',
      '  {date}-{slug}    2026-05-12-feat-login-redesign',
      '  {issue}-{slug}   351-feat-login-redesign',
      '  {slug}-impl      feat-login-redesign-impl    (multi-worktree per branch)',
    ].join('\n');
  },
  validate(v, repoContext) {
    if (!v || v.trim() === '') {
      throw new TypeError('nameTemplate cannot be empty; use {slug} for the default behavior');
    }
    // Dry-run with sentinel branch (includes digits for {issue}) to catch errors
    try {
      resolvePath({
        layout: 'inside',
        repoRoot: repoContext.repoRoot,
        repoName: repoContext.repoName,
        slug: 'example-feature',
        branch: 'feat/351-example',
        home: repoContext.home,
        nameTemplate: v,
      });
    } catch (err) {
      throw new TypeError(`nameTemplate "${v}" is invalid: ${err.message}`);
    }
    return true;
  },
  preview(v, repoContext) {
    if (!v || v.trim() === '') return '';
    try {
      const result = resolvePath({
        layout: 'inside',
        repoRoot: repoContext.repoRoot,
        repoName: repoContext.repoName,
        slug: 'example-feature',
        branch: 'feat/351-example',
        home: repoContext.home,
        nameTemplate: v,
      });
      return `Preview name: ${path.basename(result.path)}`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
  },
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

const WORKSPACE_FIELDS = [
  LAYOUT_FIELD,
  BASE_FIELD,
  TEMPLATE_FIELD,
  ENSURE_GITIGNORE_FIELD,
  NAME_TEMPLATE_FIELD,
];

module.exports = {
  WORKSPACE_FIELDS,
  LAYOUT_FIELD,
  BASE_FIELD,
  TEMPLATE_FIELD,
  ENSURE_GITIGNORE_FIELD,
  NAME_TEMPLATE_FIELD,
};
