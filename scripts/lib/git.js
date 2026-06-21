/**
 * git.js
 * Shared git and GitHub utilities for Lift-SDLC scripts.
 * Zero external dependencies — Node.js built-ins only.
 *
 * Exports (shared — used by review-prepare.js and pr-prepare.js):
 *   exec, checkGitState, detectBaseBranch, getChangedFiles,
 *   getCommitLog, getCommitCount, fetchPrMetadata, fetchRepoLabels,
 *   parseRemoteOwner, getGhAccounts, ensureGhAccount
 *
 * Exports (PR-specific — used by pr-prepare.js only):
 *   getRemoteState, pushToRemote, getCommitsStructured,
 *   getDiffStat, getDiffContent
 */

'use strict';

const { execSync, spawnSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Core exec helper
// ---------------------------------------------------------------------------

/**
 * Run a shell command and return trimmed stdout, or null on failure.
 * @param {string} cmd
 * @param {object} [opts]  Passed to execSync (cwd, shell, etc.)
 * @param {boolean} [opts.throwOnError]  If true, rethrows on failure instead of returning null.
 * @returns {string|null}
 */
function exec(cmd, opts = {}) {
  const { throwOnError, ...execOpts } = opts;
  try {
    return execSync(cmd, { encoding: 'utf8', ...execOpts }).trim();
  } catch (err) {
    if (throwOnError) throw err;
    return null;
  }
}

/**
 * Run a shell command with automatic retry and exponential backoff.
 * Uses Atomics.wait for the delay — no subprocess spawned.
 * @param {string} cmd
 * @param {object} [opts]
 * @param {number} [opts.retries=3]       Maximum number of attempts (total, including the first).
 * @param {number} [opts.baseDelayMs=1000] Delay before the second attempt; doubles on each retry.
 * @param {boolean} [opts.throwOnError]    If true and all retries exhausted, throws with attempt count.
 * @returns {string|null}  Trimmed stdout, or null when all attempts fail and throwOnError is false.
 */
function retryExec(cmd, opts = {}) {
  const { retries = 3, baseDelayMs = 1000, throwOnError, ...execOpts } = opts;
  for (let attempt = 1; attempt <= retries; attempt++) {
    const result = exec(cmd, execOpts);
    if (result !== null) return result;
    // All attempts exhausted — break before sleeping.
    if (attempt === retries) break;
    // Exponential backoff: 1×, 2×, 4×, …
    const delay = baseDelayMs * Math.pow(2, attempt - 1);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
  }
  if (throwOnError) {
    throw new Error(`retryExec: command failed after ${retries} attempt(s): ${cmd}`);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shared helpers (used by both review-prepare.js and pr-prepare.js)
// ---------------------------------------------------------------------------

/**
 * Verify the working directory is inside a git repo and return basic state.
 * @param {string} projectRoot
 * @returns {{ currentBranch: string, uncommittedChanges: boolean, dirtyFiles: string[] }}
 * @throws {Error} if not inside a git repo
 */
function checkGitState(projectRoot) {
  const inside = exec('git rev-parse --is-inside-work-tree', { cwd: projectRoot });
  if (inside !== 'true') throw new Error('Not inside a git repository');

  const currentBranch = exec('git branch --show-current', { cwd: projectRoot }) || 'HEAD';
  const statusLines   = exec('git status --porcelain', { cwd: projectRoot }) || '';
  const dirtyFiles    = statusLines.split('\n').filter(Boolean).map(l => l.slice(3));

  return { currentBranch, uncommittedChanges: dirtyFiles.length > 0, dirtyFiles };
}

/**
 * Auto-detect the default base branch.
 * Tries: origin/HEAD symbolic ref → 'main' → 'master'.
 * @param {string} projectRoot
 * @returns {string}
 * @throws {Error} if no base branch can be detected
 */
function detectBaseBranch(projectRoot) {
  const fromRemote = exec("git symbolic-ref refs/remotes/origin/HEAD", { cwd: projectRoot, shell: true });
  if (fromRemote) return fromRemote.replace(/^refs\/remotes\/origin\//, '');

  for (const candidate of ['main', 'master']) {
    const exists = exec(`git rev-parse --verify ${candidate}`, { cwd: projectRoot, shell: true });
    if (exists) return candidate;
  }

  throw new Error('Cannot auto-detect base branch. Use --base <branch>.');
}

/**
 * Non-throwing variant of detectBaseBranch — falls back to 'main' on any error.
 *
 * Intended for callers that run at module-load time (e.g. setup-sections.js field
 * defaults) where a throw would abort the require() call. Uses the same detection
 * strategy as detectBaseBranch (origin/HEAD symbolic ref → 'main' → 'master') but
 * swallows all errors and returns 'main' as the last-resort fallback.
 *
 * Implements: setup-sdlc spec R-defaultBranch (issue #339).
 *
 * @param {string} projectRoot
 * @returns {string}
 */
function detectBaseBranchSafe(projectRoot) {
  try {
    return detectBaseBranch(projectRoot);
  } catch (_) {
    return 'main';
  }
}

/**
 * Best-effort fetch of the base branch from origin to fast-forward the local ref.
 *
 * Used before computing branch-contribution diffs (review-sdlc, pr-sdlc — issue #239)
 * so the local copy of `<base>` is not behind `origin/<base>`. The `<base>:<base>`
 * refspec form fast-forwards the local branch in place — no detached fetch.
 *
 * Failure modes (offline, no `origin` remote, auth denied, non-fast-forward) all
 * silently pass — callers fall back to whatever the local ref already had.
 *
 * @param {string} base         Base branch name (e.g. "main")
 * @param {string} projectRoot
 * @returns {void}
 */
function fetchBaseRef(base, projectRoot) {
  spawnSync(
    'git',
    ['fetch', '--quiet', 'origin', `${base}:${base}`],
    { cwd: projectRoot, encoding: 'utf8' }
  );
}

/**
 * Build the git diff command for the "branch contribution" scopes that MUST use
 * three-dot range semantics — issue #239.
 *
 * Three-dot (`<base>...HEAD`) compares HEAD against the merge-base of base and HEAD,
 * so files touched only on `base` after divergence are NOT included. This is the
 * correct semantics for "what this branch contributed", which is what review-sdlc
 * and pr-sdlc consumers want.
 *
 * Two-dot (`<base>..HEAD`) — the previous behavior — produced false-positive
 * findings on non-rebased branches by including post-divergence base commits.
 *
 * Scopes:
 *   'committed' — `git diff --name-only <base>...HEAD` (used by getChangedFiles)
 *   'stat'      — `git diff --stat <base>...HEAD`      (used by getDiffStat)
 *   'content'   — `git diff <base>...HEAD`             (used by getDiffContent)
 *
 * Other scopes (staged, working, worktree) intentionally do NOT use 3-dot:
 *   - 'staged'/'working': do not involve a base ref
 *   - 'worktree': symmetric (full working tree vs. base) by design
 *
 * The 'all' scope (default) now also routes through this helper via
 * buildBranchContribDiffCmd('committed'|'content', base) — issue #364
 * completes #239 by removing the two-dot leak in the default review path.
 *
 * @param {'committed'|'stat'|'content'} scope
 * @param {string} base
 * @returns {string}
 */
function buildBranchContribDiffCmd(scope, base) {
  switch (scope) {
    case 'committed': return `git diff --name-only ${base}...HEAD`;
    case 'stat':      return `git diff --stat ${base}...HEAD`;
    case 'content':   return `git diff ${base}...HEAD`;
    default:
      throw new Error(`buildBranchContribDiffCmd: unknown scope "${scope}"`);
  }
}

/**
 * List files changed depending on scope.
 * @param {string|null} base  Base branch (required for 'all', 'committed', and 'worktree' scopes)
 * @param {string} projectRoot
 * @param {'all'|'committed'|'staged'|'working'|'worktree'} [scope='all']
 * @returns {string[]}
 */
function getChangedFiles(base, projectRoot, scope = 'all') {
  let cmd;
  switch (scope) {
    case 'committed': cmd = buildBranchContribDiffCmd('committed', base);      break;
    case 'staged':    cmd = 'git diff --cached --name-only';                   break;
    case 'working':   cmd = 'git diff HEAD --name-only';                       break;
    case 'worktree':  cmd = `git diff --name-only ${base}`;                    break;
    default:          cmd = buildBranchContribDiffCmd('committed', base);      break; // 'all' (issue #364)
  }
  const out = exec(cmd, { cwd: projectRoot });
  return out ? out.split('\n').filter(Boolean) : [];
}

/**
 * One-line commit log between base and HEAD.
 * @param {string} base
 * @param {string} projectRoot
 * @returns {string}
 */
function getCommitLog(base, projectRoot) {
  return exec(`git log --oneline ${base}..HEAD`, { cwd: projectRoot }) || '';
}

/**
 * Number of commits between base and HEAD.
 * @param {string} base
 * @param {string} projectRoot
 * @returns {number}
 */
function getCommitCount(base, projectRoot) {
  const count = exec(`git rev-list --count ${base}..HEAD`, { cwd: projectRoot });
  return count ? parseInt(count, 10) : 0;
}

/**
 * Fetch basic PR metadata for the current branch via `gh`.
 * Returns { exists: false } if no PR exists or gh is unavailable.
 * @returns {{ exists: boolean, number?: number, title?: string, url?: string, state?: string, owner?: string, repo?: string }}
 */
function fetchPrMetadata() {
  const prJson = exec('gh pr view --json number,title,url,state,labels');
  if (!prJson) return { exists: false };
  const repoJson = exec('gh repo view --json owner,name');
  if (!repoJson) return { exists: false };
  try {
    const pr   = JSON.parse(prJson);
    const repo = JSON.parse(repoJson);
    return { exists: true, number: pr.number, title: pr.title, url: pr.url, state: pr.state, labels: (pr.labels || []).map(l => l.name), owner: repo.owner.login, repo: repo.name };
  } catch (_) {
    return { exists: false };
  }
}

/**
 * Fetch reviews for a PR via the GitHub REST API (`gh api repos/<owner>/<repo>/pulls/<n>/reviews`).
 * Returns a sentinel-empty array on any failure (e.g. unauthenticated `gh`, malformed JSON).
 * Each line of `--jq` output is parsed independently.
 * Used by await-remote-review polling (R51, R56).
 *
 * @param {string} owner
 * @param {string} repo
 * @param {number|string} prNumber
 * @returns {Array<{id:number,state:string,authorLogin:string,authorType:string,submittedAt:string|null}>}
 */
function fetchPrReviews(owner, repo, prNumber) {
  if (!owner || !repo || prNumber === undefined || prNumber === null) return [];
  const raw = exec(`gh api repos/${owner}/${repo}/pulls/${prNumber}/reviews --jq '.[] | {id, state, authorLogin: .user.login, authorType: .user.type, submittedAt: .submitted_at}'`);
  if (!raw) return [];
  const reviews = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      reviews.push(JSON.parse(trimmed));
    } catch (_) {
      // skip malformed line
    }
  }
  return reviews;
}

/**
 * Fetch CI checks for a PR via `gh pr checks <n> --json`.
 * Returns a sentinel-empty array on any failure.
 * Used by verify-pipeline polling (R42).
 *
 * @param {number|string} prNumber
 * @returns {Array<{name:string,state:string,bucket:string,workflow:string,event:string,startedAt:string,completedAt:string,link:string}>}
 */
function fetchPrChecks(prNumber) {
  if (prNumber === undefined || prNumber === null) return [];
  const raw = exec(`gh pr checks ${prNumber} --json name,state,bucket,workflow,event,startedAt,completedAt,link`);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

/**
 * Fetch a tail-trimmed log excerpt for a failed workflow run via `gh run view --log-failed`.
 * Returns `{ ok: false }` on any failure (no excerpt available).
 * Used by verify-pipeline failure analysis (R44).
 *
 * @param {string|number} runId
 * @param {{ maxLines?: number }} [options]
 * @returns {{ ok: true, excerpt: string } | { ok: false }}
 */
function fetchFailedCheckLogs(runId, { maxLines = 200 } = {}) {
  if (runId === undefined || runId === null || runId === '') return { ok: false };
  const raw = exec(`gh run view ${runId} --log-failed`);
  if (!raw) return { ok: false };
  const lines = raw.split('\n');
  const tail = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
  return { ok: true, excerpt: tail.join('\n') };
}

/**
 * Fetch all labels defined in the repository via `gh`.
 * Returns an empty array if `gh` is unavailable or the command fails.
 * @returns {Array<{ name: string, description: string }>}
 */
function fetchRepoLabels() {
  const raw = exec('gh label list --json name,description --limit 100');
  if (!raw) return [];
  try {
    const labels = JSON.parse(raw);
    return labels.map(l => ({ name: l.name, description: l.description || '' }));
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// GitHub account switching (shared — used by pr-prepare.js and review-prepare.js)
// ---------------------------------------------------------------------------

/**
 * Parse the git remote URL to extract host, owner, and repo name.
 * Supports SSH format (git@host:owner/repo.git) and HTTPS (https://host/owner/repo.git).
 * @param {string} projectRoot
 * @returns {{ host: string, owner: string, repo: string } | null}
 */
function parseRemoteOwner(projectRoot) {
  const url = exec('git remote get-url origin', { cwd: projectRoot });
  if (!url) return null;

  // SSH: git@github.com:owner/repo.git
  const sshMatch = url.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return { host: sshMatch[1], owner: sshMatch[2], repo: sshMatch[3] };
  }

  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { host: httpsMatch[1], owner: httpsMatch[2], repo: httpsMatch[3] };
  }

  return null;
}

/**
 * Return all authenticated gh accounts for a given host.
 * @param {string} host  e.g. "github.com"
 * @returns {{ accounts: Array<{ login: string, active: boolean }>, error: string|null }}
 */
function getGhAccounts(host) {
  const raw = exec('gh auth status --json hosts');
  if (!raw) return { accounts: [], error: null }; // gh not installed — silent skip

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return { accounts: [], error: 'Could not parse gh auth status output' };
  }

  const hostEntries = parsed.hosts && parsed.hosts[host];
  if (!Array.isArray(hostEntries) || hostEntries.length === 0) {
    return { accounts: [], error: null };
  }

  const accounts = hostEntries
    .filter(e => e.state === 'success')
    .map(e => ({ login: e.login, active: Boolean(e.active) }));

  return { accounts, error: null };
}

/**
 * Ensure the active gh account is the correct one for the current repository.
 * Uses two-phase matching:
 *   Phase 1 (fast): Match account login against the remote owner name.
 *   Phase 2 (fallback): Test API access per account (handles org repos).
 *
 * The switch persists beyond this call — it changes the global gh CLI active account.
 *
 * @param {string} projectRoot
 * @returns {{ switched: boolean, account: string|null, previousAccount: string|null, warning: string|null }}
 */
function ensureGhAccount(projectRoot) {
  const noOp = { switched: false, account: null, previousAccount: null, warning: null };

  const remote = parseRemoteOwner(projectRoot);
  if (!remote) return noOp; // no origin remote, nothing to do

  const { host, owner, repo } = remote;
  const { accounts, error } = getGhAccounts(host);

  if (error) return { ...noOp, warning: `GitHub account detection failed: ${error}` };
  if (accounts.length <= 1) return noOp; // single or no accounts — nothing to switch

  const activeAccount = accounts.find(a => a.active);
  if (!activeAccount) return noOp;

  // Phase 1: Fast owner match (covers personal repos)
  const ownerLower = owner.toLowerCase();
  if (activeAccount.login.toLowerCase() === ownerLower) return noOp; // already correct

  const matchingAccount = accounts.find(a => !a.active && a.login.toLowerCase() === ownerLower);
  if (matchingAccount) {
    const switchResult = exec(`gh auth switch --user ${matchingAccount.login}`);
    if (switchResult !== null || exec('gh auth status --active') !== null) {
      return {
        switched: true,
        account: matchingAccount.login,
        previousAccount: activeAccount.login,
        warning: null,
      };
    }
    // switch command failed — fall through to phase 2
  }

  // Phase 2: API access test (covers org repos where login !== owner)
  const apiPath = `repos/${owner}/${repo}`;

  // Test active account first — maybe it has access despite not matching the name
  const activeHasAccess = exec(`gh api ${apiPath} --silent`, { shell: true });
  if (activeHasAccess !== null) return noOp; // active account works, no switch needed

  // Try each other account
  for (const candidate of accounts.filter(a => !a.active)) {
    exec(`gh auth switch --user ${candidate.login}`);
    const hasAccess = exec(`gh api ${apiPath} --silent`, { shell: true });
    if (hasAccess !== null) {
      return {
        switched: true,
        account: candidate.login,
        previousAccount: activeAccount.login,
        warning: null,
      };
    }
  }

  // No account worked — restore original and warn
  exec(`gh auth switch --user ${activeAccount.login}`);
  return {
    ...noOp,
    warning: `No authenticated gh account has access to ${owner}/${repo}. Run "gh auth switch" to select the correct account manually.`,
  };
}

/**
 * Format the canonical 3-line account-mismatch halt message used by ship.js
 * preflight (issue #234) and pr.js preflight. Exporting a single formatter
 * ensures every gate emits byte-identical text — `no-opposite-logical-vectors`
 * guardrail compliance.
 *
 * @param {string} expected — expected gh login
 * @param {string} actual — currently active gh login
 * @returns {string}
 */
function formatAccountMismatch(expected, actual) {
  return [
    `Expected gh account: ${expected}`,
    `Active gh account:   ${actual}`,
    `Run: gh auth switch --user ${expected}`,
  ].join('\n');
}

/**
 * Format the canonical halt message when the access probe denies the active account
 * (issue #380). Mirrors `formatAccountMismatch` style — 3-line block. The
 * `suggestedAccounts` list is local-account-name-only (logins from `getGhAccounts`);
 * no cross-account probing is attempted.
 *
 * @param {{ activeAccount: string, owner: string, repo: string, suggestedAccounts: string[] }} opts
 * @returns {string}
 */
function formatAccessDenied({ activeAccount, owner, repo, suggestedAccounts }) {
  const lines = [
    `Active gh account: ${activeAccount}`,
    `Cannot access: ${owner}/${repo}`,
  ];
  if (Array.isArray(suggestedAccounts) && suggestedAccounts.length > 0) {
    suggestedAccounts.forEach(login => {
      lines.push(`Try: gh auth switch --user ${login}`);
    });
  } else {
    lines.push(`Run: gh auth login --hostname github.com`);
  }
  return lines.join('\n');
}

/**
 * Probe whether the active `gh` account can access a given repository (issue #380).
 * Answers "can this account see this repo?" — not "does this login match the owner?".
 * This is the correct tool for org-owned repos where a developer's personal login
 * never equals the org slug.
 *
 * Returns:
 *   - accessible: true (200 OK), false (404/403), or null (network failure / parse error)
 *   - statusCode: HTTP status code from gh api -i, or null on failure
 *   - errorMessage: human-readable summary when accessible === false, else null
 *   - suggestedAccounts: list of local gh account logins (name-only; no cross-account probing)
 *
 * Test injection: set `process.env.SDLC_PROBE_REPO_ACCESS` to one of:
 *   "accessible" → { accessible: true, statusCode: 200, errorMessage: null, suggestedAccounts: [...] }
 *   "not-found"  → { accessible: false, statusCode: 404, errorMessage: null, suggestedAccounts: [...] }
 *   "forbidden"  → { accessible: false, statusCode: 403, errorMessage: null, suggestedAccounts: [...] }
 *   "error"      → { accessible: null,  statusCode: null, errorMessage: 'probe-error', suggestedAccounts: [] }
 * When set, the real `gh api` call is skipped entirely — no network call leaves the process.
 * (SDLC_PROBE_REPO_ACCESS is intentionally undocumented in user-facing docs; it exists for test hermeticism only.)
 *
 * @param {{ owner: string, repo: string, host?: string, execFn?: function }} opts
 *   `owner` and `repo` are required — callers derive them from `parseRemoteOwner(projectRoot)`.
 * @returns {{ accessible: boolean|null, statusCode: number|null, errorMessage: string|null, suggestedAccounts: string[] }}
 */
function probeRepoAccess({ owner, repo, host, execFn } = {}) {
  const hostname = host || 'github.com';

  // Input validation at the boundary (defense against shell injection / SSRF
  // when `owner`/`repo`/`hostname` come from an attacker-controlled git remote URL).
  // GitHub owner/repo names are constrained to [A-Za-z0-9._-]; hostnames to [A-Za-z0-9.-].
  // A null guard on owner/repo also prevents `repos/undefined/undefined` API calls
  // when callers forget required params.
  const OWNER_REPO_RE = /^[A-Za-z0-9._-]+$/;
  const HOST_RE = /^[A-Za-z0-9.-]+$/;
  if (!owner || !repo || !OWNER_REPO_RE.test(String(owner)) || !OWNER_REPO_RE.test(String(repo))) {
    return { accessible: null, statusCode: null, errorMessage: 'invalid owner/repo', suggestedAccounts: [] };
  }
  if (!HOST_RE.test(String(hostname))) {
    return { accessible: null, statusCode: null, errorMessage: 'invalid hostname', suggestedAccounts: [] };
  }

  // Test-injection hook — bypasses the real gh api call for hermetic testing.
  const stub = process.env.SDLC_PROBE_REPO_ACCESS;
  const { accounts: suggestedAccounts } = stub !== 'error' ? getGhAccounts(hostname) : { accounts: [] };
  const logins = suggestedAccounts.map(a => a.login);

  if (stub) {
    switch (stub) {
      case 'accessible':
        return { accessible: true, statusCode: 200, errorMessage: null, suggestedAccounts: logins };
      case 'not-found':
        return { accessible: false, statusCode: 404, errorMessage: null, suggestedAccounts: logins };
      case 'forbidden':
        return { accessible: false, statusCode: 403, errorMessage: null, suggestedAccounts: logins };
      case 'error':
      default:
        return { accessible: null, statusCode: null, errorMessage: 'probe-error', suggestedAccounts: [] };
    }
  }

  const run = execFn || ((cmd) => exec(cmd, { shell: true }));

  // Use -i (include HTTP headers) and --silent (discard body) to capture the status line only.
  const raw = run(`gh api repos/${owner}/${repo} --hostname ${hostname} -i --silent 2>&1`);
  if (!raw) {
    return { accessible: null, statusCode: null, errorMessage: 'gh api returned no output', suggestedAccounts: logins };
  }

  // First line: "HTTP/2 <code>" or "HTTP/1.1 <code> <reason>"
  const firstLine = raw.split('\n')[0] || '';
  const match = firstLine.match(/HTTP\/[\d.]+ (\d{3})/);
  if (!match) {
    return { accessible: null, statusCode: null, errorMessage: `Unexpected gh api output: ${firstLine}`, suggestedAccounts: logins };
  }

  const statusCode = parseInt(match[1], 10);
  if (statusCode === 200) {
    return { accessible: true, statusCode: 200, errorMessage: null, suggestedAccounts: logins };
  }
  if (statusCode === 404 || statusCode === 403) {
    return { accessible: false, statusCode, errorMessage: null, suggestedAccounts: logins };
  }
  // Any other status (5xx, etc.) — treat as network failure, warn and proceed.
  return { accessible: null, statusCode, errorMessage: `Unexpected status ${statusCode}`, suggestedAccounts: logins };
}

/**
 * Probe `gh auth status` for a host and return a normalized auth state
 * (issue #234). One source of truth for the gh-auth + active-account preflight,
 * consumed by both `skill/ship.js` (pipeline preflight) and `skill/pr.js` (per-PR
 * preflight).
 *
 * Returns:
 *   - authenticated: true if the host has at least one logged-in account
 *   - activeAccount: login of the active account (when authenticated)
 *   - expired: true when the token has expired (gh reports "expired" in stderr)
 *   - errorMessage: human-readable summary when authenticated === false
 *
 * For test injection, pass `opts.execFn` to substitute the gh invocations.
 *
 * @param {{ host?: string, execFn?: function }} [opts]
 * @returns {{ authenticated: boolean, activeAccount: string|null, expired: boolean, errorMessage: string|null }}
 */
function probeGhAuth(opts = {}) {
  const host = opts.host || 'github.com';
  const run = opts.execFn || ((cmd) => exec(cmd, { shell: true }));

  // gh auth status writes to stderr; we capture both with `2>&1`.
  const statusRaw = run(`gh auth status --hostname ${host} 2>&1`);
  if (statusRaw === null) {
    return {
      authenticated: false,
      activeAccount: null,
      expired: false,
      errorMessage: `Not logged in to ${host}. Run: gh auth login --hostname ${host}`,
    };
  }

  const lower = statusRaw.toLowerCase();
  const expired = lower.includes('expired');
  if (expired) {
    return {
      authenticated: false,
      activeAccount: null,
      expired: true,
      errorMessage: `gh token for ${host} has expired. Run: gh auth refresh --hostname ${host}`,
    };
  }

  const loggedIn = lower.includes('logged in');
  if (!loggedIn) {
    return {
      authenticated: false,
      activeAccount: null,
      expired: false,
      errorMessage: `Not logged in to ${host}. Run: gh auth login --hostname ${host}`,
    };
  }

  // Authenticated: query the active login.
  const activeAccount = run('gh api user --jq .login');
  return {
    authenticated: true,
    activeAccount: activeAccount || null,
    expired: false,
    errorMessage: null,
  };
}

/**
 * Pure helper — pick a gh account whose login matches the given repo owner (case-insensitive).
 * Used by post-failure recovery (issue #184). Pure / no I/O so it can be unit-tested
 * without mocking gh.
 *
 * @param {string} owner — repo owner from `parseRemoteOwner`
 * @param {Array<{login: string, active?: boolean}>} accounts — list of gh accounts
 * @returns {{ login: string, active: boolean }|null}
 */
function selectAccountForOwner(owner, accounts) {
  if (!owner || !Array.isArray(accounts) || accounts.length === 0) return null;
  const ownerLower = String(owner).toLowerCase();
  const match = accounts.find(
    a => a && typeof a.login === 'string' && a.login.toLowerCase() === ownerLower
  );
  if (!match) return null;
  return { login: match.login, active: Boolean(match.active) };
}

/**
 * Permission-error signature check for `gh pr create` failures (issue #184).
 * Returns true when the error text indicates the active gh account lacks
 * permission to create a pull request on this repo (vs. unrelated failures
 * like 404, network, or rate-limit).
 *
 * @param {string} errorText
 * @returns {boolean}
 */
function isGhCreatePrPermissionError(errorText) {
  if (typeof errorText !== 'string' || errorText.length === 0) return false;
  const lower = errorText.toLowerCase();
  return (
    lower.includes('does not have the correct permissions to execute') &&
    lower.includes('createpullrequest')
  );
}

/**
 * Post-failure gh-account-switch recovery for `gh pr create`.
 *
 * Composes existing helpers (`parseRemoteOwner`, `getGhAccounts`, `exec`) — no new
 * git or gh primitives. Distinct from the pre-flight `ensureGhAccount`:
 * this runs ONLY when `gh pr create` already failed with a permission error,
 * so it can confirm the recovery actually changed something.
 *
 * Behavior:
 *   - If `errorText` is not a permission error → `{ recovered: false, reason: "non-permission-error" }`
 *   - If matching account is already active → `{ recovered: false, switched: false, reason: "already-active", account, host }`
 *   - If matching account exists and switch succeeds → `{ recovered: true, switched: true, account, previousAccount, host }`
 *   - If no matching account on parsed host AND host is non-canonical (≠ "github.com"), queries
 *     `github.com` as fallback (or consults `opts.fallbackAccounts` for hermetic test injection).
 *     On fallback match: returns `{ recovered: true, ..., viaFallback: true, host: "github.com" }`.
 *     On fallback no-match: returns `{ recovered: false, hint: "gh auth login --hostname github.com", host: "github.com" }`.
 *   - If no matching account and host is already `github.com` → `{ recovered: false, hint: "gh auth login --hostname github.com", host }`
 *
 * For test injection (so promptfoo exec tests can run hermetically), pass
 * `accounts`, `remote`, and optionally `fallbackAccounts` directly instead of
 * letting the function call gh. The library accepts `fallbackAccounts` in any
 * call (regardless of `dryRun`); the `pr-recover-gh-account` CLI enforces the
 * dry-run-only wiring at the argument-parsing layer.
 *
 * @param {string} projectRoot
 * @param {string} errorText
 * @param {{ accounts?: Array<{login:string, active?:boolean}>, fallbackAccounts?: Array<{login:string, active?:boolean}>, remote?: {host:string,owner:string,repo:string}, dryRun?: boolean }} [opts]
 * @returns {object}
 */
function recoverGhAccountForRepo(projectRoot, errorText, opts = {}) {
  if (!isGhCreatePrPermissionError(errorText)) {
    return { recovered: false, reason: 'non-permission-error' };
  }

  const remote = opts.remote || parseRemoteOwner(projectRoot);
  if (!remote) {
    return { recovered: false, switched: false, reason: 'no-remote' };
  }
  const { host, owner } = remote;

  let accounts = opts.accounts;
  if (!accounts) {
    const result = getGhAccounts(host);
    if (result.error) {
      return { recovered: false, switched: false, reason: 'gh-status-error', error: result.error };
    }
    accounts = result.accounts;
  }

  const match = selectAccountForOwner(owner, accounts);
  if (!match) {
    // No match on the parsed host. If the host is a non-canonical SSH alias (≠ "github.com"),
    // try github.com as a fallback — the real account may be registered under the canonical host.
    if (host !== 'github.com') {
      let fallbackAccounts = opts.fallbackAccounts;
      if (!fallbackAccounts) {
        const fallbackResult = getGhAccounts('github.com');
        if (fallbackResult.error) {
          return { recovered: false, switched: false, reason: 'gh-status-error', error: fallbackResult.error };
        }
        fallbackAccounts = fallbackResult.accounts;
      }

      const fallbackMatch = selectAccountForOwner(owner, fallbackAccounts);
      if (!fallbackMatch) {
        return {
          recovered: false,
          switched: false,
          hint: 'gh auth login --hostname github.com',
          owner,
          host: 'github.com',
        };
      }

      const fallbackActive = fallbackAccounts.find(a => a && a.active) || null;
      const previousAccount = fallbackActive ? fallbackActive.login : null;

      if (fallbackMatch.active) {
        return {
          recovered: false,
          switched: false,
          reason: 'already-active',
          account: fallbackMatch.login,
          host: 'github.com',
        };
      }

      if (opts.dryRun) {
        return {
          recovered: true,
          switched: true,
          account: fallbackMatch.login,
          previousAccount,
          host: 'github.com',
          viaFallback: true,
          dryRun: true,
        };
      }

      const switchResult = exec(`gh auth switch --hostname github.com --user ${fallbackMatch.login}`);
      const verify = getGhAccounts('github.com');
      if (verify.error || !Array.isArray(verify.accounts)) {
        return {
          recovered: false,
          switched: false,
          reason: 'switch-verify-failed',
          error: verify.error,
          host: 'github.com',
        };
      }
      const newActive = verify.accounts.find(a => a && a.active);
      if (newActive && newActive.login.toLowerCase() === fallbackMatch.login.toLowerCase()) {
        return {
          recovered: true,
          switched: true,
          account: fallbackMatch.login,
          previousAccount,
          host: 'github.com',
          viaFallback: true,
        };
      }

      return {
        recovered: false,
        switched: false,
        reason: 'switch-failed',
        account: fallbackMatch.login,
        previousAccount,
        host: 'github.com',
        error: switchResult,
      };
    }

    return {
      recovered: false,
      switched: false,
      hint: `gh auth login --hostname ${host}`,
      owner,
      host,
    };
  }

  const activeAccount = accounts.find(a => a && a.active) || null;
  const previousAccount = activeAccount ? activeAccount.login : null;

  if (match.active) {
    return {
      recovered: false,
      switched: false,
      reason: 'already-active',
      account: match.login,
      host,
    };
  }

  if (opts.dryRun) {
    return {
      recovered: true,
      switched: true,
      account: match.login,
      previousAccount,
      host,
      dryRun: true,
    };
  }

  const switchResult = exec(`gh auth switch --user ${match.login}`);
  // gh auth switch prints to stderr on success and may return null in our exec wrapper —
  // verify by re-querying status.
  const verify = getGhAccounts(host);
  if (verify.error || !Array.isArray(verify.accounts)) {
    return {
      recovered: false,
      switched: false,
      reason: 'switch-verify-failed',
      error: verify.error,
      host,
    };
  }
  const newActive = verify.accounts.find(a => a && a.active);
  if (newActive && newActive.login.toLowerCase() === match.login.toLowerCase()) {
    return {
      recovered: true,
      switched: true,
      account: match.login,
      previousAccount,
      host,
    };
  }

  return {
    recovered: false,
    switched: false,
    reason: 'switch-failed',
    account: match.login,
    previousAccount,
    host,
    error: switchResult,
  };
}

// ---------------------------------------------------------------------------
// PR-specific helpers (used by pr-prepare.js only)
// ---------------------------------------------------------------------------

/**
 * Check the remote tracking state of the current branch.
 * Performs a best-effort `git fetch` so the local view of the upstream ref is
 * fresh; offline or auth failures do not throw — callers fall back to whatever
 * the cached ref reports.
 * @param {string} projectRoot
 * @returns {{ hasUpstream: boolean, remoteBranch: string|null, isAhead: boolean, isBehind: boolean }}
 */
function getRemoteState(projectRoot) {
  const upstream = exec(
    'git rev-parse --abbrev-ref --symbolic-full-name @{upstream}',
    { cwd: projectRoot }
  );
  if (!upstream) return { hasUpstream: false, remoteBranch: null, isAhead: false, isBehind: false };

  // Best-effort fetch so isAhead/isBehind reflect actual remote state.
  // Upstream form is "<remote>/<branch>"; fetch only that branch from that remote.
  const slash = upstream.indexOf('/');
  if (slash > 0) {
    const remote = upstream.slice(0, slash);
    const remoteBranch = upstream.slice(slash + 1);
    spawnSync('git', ['fetch', '--quiet', remote, remoteBranch], { cwd: projectRoot, encoding: 'utf8' });
  }

  const aheadBehind = exec(`git status -sb`, { cwd: projectRoot }) || '';
  const isAhead = /ahead/.test(aheadBehind);
  const isBehind = /behind/.test(aheadBehind);
  return { hasUpstream: true, remoteBranch: upstream, isAhead, isBehind };
}

/**
 * Push the current branch to origin.
 * If no upstream exists, uses `git push -u origin <branch>`.
 * Otherwise uses `git push`.
 * @param {string} projectRoot
 * @param {boolean} hasUpstream
 * @returns {'pushed-new' | 'pushed' | 'error'}
 */
function pushToRemote(projectRoot, hasUpstream) {
  if (!hasUpstream) {
    const branch = exec('git branch --show-current', { cwd: projectRoot });
    if (!branch) return 'error';
    const result = spawnSync('git', ['push', '-u', 'origin', branch], { cwd: projectRoot, encoding: 'utf8' });
    return result.status === 0 ? 'pushed-new' : 'error';
  }
  const result = spawnSync('git', ['push'], { cwd: projectRoot, encoding: 'utf8' });
  return result.status === 0 ? 'pushed' : 'error';
}

/**
 * Return structured commit objects between base and HEAD.
 * Parses Co-authored-by trailers.
 * @param {string} base
 * @param {string} projectRoot
 * @returns {Array<{ hash: string, subject: string, body: string, coAuthors: string[] }>}
 */
function getCommitsStructured(base, projectRoot) {
  // Use a unique separator to split commits reliably
  const SEP = '---COMMIT---';
  const raw = exec(
    `git log --format="${SEP}%n%H%n%s%n%b%n%(trailers:key=Co-authored-by)" ${base}..HEAD`,
    { cwd: projectRoot }
  );
  if (!raw) return [];

  const commits = [];
  const blocks = raw.split(SEP).filter(b => b.trim());

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;

    const hash    = lines[0].trim().slice(0, 8);
    const subject = lines[1].trim();
    const rest    = lines.slice(2);

    // Co-authored-by trailers are at the end; body is everything in between
    const coAuthors = rest.filter(l => /^Co-authored-by:/i.test(l.trim())).map(l => l.trim());
    const bodyLines = rest.filter(l => !/^Co-authored-by:/i.test(l.trim()));
    const body = bodyLines.join('\n').trim();

    if (hash && subject) {
      commits.push({ hash, subject, body, coAuthors });
    }
  }

  return commits;
}

/**
 * Return diff statistics between base and HEAD.
 * @param {string} base
 * @param {string} projectRoot
 * @returns {{ filesChanged: number, insertions: number, deletions: number, summary: string }}
 */
function getDiffStat(base, projectRoot) {
  const stat = exec(buildBranchContribDiffCmd('stat', base), { cwd: projectRoot }) || '';
  const summary = stat.split('\n').filter(Boolean).pop() || '';

  // Parse "N files changed, N insertions(+), N deletions(-)"
  const filesMatch = summary.match(/(\d+) files? changed/);
  const insMatch   = summary.match(/(\d+) insertions?\(\+\)/);
  const delMatch   = summary.match(/(\d+) deletions?\(-\)/);

  const insertions = insMatch ? parseInt(insMatch[1], 10) : 0;
  const deletions  = delMatch ? parseInt(delMatch[1], 10) : 0;
  return {
    filesChanged:      filesMatch ? parseInt(filesMatch[1], 10) : 0,
    insertions,
    deletions,
    totalLinesChanged: insertions + deletions,
    summary,
  };
}

/**
 * Return the full unified diff between base and HEAD.
 * @param {string} base
 * @param {string} projectRoot
 * @returns {string}
 */
function getDiffContent(base, projectRoot) {
  return exec(buildBranchContribDiffCmd('content', base), { cwd: projectRoot }) || '';
}

/**
 * Split a raw unified diff string into per-file chunks.
 * @param {string} rawDiff  Full unified diff output from git
 * @returns {Map<string, string>}  Map of file path → diff chunk
 */
function splitDiffByFile(rawDiff) {
  const fileDiffs = new Map();
  const chunks    = rawDiff.split(/(?=^diff --git )/m);

  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    const m = chunk.match(/^diff --git a\/.+ b\/(.+)/m);
    if (m) fileDiffs.set(m[1].trim(), chunk);
  }

  return fileDiffs;
}

