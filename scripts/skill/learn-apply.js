#!/usr/bin/env node
/**
 * learn-apply.js — the validate / abort / ship half of the self-learning
 * assimilation run. Consumes the manifest emitted by learn-prepare.js.
 *
 * TWO-MODE CLI, NOT ONE SHOT
 * --------------------------
 * The ADR's D12 orders the steps validate -> review-only assessment -> PR, but
 * a single Node script cannot pause mid-execution to let the skill dispatch an
 * LLM subagent. So `--validate` and `--ship` are separate invocations and the
 * SKILL.md sequences them, dispatching the review-only agent only *between*
 * the two, after `--validate` has actually passed. `--abort` is the standalone
 * recovery entry point for every pre-ship failure.
 *
 * ORDERING IS LOAD-BEARING (R11 before R12)
 * -----------------------------------------
 * `--validate` runs validateGuardrailsConfig(root, 'plan'|'execute') FIRST,
 * every time, because validate-guardrail-regression.js documents guardrail-id
 * uniqueness as its own precondition (diffGuardrailArray does per-id lookup and
 * deliberately does not re-check uniqueness itself).
 *
 * ROLLBACK IS preImageStatus-AWARE
 * --------------------------------
 * When `preImageStatus === 'absent'` the `.sdlc/config.json` the synthesis step
 * wrote is UNTRACKED on the assimilation branch, so `git checkout -- <path>`
 * fails with a pathspec error and never removes it. Rollback therefore branches:
 *   'absent'   -> fs.unlinkSync (after asserting the resolved path is inside
 *                 `.sdlc/`), then assert the file is really gone
 *   otherwise  -> `git checkout -- .sdlc/config.json`
 * Verification is the spec's two-part check: `git branch --show-current` equals
 * `manifest.initialBranch` AND `git status --porcelain -- .sdlc/config.json` is
 * empty — where a `??` untracked line counts as non-empty. A failed
 * verification, or `checkoutBranch` returning 'dirty', is never squashed into a
 * normal exit-1: it prints MANUAL RECOVERY REQUIRED and exits 2.
 *
 * `git reset --hard` is never run, anywhere, on any path.
 *
 * PENDING FILES STAY UNTRACKED
 * ----------------------------
 * They are never staged and never committed. `--ship` deletes
 * `manifest.eligible[].files` with a plain `fs.unlinkSync` ONLY after the PR has
 * already opened, so no failure point can leave `pending/` partially cleaned.
 * A per-file unlink failure there is non-fatal (the run has already succeeded).
 *
 * KD9 — pre-tool-git-guard.js does NOT backstop this script: it inspects only
 *       top-level run_command text, never a Node script's internal spawnSync.
 *       Safety is local — no --force, no `-A`/`--all`/`.` staging, no
 *       `reset --hard`, an explicit initialBranch recorded for rollback.
 * KD8 — per-script constants stay local; no shared constants module.
 *
 * Exit codes
 *   --validate  0 checks passed (prints the regression-result file path only)
 *               1 validation failed, config + branch rolled back
 *               2 crash, OR rollback verification failed / checkout 'dirty'
 *   --abort     0 rollback completed, or already clean (idempotent)
 *               2 rollback verification failed
 *   --ship      0 PR opened (gh prints the PR URL on the inherited stdout)
 *               1 usage error
 *               2 crash — reports which of three failure points it reached
 */

'use strict';

const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const LIB  = path.join(__dirname, '..', 'lib');
const CI   = path.join(__dirname, '..', 'ci');
const UTIL = path.join(__dirname, '..', 'util');

const { writeOutput }     = require(path.join(LIB, 'output'));
const { resolveSdlcRoot } = require(path.join(LIB, 'config'));
const { checkoutBranch, pushToRemote } = require(path.join(LIB, 'git'));
const { validateGuardrailsConfig }     = require(path.join(CI, 'validate-guardrails'));
const { validateGuardrailRegression }  = require(path.join(CI, 'validate-guardrail-regression'));
const { runCreatePr }     = require(path.join(UTIL, 'create-pr'));

