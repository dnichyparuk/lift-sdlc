#!/usr/bin/env node
/**
 * pr-prepare.js
 * Pre-computes all data needed for the pr-sdlc skill:
 * git state, remote sync, PR mode detection, commit history, diff, JIRA ticket.
 * Outputs JSON to stdout so the LLM can focus solely on description generation.
 *
 * Usage:
 *   node pr-prepare.js [options]
 *
 * Options:
 *   --draft           Mark PR as draft (passed through to output)
 *   --update          Force update mode (error if no existing PR found)
 *   --base <branch>   Override base branch (auto-detected if omitted)
 *   --auto            Skip interactive approval prompts (passed through to output)
 *
 * Exit codes:
 *   0 = success, JSON on stdout
 *   1 = fatal error, JSON with non-empty errors[] on stdout
 *   2 = unexpected script crash, message on stderr
 *
 * Uses only Node.js built-in modules. No npm install required.
 */

'use strict';

const fs   = require('node:fs');
const path = require('node:path');
const LIB = path.join(__dirname, '..', 'lib');

const { truncateDiff } = require('../lib/diff-truncate');
const { splitDiffByFile } = require('../lib/git');
const { exec,
  checkGitState,
  detectBaseBranch,
  fetchBaseRef,
  fetchPrMetadata,
  getRemoteState,
  pushToRemote,
  getCommitsStructured,
  getDiffStat,
  getDiffContent,
  ensureGhAccount,
  fetchRepoLabels,
  getChangedFiles,
  parseRemoteOwner,
  probeGhAuth,
  formatAccountMismatch,
  probeRepoAccess,
  formatAccessDenied,
} = require(path.join(LIB, 'git'));

const { readSection, resolveSdlcRoot } = require(path.join(LIB, 'config'));
const { writeOutput } = require(path.join(LIB, 'output'));
const { resolveSkipConfigCheck, ensureConfigVersion } = require(path.join(LIB, 'config-version-prepare'));
const { validateLinks, formatViolations } = require(path.join(LIB, 'links'));
const { loadPrTemplate } = require(path.join(LIB, 'pr-template'));
const { issueKeyRegex, extractFromBranchAndCommits } = require(path.join(LIB, 'issue-keys'));
const { validateExpectedBranch } = require(path.join(LIB, 'branch-guard'));
const { parseConventionalCommit } = require(path.join(LIB, 'version'));
// Reuse the same minimal glob semantics already used for path matching
// elsewhere in the repo (review dimension triggers/skip-when) rather than
// introducing a new dependency.
const { globToRegex } = require(path.join(__dirname, 'review'));

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = argv.slice(2);
  let isDraft          = false;
  let forceUpdate      = false;
  let baseBranchOverride = null;
  let isAuto           = false;
  let forcedLabels     = [];
  let expectedBranch   = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--draft') {
      isDraft = true;
    } else if (a === '--update') {
      forceUpdate = true;
    } else if (a === '--base' && args[i + 1]) {
      baseBranchOverride = args[++i];
    } else if (a === '--auto') {
      isAuto = true;
    } else if (a === '--label' && args[i + 1]) {
      forcedLabels.push(args[++i]);
    } else if (a === '--expected-branch' && args[i + 1]) {
      // R-expected-branch (issues #347, #348, #349): validated after gitState is resolved
      expectedBranch = args[++i];
    }
  }

  return { isDraft, forceUpdate, baseBranchOverride, isAuto, forcedLabels: [...new Set(forcedLabels)], expectedBranch };
}

// ---------------------------------------------------------------------------
// Branch name validation
// ---------------------------------------------------------------------------
// Both `--base <branch>` (CLI flag) and `pr.defaultBranch` (config file) are
// interpolated into `git rev-parse` shell commands. Restrict accepted characters
// to a conservative subset of valid Git ref characters to defeat shell
// metacharacter injection. Source: refnames may contain alphanumerics, `.`,
// `_`, `-`, and `/`. Anything else is rejected with a clear error.
const BRANCH_NAME_RE = /^[A-Za-z0-9._\-/]+$/;