// ---------------------------------------------------------------------------
// Version-specific helpers (used by version-prepare.js only)
// ---------------------------------------------------------------------------

/**
 * List all semver-like tags, sorted by descending version (latest first).
 * Includes tags with or without a 'v' prefix (e.g., 'v1.2.3' or '1.2.3').
 * @param {string} projectRoot
 * @returns {string[]}
 */
function getTagList(projectRoot) {
  const out = exec('git tag --list --sort=-v:refname', { cwd: projectRoot });
  if (!out) return [];
  return out.split('\n').filter(tag => /^v?\d+\.\d+\.\d+/.test(tag));
}

/**
 * Return structured commit objects since a given ref (tag, commit, etc.) up to HEAD.
 * If sinceRef is empty or null, returns ALL commits in the repository.
 * Uses the same separator-based parsing as getCommitsStructured.
 * @param {string|null} sinceRef - tag name, commit SHA, or null for all commits
 * @param {string} projectRoot
 * @returns {Array<{ hash: string, subject: string, body: string, coAuthors: string[] }>}
 */
function getCommitsSinceRef(sinceRef, projectRoot) {
  const SEP   = '---COMMIT---';
  const range = sinceRef ? `${sinceRef}..HEAD` : 'HEAD';
  const raw   = exec(
    `git log --format="${SEP}%n%H%n%s%n%b%n%(trailers:key=Co-authored-by)" ${range}`,
    { cwd: projectRoot }
  );
  if (!raw) return [];

  const commits = [];
  const blocks  = raw.split(SEP).filter(b => b.trim());

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;

    const hash    = lines[0].trim().slice(0, 8);
    const subject = lines[1].trim();
    const rest    = lines.slice(2);

    const coAuthors = rest.filter(l => /^Co-authored-by:/i.test(l.trim())).map(l => l.trim());
    const bodyLines = rest.filter(l => !/^Co-authored-by:/i.test(l.trim()));
    const body      = bodyLines.join('\n').trim();

    if (hash && subject) {
      commits.push({ hash, subject, body, coAuthors });
    }
  }

  return commits;
}