// KD8 — local constants. Git always reports POSIX-separated paths, so these
// stay literal strings, never path.join output.
const CONFIG_PATH       = '.sdlc/config.json';
const PENDING_PREFIX    = '.sdlc/learnings/pending/';
const MANUAL_RECOVERY   = 'MANUAL RECOVERY REQUIRED';
const GUARDRAIL_SECTIONS = ['plan', 'execute'];
const MODES             = ['validate', 'abort', 'ship'];

// ---------------------------------------------------------------------------
// CLI parsing — mirrors learn-prepare.js / harden-prepare.js posture
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    if (a === '--output-file') continue; // handled by writeOutput
    const eq = a.indexOf('=');
    let key, val;
    if (eq !== -1) {
      key = a.slice(2, eq);
      val = a.slice(eq + 1);
    } else {
      key = a.slice(2);
      val = argv[i + 1];
      if (val !== undefined && !val.startsWith('--')) {
        i++;
      } else {
        val = '';
      }
    }
    out[key] = val;
  }
  return out;
}

function usage() {
  return (
    'Usage:\n' +
    '  learn-apply.js --validate --manifest <path>\n' +
    '  learn-apply.js --abort    --manifest <path>\n' +
    '  learn-apply.js --ship     --manifest <path> --assessment-file <path> --regression-file <path>\n'
  );
}

// ---------------------------------------------------------------------------
// Injectable seams (mirrors util/create-pr.js's `runCreatePr(argv, deps)` and
// util/ship-git-ops.js's `{spawnFn, cwd}` posture)
// ---------------------------------------------------------------------------

function defaultDeps(overrides = {}) {
  return {
    spawnFn: spawnSync,
    fsImpl: fs,
    validateGuardrailsConfigFn: validateGuardrailsConfig,
    validateGuardrailRegressionFn: validateGuardrailRegression,
    checkoutBranchFn: checkoutBranch,
    pushToRemoteFn: pushToRemote,
    runCreatePrFn: runCreatePr,
    ...overrides,
  };
}

function git(deps, cwd, args) {
  const result = deps.spawnFn('git', args, { cwd, encoding: 'utf8' });
  if (result && result.error) {
    return { status: 128, stdout: '', stderr: result.error.message };
  }
  return {
    status: result ? result.status : 128,
    stdout: (result && result.stdout ? result.stdout : '').trim(),
    stderr: (result && result.stderr ? result.stderr : '').trim(),
  };
}

function gitFailure(result) {
  return result.stderr || result.stdout || `exit ${result.status}`;
}

function tmpPath(prefix, ext) {
  return path.join(os.tmpdir(), `${prefix}-${crypto.randomBytes(4).toString('hex')}${ext}`);
}

// ---------------------------------------------------------------------------
// PR body rendering
// ---------------------------------------------------------------------------

/**
 * Pick a code-fence long enough that the fenced text cannot break out of it:
 * one backtick longer than the longest backtick run anywhere in the text,
 * minimum 3. Computed at render time — never hardcoded — because the assessment
 * is LLM-authored, untrusted text and a plain 3-backtick fence is escapable by
 * a line of three backticks inside it.
 */
