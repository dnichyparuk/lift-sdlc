#!/usr/bin/env node
/**
 * mcp-failure.js — deterministic MCP failure classifier, telemetry writer,
 * and analyze-then-confirm synthesizer for jira-sdlc.
 *
 * Implements docs/specs/jira-sdlc.md R26 (classifier), R27 (telemetry),
 * R28 (analyze-then-confirm dispatch).
 *
 * Exports:
 *   classify(signal)           -> class string
 *   appendTelemetry(failure)   -> void
 *   analyzeForDispatch(failure)-> proposal object
 *   recordOccurrence(cls,key)  -> current count
 *   resolveLogPath(root)       -> absolute path to learnings log
 *
 * CLI entrypoint (if require.main === module):
 *   node mcp-failure.js --classify [--http-status N] [--error-msg X] [--hook-deny Y] [--r-path Z] [--tool T]
 *   node mcp-failure.js --telemetry --class X --tool T --site S --project P --error E --recovered R
 *   node mcp-failure.js --analyze --class X --tool T --site S --project P --error E --recovered R [--session-id ID]
 *   node mcp-failure.js --hash <value>
 *
 * Exit codes:
 *   0 — success
 *   1 — --classify produced "unknown" with no other signal (used by exec tests)
 *   2 — argument / IO error
 */

'use strict';

const fs      = require('node:fs');
const path    = require('node:path');
const crypto  = require('node:crypto');
const os      = require('node:os');
const { spawnSync } = require('node:child_process');

// ---------------------------------------------------------------------------
// Dependency resolution (plugin-tree aware; mirrors other lib helpers)
// ---------------------------------------------------------------------------
const LIB = path.join(__dirname);
const { resolveSdlcRoot } = require(path.join(LIB, 'config'));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Closed set of failure classes (R26). */
const CLASSES = ['transport', 'auth', 'schema', 'workflow', 'hook-block', 'link-verification', 'unknown'];

/** Redactor patterns — must run before any persistence or presentation. */
const REDACTORS = [
  { re: /Bearer [A-Za-z0-9._-]+/g,                              sub: 'Bearer [REDACTED]' },
  // Raw JWT (3 base64url segments separated by `.`) — must run before Bearer pattern
  // would have matched it, and catches JWTs that appear without a "Bearer " prefix
  // (e.g., in WWW-Authenticate headers or error bodies).
  { re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, sub: '[jwt:REDACTED]' },
  { re: /cookie:[^;\n]+/gi,                                      sub: 'cookie:[REDACTED]' },
  { re: /(?:cloudId|cloud_id)[=:\s"']+([0-9a-f-]{30,})/gi,     sub: (_, id) => `cloudId=[REDACTED:${id.slice(0,6)}…]` },
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, sub: '[email:REDACTED]' },
];

// ---------------------------------------------------------------------------
// resolveLogPath — canonical learnings log path with legacy fallback
// ---------------------------------------------------------------------------

/**
 * @param {string} [root] — project root (defaults to resolveSdlcRoot())
 * @returns {string} absolute path to .sdlc/learnings/log.md (creates dirs)
 */
function resolveLogPath(root) {
  const projectRoot = root || resolveSdlcRoot();
  const canonical   = path.join(projectRoot, '.sdlc', 'learnings', 'log.md');
  const legacy      = path.join(projectRoot, '.sdlc', 'learnings', 'log.md');
  // Prefer canonical; fall back if canonical dir is not writable
  try {
    fs.mkdirSync(path.dirname(canonical), { recursive: true });
    return canonical;
  } catch (_) {
    return legacy;
  }
}

// ---------------------------------------------------------------------------
// redact — apply all redactor patterns to a string
// ---------------------------------------------------------------------------

function redact(str) {
  if (typeof str !== 'string') return str;
  let s = str;
  for (const { re, sub } of REDACTORS) {
    s = s.replace(re, sub);
  }
  return s;
}

// ---------------------------------------------------------------------------
// classify(signal) — deterministic, no LLM, no network (R26)
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   httpStatus?: number,
 *   errorMessage?: string,
 *   hookDenyReason?: string,
 *   rPath?: string,
 *   toolName?: string
 * }} signal
 * @returns {string} one of CLASSES
 */
