#!/usr/bin/env node
'use strict';

/**
 * links.js — Shared URL/link validator for SDLC artifact bodies.
 *
 * Implements R-link-verification across pr-sdlc, jira-sdlc, commit-sdlc,
 * plan-sdlc, received-review-sdlc, review-sdlc, version-sdlc (issue #198).
 *
 * Three URL classes are validated:
 *   1. github.com/<owner>/<repo>/(issues|pull)/<n>
 *      - owner/repo identity must match the current remote (or ctx.expectedRepo)
 *      - issue/PR number must exist on that repo (gh CLI lookup)
 *   2. *.atlassian.net/browse/<KEY-N>
 *      - host must match ctx.jiraSite (cached siteUrl)
 *      - existence check deferred (host match only for v1)
 *   3. Any other http(s):// URL
 *      - generic reachability via HEAD (fall back to GET on 405), 5s timeout
 *
 * Skip-list hosts (linkedin.com, x.com, twitter.com, medium.com) and any
 * ctx.skipHosts entries are reported as `skipped`, not violations.
 *
 * SDLC_LINKS_OFFLINE=1 (or ctx.offline === true) skips network checks but
 * KEEPS structural context-aware checks (GitHub identity match, Atlassian
 * host match — both purely structural).
 *
 * Usage (library):
 *   const { validateLinks, formatViolations } = require('./links.js');
 *   const result = await validateLinks(text, { projectRoot, expectedRepo, jiraSite });
 *   if (!result.ok) { process.stderr.write(formatViolations(result.violations)); process.exit(1); }
 *
 * Usage (CLI):
 *   echo "body" | node links.js --json
 *   node links.js --file body.txt --json --ctx '{"jiraSite":"https://acme.atlassian.net"}'
 *   exit 0 if ok, 1 if violations.
 */

const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');

let parseRemoteOwner;
try {
  ({ parseRemoteOwner } = require('./git.js'));
} catch (_) {
  // git.js may be unavailable in some test contexts — fallback handled below
  parseRemoteOwner = null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NETWORK_TIMEOUT_MS = 5000;
const NETWORK_CONCURRENCY = 5;

// Hosts known to block HEAD or return 4xx/5xx by policy. Returned as `skipped`,
// not violations. Kept as an in-script constant per KISS — users override via
// ctx.skipHosts if more are needed.
const BUILT_IN_SKIP_HOSTS = new Set([
  'linkedin.com',
  'www.linkedin.com',
  'x.com',
  'www.x.com',
  'twitter.com',
  'www.twitter.com',
  'medium.com',
  'www.medium.com',
]);

const URL_REGEX = /https?:\/\/[^\s)\]>"']+/g;
const TRAILING_PUNCT = /[.,;:!?]+$/;

// ---------------------------------------------------------------------------
// URL extraction
// ---------------------------------------------------------------------------

function extractUrls(text) {
  if (!text || typeof text !== 'string') return [];
  const seen = new Map(); // url -> first line number
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    URL_REGEX.lastIndex = 0;
    let m;
    while ((m = URL_REGEX.exec(line)) !== null) {
      let url = m[0].replace(TRAILING_PUNCT, '');
      // strip a single trailing `)` if there is no opening `(` in the URL
      if (url.endsWith(')') && !url.includes('(')) url = url.slice(0, -1);
      if (!seen.has(url)) seen.set(url, i + 1);
    }
  }
  return [...seen.entries()].map(([url, line]) => ({ url, line }));
}

// ---------------------------------------------------------------------------
// URL classification
// ---------------------------------------------------------------------------

function classifyUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return { kind: 'invalid', parsed: null };
  }
  const host = parsed.hostname.toLowerCase();
  // GitHub issues/PRs
  if (host === 'github.com' || host === 'www.github.com') {
    const m = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)\b/);
    if (m) {
      return {
        kind: 'github',
        parsed,
        owner: m[1],
        repo: m[2],
        type: m[3],     // "issues" | "pull"
        number: parseInt(m[4], 10),
      };
    }
  }
  // Atlassian Jira browse links
  if (host.endsWith('.atlassian.net')) {
    const m = parsed.pathname.match(/^\/browse\/([A-Z][A-Z0-9_]+-\d+)\b/);
    if (m) {
      return { kind: 'atlassian', parsed, host, key: m[1] };
    }
  }
  return { kind: 'generic', parsed, host };
}

// ---------------------------------------------------------------------------
// GitHub class checks
// ---------------------------------------------------------------------------