/**
 * Get commits between two git refs using a `fromRef..toRef` range.
 *
 * Unlike `getCommitsSinceRef` (which always ends at HEAD), this function
 * targets a closed range — useful for collecting exactly the commits that
 * make up a specific release.
 *
 * Edge cases:
 * - `fromRef` null/undefined → range = `toRef` (all commits up to toRef)
 * - `toRef` null/undefined   → falls back to `fromRef..HEAD` (same as getCommitsSinceRef)
 * - both null/undefined      → range = `HEAD`
 *
 * @param {string|null|undefined} fromRef    - Start of range (exclusive); e.g. previous tag
 * @param {string|null|undefined} toRef      - End of range (inclusive); e.g. current tag
 * @param {string}                projectRoot - Working directory for git
 * @returns {Array<{ hash: string, subject: string, body: string, coAuthors: string[] }>}
 */
function getCommitsBetweenRefs(fromRef, toRef, projectRoot) {
  if (!toRef) return getCommitsSinceRef(fromRef, projectRoot);

  const SEP   = '---COMMIT---';
  const range = fromRef ? `${fromRef}..${toRef}` : toRef;
  const raw   = exec(
    `git log --format="${SEP}%n%H%n%s%n%b%n%(trailers:key=Co-authored-by)" ${range}`,
    { cwd: projectRoot }
  );
  if (!raw) return [];

  const commits = [];
  const blocks  = raw.split(SEP).filter(b => b.trim());

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;

    const hash    = lines[0].trim().slice(0, 8);
    const subject = lines[1].trim();
    const rest    = lines.slice(2);

    const coAuthors = rest.filter(l => /^Co-authored-by:/i.test(l.trim())).map(l => l.trim());
    const bodyLines = rest.filter(l => !/^Co-authored-by:/i.test(l.trim()));
    const body      = bodyLines.join('\n').trim();

    if (hash && subject) {
      commits.push({ hash, subject, body, coAuthors });
    }
  }

  return commits;
}

