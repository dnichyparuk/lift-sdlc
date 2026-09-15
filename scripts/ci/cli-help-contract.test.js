'use strict';

// Contract: every CLI script in scripts/**/*.js must terminate on `--help`
// even when its stdin pipe is never closed (the agent-harness shape: a
// parent process holds the child's stdin open while `--help` should
// short-circuit before any stdin read). `spawnSync` closes stdin when
// `input` is omitted, so it cannot reproduce that hang — this uses async
// `spawn` with a never-ended stdin pipe instead, mirroring the
// `timeout` + `signal === null` assertions in
// scripts/skill/verify-pipeline.test.js:26-30. Header style mirrors
// scripts/ci/validate-skill-script-refs.test.js:1-30.
//
// A subset of scripts (HELP_CONTRACT) additionally promise a real,
// human-readable `Usage:` line on `--help` with exit code 0. Every other
// enumerated script only promises termination: it may exit non-zero, but
// must not hang or die by signal.

const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const SCRIPTS_ROOT = path.join(REPO_ROOT, 'scripts');

// Number of `--help` children spawned concurrently. Keeps total local
// runtime well under 2 minutes while bounding resource usage in CI.
const BATCH = 8;

// The scripts that are contractually guaranteed to print a `Usage:` line
// (matching /^Usage:/m) and exit 0 on `--help`: the six stdin-reading
// scripts converted to the fast-path (Tasks 1-3) plus the four scripts
// that already printed a `Usage:` line before this plan started.
//
// `scripts/util/create-pr.js` is deliberately EXCLUDED here: it forwards
// `--help` to the `gh` CLI, whose own help output prints `USAGE` in
// capitals, not `Usage:`. It is still covered by the termination-only
// check below, like every other enumerated script.
const HELP_CONTRACT = new Set([
  'scripts/util/parse-wave.js',
  'scripts/util/parse-verify.js',
  'scripts/util/parse-proposal.js',
  'scripts/lib/markdown-to-adf.js',
  'scripts/skill/received-review-cluster.js',
  'scripts/skill/verify-pipeline-sdlc-classify.js',
  'scripts/lib/links.js',
  'scripts/lib/ship-todos.js',
  'scripts/util/execute-workspace-setup.js',
  'scripts/util/ship-workspace-setup.js',
]);

/** Strip `//` and `/* *‍/` comments so a heuristic scan doesn't match text in comments. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * True if `process.argv` is referenced outside of any `{ }` block, i.e. at
 * module top level rather than only inside a function body. Ignores braces
 * that may appear inside strings/regexes — an acceptable heuristic for
 * scanning this repo's own script sources.
 */
function usesProcessArgvAtTopLevel(source) {
  let depth = 0;
  const re = /[{}]|process\.argv/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    if (match[0] === '{') depth++;
    else if (match[0] === '}') depth--;
    else if (depth <= 0) return true;
  }
  return false;
}

/** True if a `scripts/lib/*.js` file is a pure module with no CLI entry point. */
function isPureLibModule(source) {
  const stripped = stripComments(source);
  if (/require\.main\s*===\s*module/.test(stripped)) return false;
  if (usesProcessArgvAtTopLevel(stripped)) return false;
  return true;
}

/**
 * Enumerate every CLI script under `scripts/**‍/*.js`, excluding `*.test.js`,
 * `node_modules`, and `scripts/lib/*.js` files that are pure modules (no
 * `require.main === module` and no top-level `process.argv` use). Returns
 * paths relative to `root`, using `/` separators, sorted.
 */
function listCliScripts(root) {
  const results = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js') || entry.name.endsWith('.test.js')) continue;

      const rel = path.relative(root, full).split(path.sep).join('/');
      if (rel.startsWith('scripts/lib/')) {
        const source = fs.readFileSync(full, 'utf8');
        if (isPureLibModule(source)) continue;
      }
      results.push(rel);
    }
  }

  walk(path.join(root, 'scripts'));
  results.sort();
  return results;
}

/**
 * Spawn `node <script> --help` with stdin piped open and never ended, and a
 * `cwd` set to a fresh temp directory (never the repo root — some scripts,
 * e.g. scripts/util/scaffold-ci.js, write real files under .github/ on
 * `--help`). Resolves once the child closes, or is SIGKILLed after
 * `timeoutMs`.
 */
function runHelp(script, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-help-'));
    const child = spawn(process.execPath, [script, '--help'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      try {
        fs.rmSync(cwd, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

const relScripts = listCliScripts(REPO_ROOT);
const resultsByScript = new Map();

before(async () => {
  for (let i = 0; i < relScripts.length; i += BATCH) {
    const batch = relScripts.slice(i, i + BATCH);
    const settled = await Promise.all(
      batch.map((rel) => runHelp(path.join(REPO_ROOT, rel), { timeoutMs: 20000 })),
    );
    batch.forEach((rel, idx) => resultsByScript.set(rel, settled[idx]));
  }
});

for (const rel of relScripts) {
  test(`--help terminates: ${rel}`, () => {
    const result = resultsByScript.get(rel);
    assert.ok(result, `no result recorded for ${rel}`);
    assert.ok(!result.timedOut, `hangs on --help with stdin open: ${rel}`);
    assert.strictEqual(
      result.signal,
      null,
      `--help exited via signal ${result.signal} for ${rel} (stderr: ${result.stderr})`,
    );
  });
}

for (const rel of HELP_CONTRACT) {
  test(`--help prints usage: ${rel}`, () => {
    const result = resultsByScript.get(rel);
    assert.ok(result, `no result recorded for ${rel} — is it still enumerated by listCliScripts?`);
    assert.strictEqual(
      result.code,
      0,
      `--help did not exit 0 for ${rel} (code=${result.code}, stdout=${result.stdout}, stderr=${result.stderr})`,
    );
    assert.match(
      result.stdout,
      /^Usage:/m,
      `--help stdout did not match /^Usage:/m for ${rel} (stdout=${result.stdout})`,
    );
  });
}

module.exports = { listCliScripts, runHelp, HELP_CONTRACT, BATCH };
