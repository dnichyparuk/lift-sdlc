#!/usr/bin/env node
/**
 * review-prepare.js
 * Pre-computes all data needed for the review-sdlc skill:
 * git state, changed files, dimension matching, diff splitting,
 * commit context, PR metadata. Outputs JSON manifest + per-dimension
 * .diff files to a temp directory.
 *
 * Usage:
 *   node review-prepare.js [options]
 *
 * Options:
 *   --project-root <path>     Project root (default: cwd)
 *   --base <branch>           Base branch (auto-detect if omitted)
 *   --dimensions <name,...>   Filter to named dimensions only
 *   --json                    JSON output to stdout (default)
 *
 * Exit codes: 0 = success, 1 = no dimensions or no changes, 2 = script error
 * Stdout: JSON manifest
 * Stderr: warnings/progress
 * Side effect: writes .diff files to OS temp dir
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const os   = require('node:os');
const LIB = path.join(__dirname, '..', 'lib');

const { validateAll, extractFrontmatter, extractBody, parseSimpleYaml, resolveDimensionsDir } = require(path.join(LIB, 'dimensions'));
const {
  exec,
  checkGitState,
  detectBaseBranch,
  fetchBaseRef,
  buildBranchContribDiffCmd,
  getChangedFiles,
  getCommitLog,
  getCommitCount,
  fetchPrMetadata,
  ensureGhAccount,
  splitDiffByFile,
} = require(path.join(LIB, 'git'));
const { readSection, writeLocalConfig, resolveSdlcRoot } = require(path.join(LIB, 'config'));
const { writeOutput } = require(path.join(LIB, 'output'));
const { resolveSkipConfigCheck, ensureConfigVersion } = require(path.join(LIB, 'config-version-prepare'));
const { getPluginVersion } = require(path.join(LIB, 'config-version'));

// ---------------------------------------------------------------------------
// Review config (.sdlc/review.json)
// ---------------------------------------------------------------------------

const VALID_SCOPES = ['all', 'committed', 'staged', 'working', 'worktree'];

function readReviewConfig(projectRoot) {
  let review;
  try {
    review = readSection(projectRoot, 'review');
  } catch (err) {
    process.stderr.write(`Warning: invalid review config: ${err.message}\n`);
    return null;
  }
  if (!review) return null;

  // Wrap into the shape the rest of review-prepare.js expects: { defaults: { scope, ... } }
  const config = { defaults: review };
  if (config.defaults.scope && !VALID_SCOPES.includes(config.defaults.scope)) {
    process.stderr.write(
      `Warning: invalid scope "${config.defaults.scope}" in review config. ` +
      `Valid: ${VALID_SCOPES.join(', ')}. Using default "all".\n`
    );
    config.defaults.scope = 'all';
  }
  return config;
}

function writeReviewConfig(projectRoot, updates) {
  // updates has shape { defaults: { scope, ... } } — map to local config shape { review: { scope, ... } }
  const review = { ...(updates.defaults || {}) };
  writeLocalConfig(projectRoot, { review });
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  let projectRoot = resolveSdlcRoot(); // issue #351: route to main worktree .sdlc/ (overridable via --project-root)
  let baseBranch = null;
  let dimensionFilter = null;
  let scope = null;
  let setDefault = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--project-root' && args[i + 1]) projectRoot = path.resolve(args[++i]);
    else if (a === '--base' && args[i + 1]) baseBranch = args[++i];
    else if (a === '--dimensions' && args[i + 1]) dimensionFilter = args[++i].split(',').map(s => s.trim());
    else if (a === '--committed')   scope = 'committed';
    else if (a === '--staged')      scope = 'staged';
    else if (a === '--working')     scope = 'working';
    else if (a === '--worktree')    scope = 'worktree';
    else if (a === '--set-default') setDefault = true;
  }

  return { projectRoot, baseBranch, dimensionFilter, scope, setDefault };
}

// ---------------------------------------------------------------------------
// Glob matching
// ---------------------------------------------------------------------------

/**
 * Convert a glob pattern to a RegExp.
 * Handles the patterns used in review dimension files:
 *   **\/   — zero or more directory segments
 *   **     — any sequence of characters (including slashes)
 *   *      — any chars within a single path segment (no slash)
 *   ?      — single char (no slash)
 *   [...]  — character class
 *   .      — literal dot (escaped)
 */