function classify(signal = {}) {
  const { httpStatus, errorMessage = '', hookDenyReason = '', rPath = '' } = signal;
  const msg  = String(errorMessage || '');
  const deny = String(hookDenyReason || '');
  const rp   = String(rPath || '');

  // Priority order matters — most specific first
  // hook-block: deny reason prefixes indicating PreToolUse hook denial (R17/R20/R21 paths)
  if (deny && /R2[01]/.test(deny)) return 'hook-block';
  // schema: deny reason prefixes indicating content/placeholder/template violations
  if (deny && /R19|C13|R18|R25|G15/.test(deny)) return 'schema';
  if (rp === 'R22') return 'link-verification';

  if (httpStatus === 401 || /cloudId|namespace|unauthorized/i.test(msg)) return 'auth';
  if (httpStatus === 403) return 'auth';
  if (httpStatus === 400 && /transition|workflow|invalid status/i.test(msg)) return 'workflow';
  if (httpStatus === 400) return 'schema';
  if (httpStatus >= 500 || /ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(msg)) return 'transport';

  return 'unknown';
}

// ---------------------------------------------------------------------------
// appendTelemetry(failure) — structured 5-line block append (R27)
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   class: string,
 *   tool: string,
 *   site: string,
 *   project: string,
 *   error: string,
 *   recovered: string
 * }} failure
 * @param {string} [root] — optional project root override
 */
function appendTelemetry(failure, root) {
  const today   = new Date().toISOString().slice(0, 10);
  const cls     = String(failure.class || 'unknown');
  const tool    = redact(String(failure.tool    || ''));
  const site    = redact(String(failure.site    || ''));
  const project = redact(String(failure.project || ''));
  const error   = redact(String(failure.error   || '').replace(/\n/g, ' ').slice(0, 300));
  const recovered = String(failure.recovered || 'no');

  const logPath = resolveLogPath(root);
  const heading = `## ${today} — jira-sdlc mcp-failure[${cls}]: ${tool}`;
  const block   = [
    heading,
    `tool: ${tool}`,
    `site: ${site}`,
    `project: ${project}`,
    `error: ${error}`,
    `recovered: ${recovered}`,
    '',
  ].join('\n');

  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, block, 'utf8');
  return block;
}

// ---------------------------------------------------------------------------
// recordOccurrence(cls, key) — per-session on-disk counter (KD7)
// ---------------------------------------------------------------------------

/**
 * Resolve a stable session identifier for the current SKILL invocation.
 *
 * Resolution order:
 *   1. `SDLC_SESSION_ID` env var (explicit caller intent, most reliable).
 *   2. A marker file under the project's sdlc root containing a UUID written
 *      on first call and reused thereafter. This is stable across separate
 *      `node mcp-failure.js` invocations even when each runs in a fresh
 *      shell (so `process.ppid` differs per invocation) — which is the
 *      normal case for SKILL.md bash blocks executed by antigravity-cli.
 *   3. Fallback to `process.ppid`/`process.pid` when no writable root exists.
 *
 * The marker file is intentionally per-project (keyed by sdlc root) rather
 * than per-shell so the R28 "twice in one invocation" contract works across
 * the multiple bash blocks a skill emits during one user turn.
 *
 * @param {string} [root] — optional project root override
 * @returns {string} session id
 */
function resolveSessionId(root) {
  if (process.env.SDLC_SESSION_ID) return process.env.SDLC_SESSION_ID;
  try {
    const projectRoot = root || resolveSdlcRoot();
    const markerDir   = path.join(projectRoot, '.sdlc', 'state');
    const marker      = path.join(markerDir, 'mcp-session.id');
    if (fs.existsSync(marker)) {
      const existing = fs.readFileSync(marker, 'utf8').trim();
      if (existing) return existing;
    }
    fs.mkdirSync(markerDir, { recursive: true });
    const id = crypto.randomBytes(8).toString('hex');
    fs.writeFileSync(marker, id, 'utf8');
    return id;
  } catch (_) {
    // sdlc root unavailable or read-only — fall back to ppid (best-effort)
    return String(process.ppid || process.pid);
  }
}

/**
 * Increments a per-session counter and returns the post-increment count.
 * Persists across CLI re-spawns within one SKILL invocation. The session
 * is identified by `resolveSessionId()` — see that function for details
 * on how stability across separate shells is achieved.
 * @param {string} cls — failure class
 * @param {string} key — arbitrary key (e.g. hook-hash, tool name)
 * @param {string} [root] — optional project root override
 * @returns {number} current count after increment
 */