function fenceFor(text) {
  let longest = 0;
  const re = /`+/g;
  let match;
  const haystack = text === undefined || text === null ? '' : String(text);
  while ((match = re.exec(haystack)) !== null) {
    if (match[0].length > longest) longest = match[0].length;
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

function regressionCounts(regression) {
  const counts = regression && regression.counts;
  if (counts && typeof counts === 'object') {
    return {
      added: Number(counts.added) || 0,
      modified: Number(counts.modified) || 0,
      removed: Number(counts.removed) || 0,
    };
  }
  const added = Array.isArray(regression && regression.added) ? regression.added.length : 0;
  return { added, modified: 0, removed: 0 };
}

/**
 * `## Regression check` renders BEFORE `## Review-only assessment`, and the
 * assessment is fenced rather than interpolated as live markdown: otherwise a
 * crafted `rationale`/`evidence` flowing through the untrusted assessment could
 * render its own fake `## Regression check` heading *above* the genuine one and
 * mislead the human merge gate — the design's one remaining backstop (KD9).
 */
function renderPrBody({ eligible = [], regression = null, assessmentText = '' } = {}) {
  const lines = [];

  lines.push('## Assimilated signatures', '');
  for (const entry of eligible) {
    if (!entry || !entry.signature) continue;
    const raw = typeof entry.impact === 'string' ? entry.impact.trim() : '';
    lines.push(`- \`${entry.signature}\` — impact: ${raw === '' ? 'unscored' : raw}`);
  }
  lines.push('');

  const counts = regressionCounts(regression);
  const verdict = regression && regression.ok === false ? 'FAIL' : 'PASS';
  lines.push('## Regression check', '');
  lines.push(`Strengthen-only: ${verdict} (added ${counts.added}, modified ${counts.modified}, removed ${counts.removed})`);
  lines.push('');

  const text = assessmentText === undefined || assessmentText === null ? '' : String(assessmentText);
  const fence = fenceFor(text);
  lines.push('## Review-only assessment', '');
  lines.push(fence);
  lines.push(...text.replace(/\n+$/, '').split('\n'));
  lines.push(fence);
  lines.push('');

  return lines.join('\n');
}

function signaturesOf(eligible) {
  return (eligible || []).map(e => e && e.signature).filter(s => typeof s === 'string' && s !== '');
}

function prTitle(eligible) {
  const sigs = signaturesOf(eligible);
  if (sigs.length === 1) return `chore(sdlc): assimilate learning signature ${sigs[0]}`;
  return `chore(sdlc): assimilate ${sigs.length} learning signatures`;
}

function commitMessage(eligible) {
  const sigs = signaturesOf(eligible);
  if (sigs.length === 0) return 'chore(sdlc): assimilate learnings';
  const joined = sigs.join(', ');
  const detail = joined.length <= 60 ? joined : `${sigs.length} signatures`;
  return `chore(sdlc): assimilate learnings (${detail})`;
}

// ---------------------------------------------------------------------------
// Rollback — shared by `--validate`'s failure path and `--abort`
// ---------------------------------------------------------------------------

/**
 * Restore `.sdlc/config.json` and nothing else. Never a bare branch-level
 * rollback, which could carry away other uncommitted changes.
 */
function restoreConfig({ projectRoot, preImageStatus, deps }) {
  const abs = path.resolve(projectRoot, CONFIG_PATH);
  const scope = path.resolve(projectRoot, '.sdlc') + path.sep;
  if (!abs.startsWith(scope)) {
    return { ok: false, action: 'refused', reason: `refusing to touch ${abs} — it resolves outside ${scope}` };
  }

  if (preImageStatus === 'absent') {
    // The file is UNTRACKED on the assimilation branch (there was nothing to
    // capture on origin/<defaultBranch>), so `git checkout --` would fail with
    // a pathspec error and leave it in place. Unlink it instead.
    try {
      deps.fsImpl.unlinkSync(abs);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        return { ok: false, action: 'unlink', reason: `could not delete ${CONFIG_PATH}: ${err.message}` };
      }
    }
    if (deps.fsImpl.existsSync(abs)) {
      return { ok: false, action: 'unlink', reason: `${CONFIG_PATH} still exists after unlink` };
    }
    return { ok: true, action: 'unlinked' };
  }

  const result = git(deps, projectRoot, ['checkout', '--', CONFIG_PATH]);
  if (result.status !== 0) {
    return { ok: false, action: 'checkout', reason: `git checkout -- ${CONFIG_PATH} failed: ${gitFailure(result)}` };
  }
  return { ok: true, action: 'checked-out' };
}

/**
 * The spec's two-part post-rollback verification. `git status --porcelain --
 * <path>` reports an untracked file as a `??` line, so a leftover untracked
 * `.sdlc/config.json` counts as non-empty and therefore as a failure.
 */
function verifyRollback({ projectRoot, manifest, deps }) {
  const branchRes = git(deps, projectRoot, ['branch', '--show-current']);
  const statusRes = git(deps, projectRoot, ['status', '--porcelain', '--', CONFIG_PATH]);
  const branch = branchRes.stdout;
  const status = statusRes.stdout;
  const branchOk = manifest.initialBranch ? branch === manifest.initialBranch : false;
  const statusOk = statusRes.status === 0 && status === '';
  return { ok: branchOk && statusOk, branch, status, branchOk, statusOk };
}

