'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { parseArgs, runPlanHash } = require('./plan-hash');

const SCRIPT = path.join(__dirname, 'plan-hash.js');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plan-hash-cli-'));
}

function run(args, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs reads the positional file path', () => {
  const parsed = parseArgs(['node', '/x/plan-hash.js', 'plan.md']);
  assert.strictEqual(parsed.filePath, 'plan.md');
  assert.strictEqual(parsed.scriptName, '/x/plan-hash.js');
});

test('parseArgs yields a null file path when no argument is given', () => {
  assert.strictEqual(parseArgs(['node', '/x/plan-hash.js']).filePath, null);
});

// ---------------------------------------------------------------------------
// runPlanHash (in-process)
// ---------------------------------------------------------------------------

test('runPlanHash reports Usage and exit 1 with no argument', () => {
  const res = runPlanHash(['node', '/x/plan-hash.js']);
  assert.strictEqual(res.exitCode, 1);
  assert.strictEqual(res.stdout, '');
  assert.strictEqual(res.stderr, 'Usage: /x/plan-hash.js <file-path>\n');
});

test('runPlanHash reports "not found" and exit 1 for a missing file', () => {
  const missing = path.join(os.tmpdir(), 'plan-hash-nope-98765.md');
  const res = runPlanHash(['node', '/x/plan-hash.js', missing]);
  assert.strictEqual(res.exitCode, 1);
  assert.strictEqual(res.stderr, `Error: File '${missing}' not found\n`);
});

test('runPlanHash treats a directory as "not found", like the shell -f test', () => {
  const dir = makeTempDir();
  try {
    const res = runPlanHash(['node', '/x/plan-hash.js', dir]);
    assert.strictEqual(res.exitCode, 1);
    assert.match(res.stderr, /not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runPlanHash exits 2 when hashing itself throws', () => {
  const dir = makeTempDir();
  try {
    const file = path.join(dir, 'plan.md');
    fs.writeFileSync(file, 'x');
    const res = runPlanHash(['node', '/x/plan-hash.js', file], {
      computePlanHashFn: () => { throw new Error('EACCES: permission denied'); },
    });
    assert.strictEqual(res.exitCode, 2);
    assert.strictEqual(res.stdout, '');
    assert.match(res.stderr, /^Error hashing file: EACCES/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// End-to-end CLI
// ---------------------------------------------------------------------------

test('CLI prints only the digest on stdout and exits 0', () => {
  const dir = makeTempDir();
  try {
    const body = '# Plan\n\n1. do the thing\n';
    const file = path.join(dir, 'plan.md');
    fs.writeFileSync(file, body);

    const expected = crypto.createHash('sha256').update(Buffer.from(body)).digest('hex');
    const res = run([file], dir);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.strictEqual(res.stdout, `${expected}\n`);
    assert.strictEqual(res.stderr, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI exits 1 with a Usage line on stderr when called with no arguments', () => {
  const dir = makeTempDir();
  try {
    const res = run([], dir);
    assert.strictEqual(res.status, 1);
    assert.strictEqual(res.stdout, '');
    assert.match(res.stderr, /^Usage: .*plan-hash\.js <file-path>\n$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI exits 1 when the file does not exist', () => {
  const dir = makeTempDir();
  try {
    const res = run([path.join(dir, 'nope.md')], dir);
    assert.strictEqual(res.status, 1);
    assert.strictEqual(res.stdout, '');
    assert.match(res.stderr, /^Error: File '.*nope\.md' not found\n$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