function validateBranchName(name) {
  return typeof name === 'string' && name.length > 0 && BRANCH_NAME_RE.test(name);
}

// ---------------------------------------------------------------------------
// Issue ticket detection
// ---------------------------------------------------------------------------

/**
 * Scan branch name and commit subjects for the first issue reference.
 * @param {string} branchName
 * @param {Array<{ subject: string }>} commits
 * @returns {string|null}
 */
function detectIssueTicket(branchName, commits) {
  const keys = extractFromBranchAndCommits(branchName, commits);
  return keys.length > 0 ? keys[0] : null;
}

// ---------------------------------------------------------------------------
// PR mode detection
// ---------------------------------------------------------------------------

/**
 * Determine whether to create or update a PR based on the --update flag
 * and whether an existing PR was found.
 *
 * Mode matrix:
 *   --update + PR exists  → update
 *   --update + no PR      → fatal error
 *   no flag  + PR exists  → update
 *   no flag  + no PR      → create
 *
 * @param {boolean} forceUpdate
 * @param {{ exists: boolean, number?: number, title?: string, url?: string, state?: string }} prMeta
 * @returns {{ mode: 'create'|'update', error?: string }}
 */
function detectPrMode(forceUpdate, prMeta) {
  if (forceUpdate && !prMeta.exists) {
    return { mode: 'create', error: 'No existing PR found for this branch. Remove --update to create a new PR.' };
  }
  if (prMeta.exists) return { mode: 'update' };
  return { mode: 'create' };
}

// ---------------------------------------------------------------------------
// Rule-mode label matching (issue #197, rules-mode signal evaluation)
// ---------------------------------------------------------------------------
// Structural validity of `rule.when` (exactly one known key, real label) is
// established by the loop in main() before validRules ever reaches here —
// this only decides whether that one signal actually matches the PR.

/**
 * Evaluate one already-validated rule's single `when` signal against the
 * current PR context.
 * @param {{label: string, when: object}} rule
 * @param {{branch: string, commitType: string[], changedPaths: string[], jiraType: string|null, diffLineCount: number}} context
 * @returns {boolean}
 */
function matchRule(rule, context) {
  const when = rule && rule.when;
  if (!when || typeof when !== 'object') return false;
  const [signal] = Object.keys(when);
  const value = when[signal];

  switch (signal) {
    case 'branchPrefix':
      return Array.isArray(value) && typeof context.branch === 'string' &&
        value.some(prefix => context.branch.startsWith(prefix));
    case 'commitType':
      return Array.isArray(value) && Array.isArray(context.commitType) &&
        value.some(type => context.commitType.includes(type));
    case 'pathGlob':
      // All-changed-files semantics (same posture as the legacy `*.md` rule):
      // every changed path must match at least one glob.
      return Array.isArray(value) && Array.isArray(context.changedPaths) && context.changedPaths.length > 0 &&
        context.changedPaths.every(file => value.some(pattern => globToRegex(pattern).test(file)));
    case 'jiraType':
      return Array.isArray(value) && typeof context.jiraType === 'string' &&
        value.includes(context.jiraType);
    case 'diffSizeUnder':
      return typeof value === 'number' && typeof context.diffLineCount === 'number' &&
        context.diffLineCount < value;
    default:
      return false;
  }
}

/**
 * Evaluate every structurally-valid rule against the current PR context and
 * collect the matches. Multiple rules may target the same label — they OR
 * together and are deduped to a single suggestedLabels entry.
 * @param {Array<{label: string, when: object}>} validRules
 * @param {object} context
 * @returns {Array<{label: string, source: 'rule'}>}
 */