/** True when there is genuinely nothing to restore (drives `--abort`'s idempotency). */
function configAlreadyClean({ projectRoot, manifest, deps }) {
  if (manifest.preImageStatus === 'absent') {
    return !deps.fsImpl.existsSync(path.resolve(projectRoot, CONFIG_PATH));
  }
  const status = git(deps, projectRoot, ['status', '--porcelain', '--', CONFIG_PATH]);
  return status.status === 0 && status.stdout === '';
}

function performRollback({ projectRoot, manifest, deps, skipRestore = false }) {
  const problems = [];

  let restore = null;
  if (!skipRestore) {
    restore = restoreConfig({ projectRoot, preImageStatus: manifest.preImageStatus, deps });
    if (!restore.ok) problems.push(restore.reason);
  }

  // Restore the file BEFORE switching branches: checkoutBranch refuses to run
  // against a dirty tracked tree, and a modified tracked config.json is exactly
  // that.
  let checkout = null;
  if (manifest.initialBranch) {
    checkout = deps.checkoutBranchFn(projectRoot, manifest.initialBranch);
    if (checkout === 'dirty') {
      problems.push(`checkoutBranch(${manifest.initialBranch}) returned 'dirty' — refusing to force past uncommitted tracked changes`);
    } else if (checkout !== 'checked-out') {
      problems.push(`checkoutBranch(${manifest.initialBranch}) returned '${checkout}'`);
    }
  } else {
    problems.push('manifest.initialBranch is missing — cannot restore the original branch');
  }

  const verify = verifyRollback({ projectRoot, manifest, deps });
  if (!verify.ok) {
    problems.push(
      `post-rollback verification failed — expected branch "${manifest.initialBranch}", got "${verify.branch || '(none)'}"; ` +
      `git status --porcelain -- ${CONFIG_PATH} = ${verify.status === '' ? '(empty)' : JSON.stringify(verify.status)}`
    );
  }

  return { ok: problems.length === 0, problems, verify, checkout, restore };
}