function globToRegex(pattern) {
  let re = '';
  let i = 0;
  const len = pattern.length;

  while (i < len) {
    const ch = pattern[i];

    if (ch === '*') {
      if (i + 1 < len && pattern[i + 1] === '*') {
        if (i + 2 < len && pattern[i + 2] === '/') {
          re += '(?:[^/]+/)*';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) {
        re += '\\[';
        i++;
      } else {
        re += pattern.slice(i, close + 1);
        i = close + 1;
      }
    } else if ('.+^${}()|\\'.includes(ch)) {
      re += '\\' + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }

  return new RegExp('^' + re + '$');
}

/**
 * Match a list of changed files against a dimension's trigger/skip-when globs.
 * Returns { matched: string[], truncated: boolean }
 */
function matchFiles(dimension, changedFiles) {
  const triggers = (dimension.triggers    || []).map(globToRegex);
  const skipWhen = (dimension['skip-when'] || []).map(globToRegex);
  const maxFiles = dimension['max-files'] || 100;

  let matched = changedFiles.filter(f =>
    triggers.some(re => re.test(f)) && !skipWhen.some(re => re.test(f))
  );

  const truncated = matched.length > maxFiles;
  if (truncated) matched = matched.slice(0, maxFiles);

  return { matched, truncated };
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

const MAX_COMMITS_PER_FILE = 5;

/**
 * Returns Map<filePath, [{hash, subject}]> capped at MAX_COMMITS_PER_FILE commits per file.
 */
function getCommitFileMap(base, projectRoot) {
  const raw = exec(
    `git log --format="COMMIT:%H %s" --name-only ${base}..HEAD`,
    { cwd: process.cwd() }
  );
  if (!raw) return new Map();

  const fileCommits = new Map();
  let current = null;

  for (const line of raw.split('\n')) {
    if (line.startsWith('COMMIT:')) {
      const rest     = line.slice(7);
      const spaceIdx = rest.indexOf(' ');
      const hash     = rest.slice(0, 8);
      const subject  = spaceIdx >= 0 ? rest.slice(spaceIdx + 1) : '';
      current = { hash, subject };
    } else if (line.trim() && current) {
      const file = line.trim();
      if (!fileCommits.has(file)) fileCommits.set(file, []);
      const commits = fileCommits.get(file);
      if (commits.length < MAX_COMMITS_PER_FILE) commits.push(current);
    }
  }

  return fileCommits;
}

// ---------------------------------------------------------------------------
// Diff splitting
// ---------------------------------------------------------------------------

/**
 * Fetch the full diff and split into per-file chunks.
 * Returns Map<filePath, rawDiffChunk>
 */
function fetchAndSplitDiff(base, projectRoot, scope = 'all') {
  let cmd;
  switch (scope) {
    // Three-dot for branch-contribution scope so files only present on the base
    // branch after divergence don't appear in the per-dimension diff
    // (issue #239 for 'committed', issue #364 for default 'all').
    // Routed through lib/git.js::buildBranchContribDiffCmd so review and pr stay
    // in sync — DRY, no per-call divergence.
    case 'committed': cmd = buildBranchContribDiffCmd('content', base); break;
    case 'staged':    cmd = 'git diff --cached';                        break;
    case 'working':   cmd = 'git diff HEAD';                            break;
    case 'worktree':  cmd = `git diff ${base}`;                         break;
    default:          cmd = buildBranchContribDiffCmd('content', base); break; // 'all' (issue #364)
  }
  const raw = exec(cmd, { cwd: process.cwd() });
  if (!raw) return new Map();

  return splitDiffByFile(raw);
}

/**
 * Write one .diff file per active dimension to tmpDir.
 * Mutates dim.diff_file on each active dimension.
 * Returns tmpDir path.
 */
function writeDimensionDiffs(activeDimensions, fileDiffs, projectRoot) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-review-'));

  for (const dim of activeDimensions) {
    const filesWithNoDiff = dim.matched_files.filter(f => !fileDiffs.has(f));
    if (filesWithNoDiff.length > 0) {
      process.stderr.write(`Warning: ${dim.name}: ${filesWithNoDiff.length} matched file(s) have no diff content (renamed, mode-only, or binary): ${filesWithNoDiff.join(', ')}\n`);
      dim.warnings.push(`No diff content for: ${filesWithNoDiff.join(', ')}`);
    }
    const parts = dim.matched_files
      .map(f => fileDiffs.get(f))
      .filter(Boolean);
    fs.writeFileSync(path.join(tmpDir, `${dim.name}.diff`), parts.join('\n'), 'utf8');
    dim.diff_file = path.join(tmpDir, `${dim.name}.diff`);
  }

  return tmpDir;
}

// ---------------------------------------------------------------------------
// Plan critique and refinement
// ---------------------------------------------------------------------------

const SEVERITY_RANK = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

function critiquePlan(dimensions, changedFiles) {
  const allMatched     = new Set(dimensions.flatMap(d => d.matched_files));
  const uncoveredFiles = changedFiles.filter(f => !allMatched.has(f));
  const totalCount     = changedFiles.length;

  const overBroad = dimensions
    .filter(d => d.status === 'ACTIVE' && totalCount > 0 && d.matched_files.length / totalCount > 0.8)
    .map(d => d.name);

  const overlappingPairs = [];
  const active = dimensions.filter(d => d.status === 'ACTIVE');
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = new Set(active[i].matched_files);
      const b = new Set(active[j].matched_files);
      if (a.size === b.size && [...a].every(f => b.has(f))) {
        overlappingPairs.push([active[i].name, active[j].name]);
      }
    }
  }

  const { uncoveredSuggestions, stillUncovered } = analyzeUncoveredFiles(uncoveredFiles);

  return {
    uncoveredFiles,
    uncoveredSuggestions,
    stillUncovered,
    overBroad,
    overlappingPairs,
    dimensionCapApplied: active.length > 8,
  };
}