// ---------------------------------------------------------------------------
// Received-review-specific helpers
// ---------------------------------------------------------------------------

/**
 * Return the authenticated GitHub username via `gh api user --jq .login`.
 * Returns null if `gh` is unavailable or the command fails.
 * @returns {string|null}
 */
function getCurrentUser() {
  return exec('gh api user --jq .login');
}

/**
 * Fetch all review threads for a PR via GitHub GraphQL API.
 * Handles pagination automatically (100 threads per page).
 * Returns an empty array on any failure (gh unavailable, API error, etc.).
 *
 * @param {string} owner      - Repository owner (org or user login)
 * @param {string} repo       - Repository name
 * @param {number} prNumber   - Pull request number
 * @returns {Array<{
 *   id: string,
 *   isResolved: boolean,
 *   isOutdated: boolean,
 *   path: string,
 *   line: number|null,
 *   startLine: number|null,
 *   comments: Array<{
 *     id: string,
 *     databaseId: number,
 *     body: string,
 *     authorLogin: string,
 *     createdAt: string
 *   }>
 * }>}
 */
function fetchPrReviewThreads(owner, repo, prNumber) {
  const query = `
    query($owner: String!, $repo: String!, $prNumber: Int!, $after: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $prNumber) {
          reviewThreads(first: 100, after: $after) {
            nodes {
              id
              isResolved
              isOutdated
              path
              line
              startLine
              diffSide
              comments(first: 100) {
                nodes {
                  id
                  databaseId
                  body
                  author {
                    login
                  }
                  createdAt
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }
  `;

  const threads = [];
  let cursor = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const cursorArg = cursor ? ` -F after=${cursor}` : '';
    const raw = exec(
      `gh api graphql -f query='${query.replace(/'/g, "'\\''")}' -F owner=${owner} -F repo=${repo} -F prNumber=${prNumber}${cursorArg}`
    );

    if (!raw) return [];

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      return [];
    }

    const reviewThreads =
      parsed &&
      parsed.data &&
      parsed.data.repository &&
      parsed.data.repository.pullRequest &&
      parsed.data.repository.pullRequest.reviewThreads;

    if (!reviewThreads) return [];

    for (const node of (reviewThreads.nodes || [])) {
      const comments = (node.comments && node.comments.nodes || []).map(c => ({
        id: c.id,
        databaseId: c.databaseId,
        body: c.body,
        authorLogin: c.author ? c.author.login : null,
        createdAt: c.createdAt,
      }));

      threads.push({
        id: node.id,
        isResolved: node.isResolved,
        isOutdated: node.isOutdated,
        path: node.path,
        line: node.line,
        startLine: node.startLine,
        comments,
      });
    }

    const pageInfo = reviewThreads.pageInfo;
    if (!pageInfo || !pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  return threads;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Core
  exec,
  retryExec,
  // Shared
  checkGitState,
  detectBaseBranch,
  detectBaseBranchSafe,
  fetchBaseRef,
  buildBranchContribDiffCmd,
  getChangedFiles,
  getCommitLog,
  getCommitCount,
  fetchPrMetadata,
  fetchPrReviews,
  fetchPrChecks,
  fetchFailedCheckLogs,
  fetchRepoLabels,
  parseRemoteOwner,
  getGhAccounts,
  ensureGhAccount,
  selectAccountForOwner,
  isGhCreatePrPermissionError,
  recoverGhAccountForRepo,
  probeGhAuth,
  formatAccountMismatch,
  probeRepoAccess,
  formatAccessDenied,
  // PR-specific
  getRemoteState,
  pushToRemote,
  getCommitsStructured,
  getDiffStat,
  getDiffContent,
  splitDiffByFile,
  // Version-specific
  getTagList,
  getCommitsSinceRef,
  getCommitsBetweenRefs,
  // Received-review-specific
  getCurrentUser,
  fetchPrReviewThreads,
};