function rollbackFailureReport({ manifest, rollback }) {
  const lines = [];
  lines.push('learn-apply: ROLLBACK DID NOT COMPLETE.');
  lines.push(`  current branch: ${rollback.verify.branch || '(none)'}`);
  lines.push(`  expected branch: ${manifest.initialBranch || '(unknown)'}`);
  lines.push(`  git status --porcelain -- ${CONFIG_PATH}: ${rollback.verify.status === '' ? '(empty)' : rollback.verify.status}`);
  for (const problem of rollback.problems) lines.push(`  - ${problem}`);
  lines.push(MANUAL_RECOVERY);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// `--validate`
// ---------------------------------------------------------------------------

function describeViolation(violation) {
  const subject = violation.id !== undefined ? `id=${violation.id}` : `path=${violation.path}`;
  return `  ${violation.kind}: ${subject}`;
}

/**
 * @returns {{exitCode:number, stdout:string, stderr:string, regression:object|null}}
 */
function runValidate({ projectRoot, manifest, manifestPath = null, deps = defaultDeps() }) {
  let stderr = '';

  if (!manifest.branchName) {
    stderr += 'learn-apply --validate: manifest has no branchName — learn-prepare.js created no assimilation branch, so there is nothing to validate.\n';
    return { exitCode: 1, stdout: '', stderr, regression: null };
  }

  const fail = (reasons) => {
    let out = '';
    out += 'learn-apply --validate: FAILED.\n';
    for (const reason of reasons) out += `${reason}\n`;
    const rollback = performRollback({ projectRoot, manifest, deps });
    if (!rollback.ok) {
      out += rollbackFailureReport({ manifest, rollback });
      return { exitCode: 2, stdout: '', stderr: stderr + out, regression: null };
    }
    out += `learn-apply --validate: rolled back ${CONFIG_PATH} (${rollback.restore.action}) and returned to branch "${manifest.initialBranch}".\n`;
    out += 'learn-apply --validate: pending changesets were left untouched.\n';
    return { exitCode: 1, stdout: '', stderr: stderr + out, regression: null };
  };

  const configAbs = path.resolve(projectRoot, CONFIG_PATH);
  if (!deps.fsImpl.existsSync(configAbs)) {
    return fail([`  ${CONFIG_PATH} does not exist — the synthesis step wrote nothing to validate.`]);
  }

  // R11 — schema validation FIRST, every time. validate-guardrail-regression.js
  // documents guardrail-id uniqueness as its own precondition.
  const schemaProblems = [];
  for (const section of GUARDRAIL_SECTIONS) {
    let result;
    try {
      result = deps.validateGuardrailsConfigFn(projectRoot, section);
    } catch (err) {
      schemaProblems.push(`  ${section}: validateGuardrailsConfig threw — ${err.message}`);
      continue;
    }
    for (const message of (result && result.errors) || []) {
      schemaProblems.push(`  ${section}: ${message}`);
    }
  }
  if (schemaProblems.length > 0) {
    return fail(['  guardrail schema validation (validateGuardrailsConfig) failed:', ...schemaProblems]);
  }

  // R12 — regression diff against the CURRENT on-disk config (whatever the
  // synthesis step already applied on the assimilation branch). This script
  // never receives postConfig as an argument; it reads the file.
  let postConfig;
  try {
    postConfig = JSON.parse(deps.fsImpl.readFileSync(configAbs, 'utf8'));
  } catch (err) {
    return fail([`  ${CONFIG_PATH} is not readable as JSON — ${err.message}`]);
  }

  const regression = deps.validateGuardrailRegressionFn(
    manifest.preImage,
    postConfig,
    { preImageStatus: manifest.preImageStatus }
  );

  if (!regression.ok) {
    return fail([
      '  strengthen-only regression check (validateGuardrailRegression) failed:',
      ...(regression.violations || []).map(describeViolation),
    ]);
  }

  const added = Array.isArray(regression.added) ? regression.added : [];
  const result = {
    ok: true,
    added,
    counts: { added: added.length, modified: 0, removed: 0 },
    preImageStatus: manifest.preImageStatus,
    branchName: manifest.branchName,
    defaultBranch: manifest.defaultBranch,
    initialBranch: manifest.initialBranch,
    manifestPath,
    timestamp: new Date().toISOString(),
  };

  // Working tree is deliberately left as-is for `--ship`.
  return { exitCode: 0, stdout: '', stderr, regression: result };
}

// ---------------------------------------------------------------------------
// `--abort`
// ---------------------------------------------------------------------------

/**
 * Identical rollback logic to `--validate`'s failure path, callable standalone,
 * and idempotent. Owns recovery for every pre-ship state: the branch existing,
 * synthesis dispatch, applying the JSON, `--validate` itself, the review-only
 * dispatch, and the assessment write. Never for a failure detected *after*
 * `--ship` was invoked — that is `--ship`'s own exit-2 path to report.
 *
 * Idempotency: when there is nothing left to restore AND the original branch is
 * already checked out, it exits 0 immediately rather than attempting an unlink
 * or `git checkout --` that would fail on a file that is already gone. When
 * there is nothing to restore but the branch has not been switched back, the
 * file-restore step alone is skipped and the branch restore still runs — a
 * half-finished recovery must not be reported as complete.
 */
function runAbort({ projectRoot, manifest, deps = defaultDeps() }) {
  const alreadyClean = configAlreadyClean({ projectRoot, manifest, deps });
  const currentBranch = git(deps, projectRoot, ['branch', '--show-current']).stdout;
  const onInitialBranch = !manifest.initialBranch || currentBranch === manifest.initialBranch;

  if (alreadyClean && onInitialBranch) {
    return {
      exitCode: 0,
      stdout: '',
      stderr: `learn-apply --abort: nothing to roll back — ${CONFIG_PATH} is already clean and branch "${currentBranch || '(none)'}" is already the initial branch.\n`,
    };
  }

  const rollback = performRollback({ projectRoot, manifest, deps, skipRestore: alreadyClean });
  if (!rollback.ok) {
    return { exitCode: 2, stdout: '', stderr: rollbackFailureReport({ manifest, rollback }) };
  }

  const action = rollback.restore ? rollback.restore.action : 'already-clean';
  return {
    exitCode: 0,
    stdout: '',
    stderr: `learn-apply --abort: rolled back ${CONFIG_PATH} (${action}) and returned to branch "${manifest.initialBranch}". Pending changesets were left untouched.\n`,
  };
}

// ---------------------------------------------------------------------------
// `--ship`
// ---------------------------------------------------------------------------

/**
 * Delete the assimilated pending changesets. Plain filesystem delete, path-
 * scoped to `.sdlc/learnings/pending/` — never a git operation, since these
 * files were never staged. Runs ONLY after the PR has already opened, and is
 * non-fatal by design: the run has already succeeded, so an unlink failure must
 * never be reported as a shipping failure.
 */
function deletePendingFiles({ projectRoot, eligible, deps }) {
  const warnings = [];
  const deleted = [];
  const scope = path.resolve(projectRoot, '.sdlc', 'learnings', 'pending') + path.sep;

  for (const entry of eligible || []) {
    for (const rel of (entry && entry.files) || []) {
      const abs = path.resolve(projectRoot, rel);
      if (!abs.startsWith(scope)) {
        warnings.push(`refused to delete "${rel}" — it resolves outside ${PENDING_PREFIX}`);
        continue;
      }
      try {
        deps.fsImpl.unlinkSync(abs);
        deleted.push(rel);
      } catch (err) {
        // ENOENT is a silent no-op: a concurrent learn-reject.js may have
        // removed it first.
        if (err.code === 'ENOENT') continue;
        warnings.push(`could not delete "${rel}" — ${err.message}`);
      }
    }
  }

  return { deleted, warnings };
}

function shipFailureReport(phase, details) {
  const lines = [];
  lines.push(`learn-apply --ship: FAILED at the "${phase}" point.`);
  for (const line of details) lines.push(`  ${line}`);
  if (phase !== 'pre-stage') lines.push(MANUAL_RECOVERY);
  return lines.join('\n') + '\n';
}

/**
 * @returns {{exitCode:number, stdout:string, stderr:string, prBody:string|null}}
 */
function runShip({
  projectRoot,
  manifest,
  manifestPath = null,
  assessmentFile,
  regressionFile,
  deps = defaultDeps(),
}) {
  const usageError = (message) => ({ exitCode: 1, stdout: '', stderr: `learn-apply --ship: ${message}\n`, prBody: null });

  if (!assessmentFile) return usageError('--assessment-file <path> is required');
  if (!regressionFile) return usageError('--regression-file <path> is required');
  if (!manifest.branchName) return usageError('manifest has no branchName — there is nothing to ship');

  // Precondition: every step below (staging, commit, pushToRemote) acts on
  // whichever branch is currently checked out, not on the manifest's recorded
  // name. Nothing should switch branches between --validate and --ship, so this
  // always holds; if it does not, refuse rather than commit to the wrong branch.
  const currentBranch = git(deps, projectRoot, ['branch', '--show-current']).stdout;
  if (currentBranch !== manifest.branchName) {
    return usageError(`current branch is "${currentBranch || '(none)'}" but the manifest's assimilation branch is "${manifest.branchName}" — refusing to commit to the wrong branch`);
  }

  let assessmentText;
  try {
    assessmentText = deps.fsImpl.readFileSync(assessmentFile, 'utf8');
  } catch (err) {
    return usageError(`cannot read --assessment-file ${assessmentFile}: ${err.message}`);
  }

  let regression;
  try {
    regression = JSON.parse(deps.fsImpl.readFileSync(regressionFile, 'utf8'));
  } catch (err) {
    return usageError(`cannot read --regression-file ${regressionFile}: ${err.message}`);
  }

  const configAbs = path.resolve(projectRoot, CONFIG_PATH);
  if (!deps.fsImpl.existsSync(configAbs)) {
    return usageError(`${CONFIG_PATH} does not exist — nothing to commit`);
  }

  // ---- staging -----------------------------------------------------------
  // Exact path only. Never -A, --all, or `.`: pre-tool-git-guard.js blocks
  // `git add -A` for exactly this reason but cannot see this script's internal
  // spawnSync calls (KD9).
  const add = git(deps, projectRoot, ['add', '--', CONFIG_PATH]);
  if (add.status !== 0) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: shipFailureReport('pre-stage', [
        `git add -- ${CONFIG_PATH} failed: ${gitFailure(add)}`,
        'Nothing was staged, committed or pushed.',
        `This state is fully recoverable with: node scripts/skill/learn-apply.js --abort --manifest ${manifestPath || '<manifest>'}`,
      ]),
      prBody: null,
    };
  }

  // ---- commit ------------------------------------------------------------
  const commit = git(deps, projectRoot, ['commit', '-m', commitMessage(manifest.eligible)]);
  if (commit.status !== 0) {
    const status = git(deps, projectRoot, ['status', '--porcelain', '--', CONFIG_PATH]);
    return {
      exitCode: 2,
      stdout: '',
      stderr: shipFailureReport('staged-not-committed', [
        `git commit failed: ${gitFailure(commit)}`,
        `git status --porcelain -- ${CONFIG_PATH}: ${status.stdout === '' ? '(empty)' : status.stdout}`,
        `${CONFIG_PATH} is STAGED but not committed. Nothing was pushed and no PR exists.`,
        'Recover manually with either:',
        `  git commit -m "${commitMessage(manifest.eligible)}"   (keep the staged change)`,
        `  git restore --staged -- ${CONFIG_PATH}                (unstage it)`,
        `Pending changesets under ${PENDING_PREFIX} were NOT deleted.`,
      ]),
      prBody: null,
    };
  }
  const sha = git(deps, projectRoot, ['rev-parse', 'HEAD']).stdout;

  // ---- push --------------------------------------------------------------
  // hasUpstream is pinned to `false` explicitly, never inferred: createBranch
  // passes --no-track so the assimilation branch genuinely has no upstream, and
  // `git push -u origin <branch>` is the only call shape that correctly targets
  // origin/<branchName> rather than risking a push onto the default branch.
  // `pushToRemote` returns 'pushed-new' (NOT 'pushed') on that -u code path.
  const pushed = deps.pushToRemoteFn(projectRoot, false);
  if (pushed !== 'pushed-new') {
    return {
      exitCode: 2,
      stdout: '',
      stderr: shipFailureReport('committed-not-pushed', [
        `pushToRemote(root, false) returned "${pushed}" (expected "pushed-new").`,
        `commit: ${sha}`,
        `branch: ${manifest.branchName}`,
        'The commit exists locally only — nothing reached origin and no PR exists.',
        `Recover manually with: git push -u origin ${manifest.branchName}`,
        `Pending changesets under ${PENDING_PREFIX} were NOT deleted.`,
      ]),
      prBody: null,
    };
  }

  // ---- PR ----------------------------------------------------------------
  const prBody = renderPrBody({ eligible: manifest.eligible, regression, assessmentText });
  const bodyFile = tmpPath('sdlc-learn-pr-body', '.md');
  deps.fsImpl.writeFileSync(bodyFile, prBody);

  const ghArgs = [
    '--base', String(manifest.defaultBranch || ''),
    '--head', String(manifest.branchName),
    '--title', prTitle(manifest.eligible),
    '--body-file', bodyFile,
  ];

  // runCreatePr so the gh-account recovery hook is inherited. gh's own stdout
  // (the PR URL) is inherited straight through to this process's stdout.
  const pr = deps.runCreatePrFn(['node', 'create-pr.js', ...ghArgs]);

  let stdout = '';
  let stderr = '';
  if (pr && pr.stdout) stdout += pr.stdout.endsWith('\n') ? pr.stdout : `${pr.stdout}\n`;
  if (pr && pr.stderr) stderr += pr.stderr;

  if (!pr || pr.exitCode !== 0) {
    stderr += shipFailureReport('pushed-no-pr', [
      `gh pr create exited ${pr ? pr.exitCode : '(no result)'}.`,
      `commit: ${sha} — ALREADY EXISTS ON origin/${manifest.branchName}`,
      `branch: ${manifest.branchName} is now an ORPHAN BRANCH on origin with no PR pointing at it.`,
      'Open the PR manually (the body was preserved):',
      `  gh pr create --base ${manifest.defaultBranch} --head ${manifest.branchName} --title ${JSON.stringify(prTitle(manifest.eligible))} --body-file ${bodyFile}`,
      `Pending changesets under ${PENDING_PREFIX} were NOT deleted.`,
    ]);
    return { exitCode: 2, stdout, stderr, prBody };
  }

  try { deps.fsImpl.unlinkSync(bodyFile); } catch { /* best-effort cleanup */ }

  // ---- pending-file disposition (post-PR, non-fatal) ---------------------
  const disposition = deletePendingFiles({ projectRoot, eligible: manifest.eligible, deps });
  if (disposition.warnings.length > 0) {
    stderr += 'learn-apply --ship: the PR opened successfully; some pending changesets could not be deleted:\n';
    for (const warning of disposition.warnings) stderr += `  ${warning}\n`;
    stderr += `  Remove them manually from ${PENDING_PREFIX} so they are not re-counted next run.\n`;
  }

  return { exitCode: 0, stdout, stderr, prBody };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function readManifest(fsImpl, manifestPath) {
  const raw = fsImpl.readFileSync(manifestPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('manifest did not parse to a JSON object');
  }
  return parsed;
}