function recordOccurrence(cls, key, root) {
  const sessionId = resolveSessionId(root);
  const hash      = crypto.createHash('sha1').update(`${cls}:${key}`).digest('hex');
  const dir       = path.join(os.tmpdir(), `sdlc-mcp-session-${sessionId}`);
  const file      = path.join(dir, `${cls}-${hash}.count`);

  fs.mkdirSync(dir, { recursive: true });

  let count = 0;
  try {
    count = parseInt(fs.readFileSync(file, 'utf8').trim(), 10) || 0;
  } catch (_) { /* first call — file doesn't exist yet */ }

  count += 1;
  fs.writeFileSync(file, String(count), 'utf8');
  return count;
}

// ---------------------------------------------------------------------------
// analyzeForDispatch(failure) — synthesize R28 proposal
// ---------------------------------------------------------------------------

/**
 * Synthesizes an R28 dispatch proposal. Combines local context (telemetry
 * log scan, template rendering) with a duplicate-detection lookup.
 *
 * @remarks **Network side effect.** This function invokes the `gh` CLI
 * (`gh issue list --label mcp-failure`) which performs an HTTPS call to
 * github.com. The lookup is bounded by a 10-second timeout and failures
 * are swallowed (duplicate is set to `null`). Callers running in offline
 * or hermetic CI contexts should be aware that the network call still
 * happens and may delay the function by up to the timeout. An offline
 * mode is not currently exposed.
 *
 * @param {{
 *   class: string,
 *   tool: string,
 *   site: string,
 *   project: string,
 *   error: string,
 *   recovered: string,
 *   sessionRecurrence?: number
 * }} failure
 * @param {string} [root] — optional project root override
 * @returns {{
 *   shouldDispatch: boolean,
 *   duplicate: number|null,
 *   proposal: { title: string, body: string },
 *   action: "create"|"comment"
 * }}
 */