function ghViewExists(owner, repo, type, number) {
  const cmd = type === 'issues' ? 'issue' : 'pr';
  try {
    execFileSync('gh', [cmd, 'view', String(number), '-R', `${owner}/${repo}`, '--json', 'number'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 10_000,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: err.message || 'gh lookup failed' };
  }
}

function checkGithubUrl(c, ctx) {
  const expected = ctx.expectedRepo;
  if (!expected) {
    // Without an expected repo we can't verify identity — treat as identity unknown,
    // but still verify existence (best effort) when not offline.
    if (ctx.offline) {
      return { ok: true };
    }
    const ex = ghViewExists(c.owner, c.repo, c.type, c.number);
    return ex.ok
      ? { ok: true }
      : { ok: false, reason: 'github-not-found', detail: ex.detail };
  }
  // Identity check — case-insensitive, host check optional (only applies to github.com)
  const obsOwner = c.owner.toLowerCase();
  const obsRepo  = c.repo.toLowerCase();
  const expOwner = expected.owner.toLowerCase();
  const expRepo  = expected.repo.toLowerCase();
  if (obsOwner !== expOwner || obsRepo !== expRepo) {
    return {
      ok: false,
      reason: 'github-context-mismatch',
      detail: { observed: `${c.owner}/${c.repo}`, expected: `${expected.owner}/${expected.repo}` },
    };
  }
  if (ctx.offline) return { ok: true };
  const ex = ghViewExists(c.owner, c.repo, c.type, c.number);
  return ex.ok
    ? { ok: true }
    : { ok: false, reason: 'github-not-found', detail: ex.detail };
}

// ---------------------------------------------------------------------------
// Atlassian class checks
// ---------------------------------------------------------------------------

function discoverJiraSiteFromCache() {
  // Best-effort discovery of a single cached site under ~/.sdlc-cache/jira/.
  // Returns { site: <hostname>|null, ambiguous: boolean }
  const home = process.env.HOME;
  if (!home) return { site: null, ambiguous: false };
  const path = require('node:path');
  const fs = require('node:fs');
  const dir = path.join(home, '.sdlc-cache', 'jira');
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch (_) {
    return { site: null, ambiguous: false };
  }
  if (entries.length === 0) return { site: null, ambiguous: false };
  if (entries.length > 1)  return { site: null, ambiguous: true };
  // Sanitized site host: dot replaced with underscore; restore.
  const hostname = entries[0].replace(/_/g, '.');
  return { site: hostname, ambiguous: false };
}

function checkAtlassianUrl(c, ctx) {
  let site = ctx.jiraSite;
  if (!site) {
    const discovered = discoverJiraSiteFromCache();
    if (discovered.ambiguous) {
      return {
        ok: false,
        reason: 'atlassian-site-ambiguous',
        detail: 'Multiple sites cached in ~/.sdlc-cache/jira/; pass ctx.jiraSite to disambiguate.',
      };
    }
    if (!discovered.site) {
      // No site context at all — cannot verify; report mismatch with empty expected
      return {
        ok: false,
        reason: 'atlassian-site-mismatch',
        detail: { observed: c.host, expected: null },
      };
    }
    site = `https://${discovered.site}`;
  }
  let expectedHost;
  try {
    expectedHost = new URL(site).hostname.toLowerCase();
  } catch (_) {
    return {
      ok: false,
      reason: 'atlassian-site-mismatch',
      detail: `Invalid jiraSite: ${site}`,
    };
  }
  if (c.host !== expectedHost) {
    return {
      ok: false,
      reason: 'atlassian-site-mismatch',
      detail: { observed: c.host, expected: expectedHost },
    };
  }
  // Existence check deferred per plan — host match is sufficient for v1.
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Generic class checks (network reachability)
// ---------------------------------------------------------------------------

async function fetchOnce(url, method) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), NETWORK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      redirect: 'follow',
      signal: ac.signal,
      // Some servers reject HEAD without a UA
      headers: { 'User-Agent': 'sdlc-links-validator/1.0' },
    });
    return { status: res.status };
  } finally {
    clearTimeout(timer);
  }
}

async function checkGenericUrl(c, ctx) {
  const host = c.host;
  if (BUILT_IN_SKIP_HOSTS.has(host) || (ctx.skipHostsSet && ctx.skipHostsSet.has(host))) {
    return { skip: true, reason: 'skip-list' };
  }
  if (ctx.offline) {
    return { skip: true, reason: 'offline' };
  }
  let res;
  try {
    res = await fetchOnce(c.parsed.toString(), 'HEAD');
    if (res.status === 405 || res.status === 501) {
      // Some servers don't allow HEAD — retry once with GET
      res = await fetchOnce(c.parsed.toString(), 'GET');
    }
  } catch (err) {
    return { ok: false, reason: 'url-unreachable', detail: err.message || String(err) };
  }
  if (res.status >= 200 && res.status < 400) return { ok: true };
  if (res.status >= 400 && res.status < 500) return { ok: false, reason: 'url-not-found', detail: `HTTP ${res.status}` };
  return { ok: false, reason: 'url-server-error', detail: `HTTP ${res.status}` };
}

