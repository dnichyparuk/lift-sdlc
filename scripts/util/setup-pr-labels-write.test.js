'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseArgs, validate } = require('./setup-pr-labels-write');

const SCRIPT = path.join(__dirname, 'setup-pr-labels-write.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'setup-pr-labels-write-'));
}

// Runs the CLI and resolves the writeOutput manifest protocol: stdout is
// just the temp-file path, so read that file back for the JSON payload.
function run(args, cwd) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  let json = null;
  const outPath = (res.stdout || '').trim();
  if (outPath) {
    try { json = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch (_) { /* left null */ }
  }
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, json };
}

function readConfig(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.sdlc', 'config.json'), 'utf8'));
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs defaults section to "pr" and value to null', () => {
  const parsed = parseArgs(['node', 'setup-pr-labels-write.js']);
  assert.deepStrictEqual(parsed, { section: 'pr', value: null });
});

test('parseArgs reads --section and --value', () => {
  const parsed = parseArgs([
    'node', 'setup-pr-labels-write.js',
    '--section', 'pr',
    '--value', '{"mode":"off"}',
  ]);
  assert.deepStrictEqual(parsed, { section: 'pr', value: '{"mode":"off"}' });
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

test('validate rejects a missing --value', () => {
  const { errors, labels } = validate({ section: 'pr', value: null });
  assert.strictEqual(labels, null);
  assert.ok(errors.some((e) => /--value is required/.test(e)));
});

test('validate rejects invalid JSON in --value', () => {
  const { errors, labels } = validate({ section: 'pr', value: 'not json' });
  assert.strictEqual(labels, null);
  assert.ok(errors.some((e) => /not valid JSON/.test(e)));
});

test('validate rejects an array --value (must be an object)', () => {
  const { errors, labels } = validate({ section: 'pr', value: '[]' });
  assert.strictEqual(labels, null);
  assert.ok(errors.some((e) => /must be a JSON object/.test(e)));
});

test('validate accepts a JSON object and returns the parsed labels block', () => {
  const { errors, labels } = validate({ section: 'pr', value: '{"mode":"rules","rules":[]}' });
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(labels, { mode: 'rules', rules: [] });
});

// ---------------------------------------------------------------------------
// End-to-end: writes .sdlc/config.json pr.labels
// ---------------------------------------------------------------------------

test('writes pr.labels to .sdlc/config.json', () => {
  const dir = makeTempDir();
  try {
    const block = { mode: 'llm' };
    const res = run(['--section', 'pr', '--value', JSON.stringify(block)], dir);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(res.json, `expected a manifest path on stdout, got: ${res.stdout}`);
    assert.deepStrictEqual(res.json.errors, []);
    assert.strictEqual(res.json.section, 'pr');

    const config = readConfig(dir);
    assert.deepStrictEqual(config.pr.labels, block);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('read-merge-write preserves other pr.* sibling keys', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.sdlc'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.sdlc', 'config.json'),
      JSON.stringify({ pr: { titlePattern: '^(feat|fix)', allowedTypes: ['feat', 'fix'] } })
    );

    const res = run(['--value', '{"mode":"off"}'], dir);
    assert.strictEqual(res.status, 0, res.stderr);

    const config = readConfig(dir);
    assert.strictEqual(config.pr.titlePattern, '^(feat|fix)');
    assert.deepStrictEqual(config.pr.allowedTypes, ['feat', 'fix']);
    assert.deepStrictEqual(config.pr.labels, { mode: 'off' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

test('missing --value exits 1 with an error manifest', () => {
  const dir = makeTempDir();
  try {
    const res = run([], dir);

    assert.strictEqual(res.status, 1);
    assert.ok(res.json, `expected a manifest path on stdout, got: ${res.stdout}`);
    assert.ok(res.json.errors.some((e) => /--value is required/.test(e)));

    const configPath = path.join(dir, '.sdlc', 'config.json');
    assert.strictEqual(fs.existsSync(configPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid JSON in --value exits 1 without writing config.json', () => {
  const dir = makeTempDir();
  try {
    const res = run(['--value', 'not json'], dir);

    assert.strictEqual(res.status, 1);
    assert.ok(res.json.errors.some((e) => /not valid JSON/.test(e)));

    const configPath = path.join(dir, '.sdlc', 'config.json');
    assert.strictEqual(fs.existsSync(configPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