function evaluateRule(validRules, context) {
  const suggestedLabels = [];
  const seen = new Set();
  for (const rule of validRules) {
    if (seen.has(rule.label)) continue;
    if (matchRule(rule, context)) {
      seen.add(rule.label);
      suggestedLabels.push({ label: rule.label, source: 'rule' });
    }
  }
  return suggestedLabels;
}

/**
 * Validates pr.labels.rules structural correctness and label existence
 * (implements R-labels-2, issue #197). Also flags `jiraType` rules: pr.js
 * has no Jira API access (see the `jiraType: null` note in main()), so a
 * `jiraType` rule structurally passes validation and stays in validRules,
 * but it can never match at evaluation time — a warning surfaces that.
 * @param {Array} rules - raw pr.labels.rules array from config
 * @param {string[]} repoLabelNames - known repo label names
 * @param {string[]} knownSignals - allowed when.<signal> keys
 * @returns {{ validRules: Array<{label: string, when: object}>, warnings: string[] }}
 */
function validateLabelRules(rules, repoLabelNames, knownSignals) {
  const validRules = [];
  const warnings = [];
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object' || typeof rule.label !== 'string') {
      continue;
    }
    // Validate structural correctness of rule.when (implements R-labels-2)
    if (!rule.when || typeof rule.when !== 'object') {
      warnings.push(`Rule for label "${rule.label}" is missing a "when" condition. Rule will be ignored.`);
      continue;
    }
    const whenKeys = Object.keys(rule.when);
    if (whenKeys.length !== 1) {
      warnings.push(`Rule for label "${rule.label}" has ${whenKeys.length === 0 ? 'no' : 'multiple'} signal keys in "when" (expected exactly 1). Rule will be ignored.`);
      continue;
    }
    if (!knownSignals.includes(whenKeys[0])) {
      warnings.push(`Rule for label "${rule.label}" uses unknown signal "${whenKeys[0]}" in "when". Valid signals: ${knownSignals.join(', ')}. Rule will be ignored.`);
      continue;
    }
    if (!repoLabelNames.includes(rule.label)) {
      warnings.push(`Label "${rule.label}" referenced in pr.labels.rules does not exist in the repo. Rule will be ignored.`);
      continue;
    }
    if (whenKeys[0] === 'jiraType') {
      warnings.push(`label rule '${rule.label}' uses \`jiraType\`, which pr.js does not evaluate (no Jira lookup) — rule will never match`);
    }
    validRules.push(rule);
  }
  return { validRules, warnings };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const projectRoot = resolveSdlcRoot(); // issue #351: route to main worktree .sdlc/
  const { isDraft, forceUpdate, baseBranchOverride, isAuto, forcedLabels, expectedBranch } = parseArgs(process.argv);

  const errors   = [];
  const warnings = [];

  // Issue #232: verifyAndMigrate gate (CLI > env > default false).
  const skipConfigCheck = resolveSkipConfigCheck(process.argv);
  const cv = ensureConfigVersion(projectRoot, { skip: skipConfigCheck, roles: ['project'] });
  if (cv.errors.length > 0) {
    for (const e of cv.errors) errors.push(`config-version: ${e.role}: ${e.message}`);
    writeOutput({ errors, warnings, flags: { skipConfigCheck }, migration: cv.migration }, 'pr-context', 1);
    return;
  }

  // Issue #234, fixes #380: gh-auth + active-account preflight (shared with ship.js).
  // Two-mode cascade:
  //   Identity mode  (prConfig.expectedAccount set): strict login comparison.
  //   Access mode    (prConfig.expectedAccount unset): probe repo accessibility via gh api.
  // Halt on no-auth, expired-token, identity mismatch, or definitive probe denial (404/403).
  // Network failure in probe warns and proceeds (non-blocking).
  const ghAuthState = probeGhAuth();
  const ghAuthenticated = ghAuthState.authenticated;
  const activeAccount = ghAuthState.activeAccount;
  const tokenExpired = ghAuthState.expired;

  const prConfigForAuth = readSection(projectRoot, 'pr') || {};
  const remoteForAuth = parseRemoteOwner(projectRoot);
  const expectedAccount =
    (typeof prConfigForAuth.expectedAccount === 'string' && prConfigForAuth.expectedAccount.trim()) ||
    null;

  // Default values for the new probe-output fields — overwritten below when the probe runs.
  let repoAccessProbed = false;
  let repoAccessible = null;
  let repoAccessStatus = null;

  if (!ghAuthenticated) {
    errors.push(ghAuthState.errorMessage);
    writeOutput(
      {
        errors,
        warnings,
        ghAuthenticated,
        activeAccount,
        expectedAccount,
        accountMismatch: false,
        tokenExpired,
        repoAccessProbed,
        repoAccessible,
        repoAccessStatus,
      },
      'pr-context',
      1
    );
    return;
  }

  const accountMismatch = Boolean(
    expectedAccount && activeAccount && activeAccount.toLowerCase() !== expectedAccount.toLowerCase()
  );

  if (accountMismatch) {
    errors.push(formatAccountMismatch(expectedAccount, activeAccount));
    writeOutput(
      {
        errors,
        warnings,
        ghAuthenticated,
        activeAccount,
        expectedAccount,
        accountMismatch: true,
        tokenExpired: false,
        repoAccessProbed,
        repoAccessible,
        repoAccessStatus,
      },
      'pr-context',
      1
    );
    return;
  }

  // Access-mode: no explicit expectedAccount — probe repo accessibility instead.
  if (!expectedAccount && remoteForAuth) {
    const probeResult = probeRepoAccess({
      owner: remoteForAuth.owner,
      repo: remoteForAuth.repo,
      host: remoteForAuth.host,
    });
    repoAccessProbed = true;
    repoAccessible = probeResult.accessible;
    repoAccessStatus = probeResult.statusCode;

    if (probeResult.accessible === false) {
      errors.push(
        formatAccessDenied({
          activeAccount,
          owner: remoteForAuth.owner,
          repo: remoteForAuth.repo,
          suggestedAccounts: probeResult.suggestedAccounts,
        })
      );
      writeOutput(
        {
          errors,
          warnings,
          ghAuthenticated,
          activeAccount,
          expectedAccount,
          accountMismatch: false,
          tokenExpired: false,
          repoAccessProbed,
          repoAccessible,
          repoAccessStatus,
        },
        'pr-context',
        1
      );
      return;
    }

    if (probeResult.accessible === null) {
      warnings.push(
        `Repo access probe failed (${probeResult.errorMessage || 'network error'}) — proceeding without access verification.`
      );
    }
  } else if (!expectedAccount && !remoteForAuth) {
    warnings.push(
      'Could not resolve expected gh account (no pr.expectedAccount, no origin remote). Skipping active-account check.'
    );
  }

  // Step 1–2: Validate git repo and get current branch
  let gitState;
  try {
    gitState = checkGitState(process.cwd());
  } catch (err) {
    errors.push(err.message);
    writeOutput({ errors, warnings }, 'pr-context', 1);
    return;
  }

  const { currentBranch, uncommittedChanges, dirtyFiles } = gitState;

  // Branch-guard HARD GATE (R-expected-branch, issues #347, #348, #349)
  // Must run before any gh pr create / gh pr edit invocation. Pure check — exits immediately on mismatch.
  const branchGuard = validateExpectedBranch(currentBranch, expectedBranch);
  if (branchGuard.active && !branchGuard.ok) {
    process.stderr.write(branchGuard.message + '\n');
    writeOutput({ errors: [branchGuard.message], warnings, currentBranch, branchGuard }, 'pr-context', 3);
    return;
  }

  // Step 3: Reject protected branches
  if (currentBranch === 'main' || currentBranch === 'master') {
    errors.push(`You are on the ${currentBranch} branch. Switch to a feature branch before creating a PR.`);
    writeOutput({ errors, warnings, currentBranch }, 'pr-context', 1);
    return;
  }

  // Step 4: Warn about uncommitted changes
  if (uncommittedChanges) {
    warnings.push(`Uncommitted changes detected (${dirtyFiles.length} file(s)). They will NOT be included in the PR.`);
  }

  // Step 5: Detect base branch
  // Resolution cascade (issue #339): --base CLI flag > config.pr.defaultBranch > git auto-detect
  let baseBranch;
  if (baseBranchOverride) {
    if (!validateBranchName(baseBranchOverride)) {
      errors.push(
        `--base value "${baseBranchOverride}" is not a valid branch name. ` +
        `Branch names must contain only letters, digits, '.', '_', '-', or '/'.`
      );
      writeOutput({ errors, warnings, currentBranch, baseBranchOverride }, 'pr-context', 1);
      return;
    }
    const exists = exec(
      `git rev-parse --verify origin/${baseBranchOverride} 2>/dev/null`,
      { cwd: process.cwd(), shell: true }
    );
    if (!exists) {
      errors.push(`Base branch "origin/${baseBranchOverride}" does not exist on the remote.`);
      writeOutput({ errors, warnings, currentBranch, baseBranchOverride }, 'pr-context', 1);
      return;
    }
    baseBranch = baseBranchOverride;
  } else {
    // Check config.pr.defaultBranch before falling back to git detection
    const prConfigForBase = readSection(projectRoot, 'pr') || {};
    const configDefaultBranch = typeof prConfigForBase.defaultBranch === 'string'
      ? prConfigForBase.defaultBranch.trim()
      : '';
    if (configDefaultBranch) {
      if (!validateBranchName(configDefaultBranch)) {
        errors.push(
          `config.pr.defaultBranch value "${configDefaultBranch}" is not a valid branch name. ` +
          `Branch names must contain only letters, digits, '.', '_', '-', or '/'. ` +
          `Update pr.defaultBranch in .sdlc/config.json.`
        );
        writeOutput({ errors, warnings, currentBranch }, 'pr-context', 1);
        return;
      }
      const exists = exec(
        `git rev-parse --verify origin/${configDefaultBranch} 2>/dev/null`,
        { cwd: process.cwd(), shell: true }
      );
      if (!exists) {
        errors.push(
          `config.pr.defaultBranch is set to "${configDefaultBranch}" but "origin/${configDefaultBranch}" does not exist on the remote. ` +
          `Update pr.defaultBranch in .sdlc/config.json or remove the field to use git auto-detection.`
        );
        writeOutput({ errors, warnings, currentBranch }, 'pr-context', 1);
        return;
      }
      baseBranch = configDefaultBranch;
    } else {
      try {
        baseBranch = detectBaseBranch(projectRoot);
      } catch (err) {
        errors.push(err.message);
        writeOutput({ errors, warnings, currentBranch }, 'pr-context', 1);
        return;
      }
    }
  }

  // Step 5b: Ensure the correct GitHub account is active for this repo
  const ghAuth = ensureGhAccount(projectRoot);
  if (ghAuth.warning) {
    warnings.push(ghAuth.warning);
  }

  // Step 6: Check remote state and push if needed
  const remoteInfo = getRemoteState(projectRoot);
  let remoteAction = 'none';

  if (!remoteInfo.hasUpstream) {
    const result = pushToRemote(projectRoot, false);
    remoteAction = result === 'pushed-new' ? 'pushed-new' : 'error';
    if (remoteAction === 'error') {
      warnings.push('Could not push branch to remote. You may need to push manually before creating a PR.');
    }
  } else if (remoteInfo.isAhead) {
    const result = pushToRemote(projectRoot, true);
    remoteAction = result === 'pushed' ? 'pushed' : 'error';
    if (remoteAction === 'error') {
      warnings.push('Could not push to remote. You may need to push manually.');
    }
  }

  // `pushed` reports whether the branch is in sync with origin (issue #214) —
  // not whether *this run* performed a push. The `action` field below is the
  // audit log of what this run did. A branch already pushed and current
  // returns `pushed: true, action: 'none'`. After a successful push
  // (`pushed`/`pushed-new`), the branch is in sync regardless of the
  // pre-push cached `isAhead` snapshot. A push failure returns
  // `pushed: false, action: 'error'`.
  const justPushed = remoteAction === 'pushed' || remoteAction === 'pushed-new';
  const inSyncWithOrigin = remoteInfo.hasUpstream && !remoteInfo.isAhead && !remoteInfo.isBehind;
  const remoteState = {
    pushed:       justPushed || inSyncWithOrigin,
    remoteBranch: remoteInfo.remoteBranch || `origin/${currentBranch}`,
    action:       remoteAction,
  };

  // Step 7: Detect PR mode
  const prMeta  = fetchPrMetadata();
  const { mode, error: modeError } = detectPrMode(forceUpdate, prMeta);

  if (modeError) {
    errors.push(modeError);
    writeOutput({ errors, warnings, currentBranch, baseBranch, remoteState, forceUpdate }, 'pr-context', 1);
    return;
  }

  // Step 8: Gather commits
  const commits = getCommitsStructured(baseBranch, projectRoot);
  if (commits.length === 0) {
    warnings.push(`No commits found between "${baseBranch}" and HEAD. The PR description may be sparse.`);
  }

  // Step 9: Gather diff
  // Best-effort refresh of local base ref so getDiffStat/getDiffContent see
  // the current origin/<base> rather than a stale local copy (issue #239).
  // Non-fatal — offline / no-origin / auth-denied all silently pass.
  fetchBaseRef(baseBranch, projectRoot);
  const diffStat    = getDiffStat(baseBranch, projectRoot);
  const rawDiff = getDiffContent(baseBranch, projectRoot);
  const diffContent = rawDiff ? truncateDiff(rawDiff, { splitDiffByFile, maxBytes: 8000 }).diff : '';

  if (!diffContent) {
    warnings.push(`No diff found between "${baseBranch}" and HEAD.`);
  }

  const changedFiles = getChangedFiles(baseBranch, projectRoot, 'committed');

  // Step 10: Extract issue ticket
  const issueTicket = detectIssueTicket(currentBranch, commits);

  const repoLabels = fetchRepoLabels();

  // Step 10b: Validate forced labels against repoLabels
  const repoLabelNames = repoLabels.map(label => label.name);
  for (const label of forcedLabels) {
    if (!repoLabelNames.includes(label)) {
      warnings.push(`Label "${label}" does not exist in the repository. It will be created during execution if needed.`);
    }
  }

  // Step 10c: Read PR config
  let prConfig = null;
  try {
    prConfig = readSection(projectRoot, 'pr');
  } catch (err) {
    warnings.push(`Could not read PR config: ${err.message}`);
  }

  // Step 10d: Validate pr.labels.rules against repoLabels (issue #197)
  // When mode = "rules", every rule's label must exist in the repo. Unknown
  // labels produce warnings (not errors) and are stripped from the emitted
  // prConfig.labels.rules — same posture as forced label validation above.
  // mode = "off" or "llm" leaves rules untouched.
  let suggestedLabels = [];
  if (prConfig && prConfig.labels && prConfig.labels.mode === 'rules' && Array.isArray(prConfig.labels.rules)) {
    const knownSignals = ['branchPrefix', 'commitType', 'pathGlob', 'jiraType', 'diffSizeUnder'];
    const { validRules, warnings: ruleWarnings } = validateLabelRules(prConfig.labels.rules, repoLabelNames, knownSignals);
    warnings.push(...ruleWarnings);
    prConfig = {
      ...prConfig,
      labels: { ...prConfig.labels, rules: validRules },
    };

    const commitTypes = commits
      .map(c => parseConventionalCommit(c.subject || '', c.body || '').type)
      .filter(type => type && type !== 'other');
    const prContext = {
      branch: currentBranch,
      commitType: commitTypes,
      changedPaths: changedFiles,
      // Jira issue type is not resolved by this script (no Jira API access
      // here) — jiraType rules simply never match until wired upstream.
      jiraType: null,
      diffLineCount: diffStat.totalLinesChanged,
    };
    suggestedLabels = evaluateRule(validRules, prContext);
  }

  // Step 11: Read custom PR template via single-source resolver (issue #260).
  // Resolves .sdlc/pr-template.md (canonical) with one-time stderr fallback to
  // .sdlc/pr-template.md (deprecated) — see lib/pr-template.js.
  const customTemplate = loadPrTemplate(projectRoot);

  // Build output
  const result = {
    mode,
    baseBranch,
    currentBranch,
    isDraft,
    isAuto,
    // Issue #234, fixes #380: gh-auth + active-account preflight result. SKILL.md gates
    // on these field names (per `flag-coherence-cross-skill`).
    ghAuthenticated,
    activeAccount,
    expectedAccount,
    accountMismatch: false,
    tokenExpired: false,
    repoAccessProbed,
    repoAccessible,
    repoAccessStatus,
    ghAuth: ghAuth.switched
      ? { switched: true, account: ghAuth.account, previousAccount: ghAuth.previousAccount }
      : null,
    existingPr: prMeta.exists
      ? { number: prMeta.number, title: prMeta.title, url: prMeta.url, state: prMeta.state, labels: prMeta.labels || [] }
      : null,
    issueTicket,
    customTemplate,
    prConfig,
    commits,
    changedFiles,
    diffStat,
    diffContent,
    repoLabels,
    forcedLabels,
    suggestedLabels,
    remoteState,
    warnings,
    errors,
    branchGuard,
  };

  writeOutput(result, 'pr-context', 0);
}