// ---------------------------------------------------------------------------
// Concurrency helper
// ---------------------------------------------------------------------------

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function validateLinks(text, ctx = {}) {
  // Resolve context with defaults
  const offline = ctx.offline === true || process.env.SDLC_LINKS_OFFLINE === '1';
  let expectedRepo = ctx.expectedRepo || null;
  if (!expectedRepo && parseRemoteOwner) {
    try {
      expectedRepo = parseRemoteOwner(ctx.projectRoot || process.cwd());
    } catch (_) {
      expectedRepo = null;
    }
  }
  const skipHostsSet = new Set(BUILT_IN_SKIP_HOSTS);
  if (Array.isArray(ctx.skipHosts)) {
    for (const h of ctx.skipHosts) skipHostsSet.add(String(h).toLowerCase());
  }
  const resolvedCtx = {
    offline,
    expectedRepo,
    jiraSite: ctx.jiraSite || null,
    skipHostsSet,
  };

  const found = extractUrls(text);
  const violations = [];
  const skipped = [];

  // Classify and partition
  const classified = found.map(({ url, line }) => ({ url, line, c: classifyUrl(url) }));

  // Synchronous (or sync-ish) checks — github needs gh exec, atlassian needs nothing network for host match
  for (const item of classified) {
    if (item.c.kind === 'invalid') {
      violations.push({ url: item.url, line: item.line, reason: 'url-invalid' });
      continue;
    }
    if (item.c.kind === 'github') {
      const r = checkGithubUrl(item.c, resolvedCtx);
      if (!r.ok) {
        violations.push({ url: item.url, line: item.line, reason: r.reason, detail: r.detail });
      }
      item._handled = true;
    } else if (item.c.kind === 'atlassian') {
      const r = checkAtlassianUrl(item.c, resolvedCtx);
      if (!r.ok) {
        violations.push({ url: item.url, line: item.line, reason: r.reason, detail: r.detail });
      }
      item._handled = true;
    }
  }

  // Generic class — async with bounded concurrency
  const generics = classified.filter(x => x.c.kind === 'generic' && !x._handled);
  const genericResults = await mapWithConcurrency(generics, NETWORK_CONCURRENCY, async (item) => {
    return await checkGenericUrl(item.c, resolvedCtx);
  });
  for (let idx = 0; idx < generics.length; idx++) {
    const item = generics[idx];
    const r = genericResults[idx];
    if (r.skip) {
      skipped.push({ url: item.url, line: item.line, reason: r.reason });
    } else if (!r.ok) {
      violations.push({ url: item.url, line: item.line, reason: r.reason, detail: r.detail });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    skipped,
  };
}

function formatViolations(violations) {
  if (!violations || violations.length === 0) return 'No violations.';
  const lines = ['Link verification failed:', ''];
  for (const v of violations) {
    const where = v.line ? ` (line ${v.line})` : '';
    let detailStr = '';
    if (v.detail) {
      detailStr = typeof v.detail === 'string' ? ` — ${v.detail}` : ` — ${JSON.stringify(v.detail)}`;
    }
    lines.push(`  - ${v.url}${where}: ${v.reason}${detailStr}`);
  }
  lines.push('');
  lines.push('Remove or correct the listed URLs and retry.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseCliArgs(argv) {
  const args = { json: false, file: null, ctx: {} };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--file') { args.file = argv[++i]; }
    else if (a === '--ctx') {
      const raw = argv[++i];
      try { args.ctx = JSON.parse(raw || '{}'); }
      catch (_) {
        process.stderr.write(`links.js: invalid --ctx JSON: ${raw}\n`);
        process.exit(2);
      }
    } else if (a === '--help' || a === '-h') {
      process.stdout.write([
        'Usage: node links.js [--json] [--file <path>] [--ctx <json>]',
        '       echo "body" | node links.js [--json] [--ctx <json>]',
        '',
        'Validates URLs in stdin (or --file) per issue #198 link verification.',
        'Exit 0 if ok, 1 if any violation, 2 on usage error.',
        '',
        '--ctx accepts: { expectedRepo: {host,owner,repo}, jiraSite, offline, skipHosts[] }',
        '',
        'Env: SDLC_LINKS_OFFLINE=1 — skip network reachability checks',
      ].join('\n') + '\n');
      process.exit(0);
    }
  }
  return args;
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
    process.stdin.resume();
  });
}

async function mainCli() {
  const args = parseCliArgs(process.argv);
  let body;
  if (args.file) {
    try { body = readFileSync(args.file, 'utf8'); }
    catch (err) {
      process.stderr.write(`links.js: cannot read --file ${args.file}: ${err.message}\n`);
      process.exit(2);
    }
  } else {
    body = await readStdin();
  }
  const result = await validateLinks(body, args.ctx);
  if (args.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else if (result.ok) {
    process.stdout.write('OK: link verification passed' + (result.skipped.length ? ` (${result.skipped.length} skipped)` : '') + '\n');
  } else {
    process.stderr.write(formatViolations(result.violations));
    process.stderr.write('\n');
  }
  process.exit(result.ok ? 0 : 1);
}

if (require.main === module) {
  mainCli().catch(err => {
    process.stderr.write(`links.js error: ${err && err.stack || err}\n`);
    process.exit(2);
  });
} else {
  module.exports = {
    validateLinks,
    formatViolations,
    extractUrls,
    classifyUrl,
    BUILT_IN_SKIP_HOSTS,
  };
}