function main(argv) {
  const cli = parseArgs(argv.slice(2));
  const modes = MODES.filter(m => m in cli);

  if (modes.length !== 1) {
    process.stderr.write(
      (modes.length === 0
        ? 'learn-apply: exactly one of --validate, --abort, --ship is required\n'
        : `learn-apply: modes are mutually exclusive (got ${modes.map(m => `--${m}`).join(', ')})\n`) + usage()
    );
    process.exit(1);
    return;
  }
  const mode = modes[0];

  if (!cli.manifest) {
    process.stderr.write('learn-apply: --manifest <path> is required\n' + usage());
    process.exit(1);
    return;
  }

  const projectRoot = resolveSdlcRoot();
  const deps = defaultDeps();

  let manifest;
  try {
    manifest = readManifest(deps.fsImpl, cli.manifest);
  } catch (err) {
    process.stderr.write(`learn-apply: cannot read --manifest ${cli.manifest}: ${err.message}\n`);
    process.exit(1);
    return;
  }

  if (mode === 'validate') {
    const result = runValidate({ projectRoot, manifest, manifestPath: cli.manifest, deps });
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode === 0) {
      // writeOutput writes and prints exactly ONE file path, then exits — so
      // the regression-result path is the only thing on stdout. The manifest
      // path is already held by the caller from invoking learn-prepare.js.
      writeOutput(result.regression, 'sdlc-learn-regression', 0);
      return;
    }
    if (result.stdout) process.stdout.write(result.stdout);
    process.exit(result.exitCode);
    return;
  }

  if (mode === 'abort') {
    const result = runAbort({ projectRoot, manifest, deps });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.exitCode);
    return;
  }

  const result = runShip({
    projectRoot,
    manifest,
    manifestPath: cli.manifest,
    assessmentFile: cli['assessment-file'] || cli.assessmentFile || '',
    regressionFile: cli['regression-file'] || cli.regressionFile || '',
    deps,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.exitCode);
}

module.exports = {
  parseArgs,
  fenceFor,
  renderPrBody,
  prTitle,
  commitMessage,
  restoreConfig,
  verifyRollback,
  configAlreadyClean,
  performRollback,
  deletePendingFiles,
  runValidate,
  runAbort,
  runShip,
  defaultDeps,
  main,
  MANUAL_RECOVERY,
};

if (require.main === module) {
  try {
    main(process.argv);
  } catch (err) {
    process.stderr.write(`learn-apply.js crashed: ${err.stack || err.message}\n`);
    process.stderr.write(`${MANUAL_RECOVERY} — inspect \`git branch --show-current\` and \`git status --porcelain -- ${CONFIG_PATH}\` before re-running.\n`);
    process.exit(2);
  }
}