// ---------------------------------------------------------------------------
// Uncovered file analysis
// ---------------------------------------------------------------------------

/**
 * Static catalog mapping file path patterns to dimension suggestions.
 * Each entry has a test function and a dimension name + human-readable label.
 * Order matters: first match wins per file. More specific patterns first.
 */
const UNCOVERED_PATTERN_CATALOG = [
  { test: f => /\.github\/workflows\//.test(f) || (/\.(ya?ml)$/.test(f) && /ci|deploy|pipeline/i.test(f)), dimension: 'ci-cd-pipeline-review', label: 'CI/CD workflow' },
  { test: f => /Jenkinsfile|\.circleci\//i.test(f), dimension: 'ci-cd-pipeline-review', label: 'CI/CD pipeline' },
  { test: f => /migrations?\//i.test(f) || /\.sql$/.test(f), dimension: 'database-migrations-review', label: 'database migration' },
  { test: f => /i18n|locales?|translations?\//i.test(f), dimension: 'internationalization-review', label: 'internationalization' },
  { test: f => /\.graphql$/.test(f) || /openapi|swagger/i.test(f) || /\.proto$/.test(f), dimension: 'api-contract-review', label: 'API contract/schema' },
  { test: f => /\.md$/.test(f) || /docs?\//i.test(f), dimension: 'documentation-quality-review', label: 'documentation' },
  { test: f => /\.d\.ts$/.test(f) || /(?:^|\/)types?\//i.test(f), dimension: 'type-safety-review', label: 'type definition' },
  { test: f => /store|state|redux|zustand|pinia/i.test(f), dimension: 'state-management-review', label: 'state management' },
  { test: f => /Dockerfile|docker-compose|\.dockerfile$/i.test(f) || /terraform|\.tf$|k8s|kubernetes/i.test(f), dimension: 'infrastructure-review', label: 'infrastructure' },
  { test: f => /\.lock$/.test(f) || /package-lock|yarn\.lock|Gemfile\.lock|poetry\.lock/.test(f), dimension: 'dependency-management-review', label: 'dependency lockfile' },
  { test: f => /android\/|ios\/|\.swift$|\.kt$|\.dart$/.test(f), dimension: 'mobile-app-review', label: 'mobile platform' },
  { test: f => /\.env(?:\.|$)/.test(f) || /(?:^|\/)config\//i.test(f), dimension: 'configuration-management-review', label: 'configuration' },
];

/**
 * Analyze uncovered files and group them by suggested dimension.
 * @param {string[]} uncoveredFiles - Files not matched by any active dimension
 * @returns {{ uncoveredSuggestions: Array<{dimension, files, reason}>, stillUncovered: string[] }}
 */
function analyzeUncoveredFiles(uncoveredFiles) {
  if (uncoveredFiles.length === 0) {
    return { uncoveredSuggestions: [], stillUncovered: [] };
  }

  const byDimension = new Map(); // dimension name -> { label, files }
  const stillUncovered = [];

  for (const file of uncoveredFiles) {
    const entry = UNCOVERED_PATTERN_CATALOG.find(e => e.test(file));
    if (entry) {
      if (!byDimension.has(entry.dimension)) {
        byDimension.set(entry.dimension, { label: entry.label, files: [] });
      }
      byDimension.get(entry.dimension).files.push(file);
    } else {
      stillUncovered.push(file);
    }
  }

  const uncoveredSuggestions = [];
  for (const [dimension, { label, files }] of byDimension) {
    const count = files.length;
    uncoveredSuggestions.push({
      dimension,
      files,
      reason: `${count} ${label} file${count === 1 ? '' : 's'} not covered by any dimension`,
    });
  }

  return { uncoveredSuggestions, stillUncovered };
}

/**
 * If more than 8 dimensions are ACTIVE, cap to top 8 by priority.
 * Priority: severity descending, then matched_files count ascending.
 * Returns list of queued dimension names.
 */
function refinePlan(dimensions) {
  const active = dimensions.filter(d => d.status === 'ACTIVE');
  if (active.length <= 8) return [];

  active.sort((a, b) => {
    const diff = (SEVERITY_RANK[b.severity] || 3) - (SEVERITY_RANK[a.severity] || 3);
    return diff !== 0 ? diff : a.matched_files.length - b.matched_files.length;
  });

  const keep   = new Set(active.slice(0, 8).map(d => d.name));
  const queued = [];

  for (const dim of dimensions) {
    if (dim.status === 'ACTIVE' && !keep.has(dim.name)) {
      dim.status = 'QUEUED';
      queued.push(dim.name);
    }
  }

  return queued;
}

// ---------------------------------------------------------------------------
// Dimension loading and matching
// ---------------------------------------------------------------------------

function loadAndMatchDimensions(projectRoot, changedFiles, dimensionFilter) {
  const report = validateAll(projectRoot);
  const dims   = [];

  for (const result of report.dimensions) {
    if (result.status === 'FAIL') continue;

    const filePath = path.join(resolveDimensionsDir(projectRoot), result.file);
    let content;
    try { content = fs.readFileSync(filePath, 'utf8'); } catch (_) { continue; }

    const fm   = parseSimpleYaml(extractFrontmatter(content) || '');
    const body = extractBody(content);

    if (dimensionFilter && !dimensionFilter.includes(fm.name)) continue;

    const { matched, truncated } = matchFiles(fm, changedFiles);
    const forced = dimensionFilter && dimensionFilter.includes(fm.name) && matched.length === 0;

    // Force-active path (R-on-demand-force-active, #362): when forced, use ALL changed files
    // but still apply the dimension's max-files cap, per spec.
    const maxFiles = fm['max-files'] || 100;
    let effectiveMatched;
    let effectiveTruncated;
    if (forced) {
      effectiveTruncated = changedFiles.length > maxFiles;
      effectiveMatched   = effectiveTruncated ? changedFiles.slice(0, maxFiles) : changedFiles;
    } else {
      effectiveMatched   = matched;
      effectiveTruncated = truncated;
    }

    dims.push({
      name:              fm.name,
      description:       fm.description || '',
      severity:          fm.severity || 'medium',
      requires_full_diff: fm['requires-full-diff'] || false,
      model:             fm.model || null,
      status:            effectiveMatched.length === 0 ? 'SKIPPED' : (effectiveTruncated ? 'TRUNCATED' : 'ACTIVE'),
      matched_files:     effectiveMatched,
      matched_count:     effectiveMatched.length,
      truncated:         effectiveTruncated,
      diff_file:         null,
      body,
      file_context:      [],
      warnings:          result.warnings,
    });
  }

  return dims;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const { projectRoot, baseBranch, dimensionFilter, scope: cliScope, setDefault } = parseArgs(process.argv);

  // Issue #232: verifyAndMigrate gate (CLI > env > default false).
  const skipConfigCheck = resolveSkipConfigCheck(process.argv);
  const cv = ensureConfigVersion(projectRoot, { skip: skipConfigCheck, roles: ['project', 'local'] });
  if (cv.errors.length > 0) {
    writeOutput({
      errors: cv.errors.map(e => `config-version: ${e.role}: ${e.message}`),
      warnings: [],
      flags: { skipConfigCheck },
      migration: cv.migration,
    }, 'review-manifest', 1);
    return;
  }

  // Resolve scope: CLI flag > review config > hardcoded default
  const reviewConfig = readReviewConfig(projectRoot);
  const scope = cliScope || reviewConfig?.defaults?.scope || 'all';

  // Persist default if --set-default was passed
  if (setDefault) {
    writeReviewConfig(projectRoot, { defaults: { scope } });
    process.stderr.write(`Saved default scope "${scope}" to .sdlc/review.json\n`);
  }

  // Validate mutual exclusivity
  const isLocalScope = scope === 'staged' || scope === 'working';
  if (isLocalScope && baseBranch) {
    process.stderr.write(`Error: --${scope} and --base are mutually exclusive.\n`);
    process.exit(2);
  }
  if (isLocalScope && scope !== scope) { /* unreachable, kept for clarity */ }

  let gitState;
  try {
    gitState = checkGitState(process.cwd());
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(2);
  }

  // Base branch needed for 'all', 'committed', and 'worktree' scopes
  let base = baseBranch;
  if (!isLocalScope && !base) {
    try {
      base = detectBaseBranch(projectRoot);
    } catch (err) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exit(2);
    }
  }

  // Best-effort refresh of the local base ref so diff semantics are computed
  // against the current state of origin/<base> rather than a stale local copy
  // (issue #239). Non-fatal — offline / no-origin / auth-denied all silently
  // pass and we proceed with whatever the local ref reports.
  if (base) {
    fetchBaseRef(base, projectRoot);
  }

  const changedFiles = getChangedFiles(base, projectRoot, scope);
  if (changedFiles.length === 0) {
    const scopeLabel = {
      all:       `committed + staged changes vs "${base}"`,
      committed: `committed changes vs "${base}"`,
      staged:    'staged changes',
      working:   'working tree changes vs HEAD',
      worktree:  `working tree vs "${base}" (committed + staged + unstaged)`,
    }[scope] || scope;
    process.stderr.write(`No changed files found in ${scopeLabel}.\n`);
    process.exit(1);
  }

  const dims = loadAndMatchDimensions(projectRoot, changedFiles, dimensionFilter);
  if (dims.length === 0) {
    process.stderr.write('No review dimensions found in .sdlc/review-dimensions/.\nRun /setup-sdlc --dimensions to create tailored review dimensions.\n');
    process.exit(1);
  }

  // Commit context only available for branch-based scopes
  if (!isLocalScope) {
    const commitFileMap = getCommitFileMap(base, projectRoot);
    for (const dim of dims) {
      dim.file_context = dim.matched_files.map(file => ({
        file,
        commits: commitFileMap.get(file) || [],
      }));
    }
  }

  // Diffs
  const fileDiffs  = fetchAndSplitDiff(base, projectRoot, scope);
  const activeDims = dims.filter(d => d.status === 'ACTIVE' || d.status === 'TRUNCATED');
  const tmpDir     = writeDimensionDiffs(activeDims, fileDiffs, projectRoot);

  // Plan critique and refinement
  const critique = critiquePlan(dims, changedFiles);
  const queued   = refinePlan(dims);

  // Ensure correct GitHub account before any gh commands (branch-based scopes only)
  if (!isLocalScope) {
    const ghAuth = ensureGhAccount(projectRoot);
    if (ghAuth.warning) process.stderr.write(`Warning: ${ghAuth.warning}\n`);
    if (ghAuth.switched) process.stderr.write(`Switched GitHub account to "${ghAuth.account}" (was "${ghAuth.previousAccount}")\n`);
  }

  // PR metadata only relevant for branch-based scopes
  const pr = !isLocalScope ? fetchPrMetadata() : { exists: false };

  const manifest = {
    version:        1,
    timestamp:      new Date().toISOString(),
    subagent_model: 'gemini-3.5-flash',
    plugin_version: getPluginVersion(),
    scope,
    base_branch:    base || null,
    current_branch: gitState.currentBranch,
    uncommitted_changes: gitState.uncommittedChanges,
    dirty_files:    gitState.dirtyFiles,
    git: {
      commit_count:  !isLocalScope ? getCommitCount(base, projectRoot) : 0,
      commit_log:    !isLocalScope ? getCommitLog(base, projectRoot)   : '',
      changed_files: changedFiles,
    },
    pr,
    dimensions: dims,
    plan_critique: {
      uncovered_files:        critique.uncoveredFiles,
      uncovered_suggestions:  critique.uncoveredSuggestions,
      still_uncovered:        critique.stillUncovered,
      over_broad_dimensions:  critique.overBroad,
      overlapping_pairs:      critique.overlappingPairs,
      dimension_cap_applied:  critique.dimensionCapApplied,
      queued_dimensions:      queued,
    },
    summary: {
      total_dimensions:      dims.length,
      active_dimensions:     dims.filter(d => d.status === 'ACTIVE' || d.status === 'TRUNCATED').length,
      skipped_dimensions:    dims.filter(d => d.status === 'SKIPPED').length,
      queued_dimensions:     queued.length,
      total_changed_files:   changedFiles.length,
      uncovered_file_count:  critique.uncoveredFiles.length,
      suggested_dimensions:  critique.uncoveredSuggestions.length,
    },
    diff_dir: tmpDir,
  };

  writeOutput(manifest, 'review-manifest');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`review-prepare.js error: ${err.message}\n${err.stack}\n`);
    process.exit(2);
  }
}

module.exports = { globToRegex, matchFiles, loadAndMatchDimensions, analyzeUncoveredFiles, UNCOVERED_PATTERN_CATALOG };