// ---------------------------------------------------------------------------
// --validate-body mode: link verification (issue #198, R15)
// ---------------------------------------------------------------------------

/**
 * Read the proposed PR body from stdin and validate every embedded URL via
 * `lib/links.js`. The expected GitHub repo identity is derived deterministically
 * from `parseRemoteOwner(projectRoot)` — the SKILL.md never constructs ctx.
 *
 * Exit codes:
 *   0 — ok (no violations)
 *   1 — violations found (formatted list on stderr; JSON result on stdout when --json)
 *   2 — usage error
 */
async function validateBodyMode(argv) {
  const projectRoot = resolveSdlcRoot(); // issue #351: route to main worktree .sdlc/
  const wantJson = argv.includes('--json');
  const fileIdx = argv.indexOf('--file');
  let body = '';
  if (fileIdx !== -1 && argv[fileIdx + 1]) {
    body = fs.readFileSync(argv[fileIdx + 1], 'utf8');
  } else {
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) body += chunk;
  }

  const expectedRepo = parseRemoteOwner(projectRoot);
  const result = await validateLinks(body, { projectRoot, expectedRepo });

  if (wantJson) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else if (result.ok) {
    const skipNote = result.skipped.length ? ` (${result.skipped.length} skipped)` : '';
    process.stdout.write('OK: PR body link verification passed' + skipNote + '\n');
  } else {
    process.stderr.write('PR body link verification FAILED before gh pr create/edit:\n');
    process.stderr.write(formatViolations(result.violations));
    process.stderr.write('\n');
  }
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  if (process.argv.includes('--validate-body')) {
    validateBodyMode(process.argv).catch(err => {
      process.stderr.write(`pr.js --validate-body error: ${err && err.stack || err}\n`);
      process.exit(2);
    });
  } else {
    try {
      main();
    } catch (err) {
      process.stderr.write(`pr-prepare.js error: ${err.message}\n${err.stack}\n`);
      process.exit(2);
    }
  }
}

module.exports = { parseArgs, detectIssueTicket, detectPrMode, matchRule, evaluateRule, validateLabelRules };