function analyzeForDispatch(failure, root) {
  const cls     = String(failure.class || 'unknown');
  const tool    = redact(String(failure.tool    || ''));
  const site    = redact(String(failure.site    || ''));
  const project = redact(String(failure.project || ''));
  const error   = redact(String(failure.error   || '').replace(/\n/g, ' ').slice(0, 300));
  const rPath   = String(failure.rPath || '');
  const projectRoot = root || resolveSdlcRoot();

  // Prior occurrence count from learnings log
  let priorCount = 0;
  try {
    const logPath = resolveLogPath(projectRoot);
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf8');
      const pattern = new RegExp(`mcp-failure\\[${cls}\\]: ${tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
      const matches = content.match(pattern);
      priorCount = matches ? matches.length : 0;
    }
  } catch (_) { /* non-fatal */ }

  // Duplicate detection via gh CLI (KD6).
  // Use spawnSync with an argument array (no shell) to prevent injection via
  // adversarial tool names containing backticks, $(...), or unbalanced quotes.
  let duplicate = null;
  let action    = 'create';
  try {
    const ghRes = spawnSync(
      'gh',
      ['issue', 'list',
       '--state', 'open',
       '--label', 'mcp-failure',
       '--search', tool,
       '--json', 'number,title,labels'],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000, shell: false, encoding: 'utf8' }
    );
    if (ghRes.status === 0 && ghRes.stdout) {
      const issues = JSON.parse(ghRes.stdout.trim() || '[]');
      for (const issue of issues) {
        const labels = (issue.labels || []).map(l => l.name || l);
        if (labels.some(l => l === `class:${cls}`)) {
          duplicate = issue.number;
          action    = 'comment';
          break;
        }
      }
    }
  } catch (_) { /* gh CLI unavailable or network failure — not fatal */ }

  // Load template
  const templatePath = path.join(
    __dirname, '..', '..', 'skills', 'jira-sdlc', 'templates', 'McpFailure.md'
  );
  let templateContent = '';
  try {
    templateContent = fs.readFileSync(templatePath, 'utf8');
  } catch (_) {
    // Fallback minimal template
    templateContent = [
      'mcp-failure[{CLASS}]: {TOOL} on {SITE}',
      '## Classification',
      '- **Class**: `{CLASS}`',
      '- **R-path**: {R_PATH}',
      '## Observed failure',
      '- **Tool**: `{TOOL}`',
      '- **Site**: {SITE}',
      '- **Project**: {PROJECT}',
      '- **Error**: {ERROR}',
      '## Prior occurrences',
      '- **Count**: {PRIOR_COUNT}',
      '- **Duplicate**: {DUPLICATE_HINT}',
      '## Root-cause hypothesis',
      '{CLASS}-class failure on `{TOOL}`.',
      '## Relevant references',
      '- SKILL.md callsite: {R_PATH}',
    ].join('\n');
  }

  const duplicateHint = duplicate
    ? `#${duplicate} (open) — propose comment rather than new issue`
    : 'none found';

  const body = templateContent
    .replace(/\{CLASS\}/g,          cls)
    .replace(/\{TOOL\}/g,           tool)
    .replace(/\{SITE\}/g,           site)
    .replace(/\{PROJECT\}/g,        project)
    .replace(/\{ERROR\}/g,          error)
    .replace(/\{R_PATH\}/g,         rPath || 'unknown')
    .replace(/\{PRIOR_COUNT\}/g,    String(priorCount))
    .replace(/\{DUPLICATE_HINT\}/g, duplicateHint);

  const title = `mcp-failure[${cls}]: ${tool} on ${site}`;

  return {
    shouldDispatch: true,
    duplicate,
    proposal: { title, body },
    action,
  };
}

// ---------------------------------------------------------------------------
// Module exports
// ---------------------------------------------------------------------------

module.exports = {
  classify,
  appendTelemetry,
  analyzeForDispatch,
  recordOccurrence,
  resolveLogPath,
  resolveSessionId,
};

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

if (require.main === module) {
  const argv = process.argv.slice(2);

  function getArg(name) {
    const idx = argv.indexOf(`--${name}`);
    if (idx === -1) return undefined;
    return argv[idx + 1];
  }

  function hasFlag(name) {
    return argv.includes(`--${name}`);
  }

  // ---- --classify
  if (hasFlag('classify')) {
    const httpStatus  = getArg('http-status')  != null ? Number(getArg('http-status')) : undefined;
    const errorMsg    = getArg('error-msg')    || '';
    const hookDeny    = getArg('hook-deny')    || '';
    const rPath       = getArg('r-path')       || '';
    const toolName    = getArg('tool')         || '';

    const result = classify({ httpStatus, errorMessage: errorMsg, hookDenyReason: hookDeny, rPath, toolName });
    process.stdout.write(result + '\n');
    // Exit 1 when unknown with no signal — exec tests assert "unknown" is reachable
    process.exit(result === 'unknown' ? 1 : 0);
  }

  // ---- --telemetry
  if (hasFlag('telemetry')) {
    const cls       = getArg('class')     || 'unknown';
    const tool      = getArg('tool')      || '';
    const site      = getArg('site')      || '';
    const project   = getArg('project')   || '';
    const error     = getArg('error')     || '';
    const recovered = getArg('recovered') || 'no';

    try {
      const block = appendTelemetry({ class: cls, tool, site, project, error, recovered });
      process.stdout.write(block);
      process.exit(0);
    } catch (err) {
      process.stderr.write(`mcp-failure --telemetry error: ${err.message}\n`);
      process.exit(2);
    }
  }

  // ---- --analyze
  if (hasFlag('analyze')) {
    const cls       = getArg('class')     || 'unknown';
    const tool      = getArg('tool')      || '';
    const site      = getArg('site')      || '';
    const project   = getArg('project')   || '';
    const error     = getArg('error')     || '';
    const recovered = getArg('recovered') || 'no';
    const rPath     = getArg('r-path')    || '';

    try {
      const result = analyzeForDispatch({ class: cls, tool, site, project, error, recovered, rPath });
      // Stable key order: shouldDispatch, duplicate, proposal, action
      const out = {
        shouldDispatch: result.shouldDispatch,
        duplicate:      result.duplicate,
        proposal:       result.proposal,
        action:         result.action,
      };
      process.stdout.write(JSON.stringify(out) + '\n');
      process.exit(0);
    } catch (err) {
      process.stderr.write(`mcp-failure --analyze error: ${err.message}\n`);
      process.exit(2);
    }
  }

  // ---- --record-occurrence
  if (hasFlag('record-occurrence')) {
    const cls = getArg('class') || 'unknown';
    const key = getArg('key')   || '';
    const count = recordOccurrence(cls, key);
    process.stdout.write(String(count) + '\n');
    process.exit(0);
  }

  // ---- --hash
  if (hasFlag('hash')) {
    const value = getArg('hash') || '';
    const hash  = crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
    process.stdout.write(hash + '\n');
    process.exit(0);
  }

  process.stderr.write('Usage: node mcp-failure.js --classify|--telemetry|--analyze|--record-occurrence|--hash [args]\n');
  process.exit(2);
}
