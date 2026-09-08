'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseArgs, validate } = require('./setup-execution-guardrails-write');

const SCRIPT = path.join(__dirname, 'setup-execution-guardrails-write.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'setup-exec-guardrails-write-'));
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

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs defaults section to "execute" and value to null', () => {
  const parsed = parseArgs(['node', 'setup-execution-guardrails-write.js']);
  assert.deepStrictEqual(parsed, { section: 'execute', value: null });
});

test('parseArgs reads --section and --value', () => {
  const parsed = parseArgs([
    'node', 'setup-execution-guardrails-write.js',
    '--section', 'plan',
    '--value', '[{"id":"no-secrets"}]',
  ]);
  assert.deepStrictEqual(parsed, { section: 'plan', value: '[{"id":"no-secrets"}]' });
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

test('validate rejects a missing --value', () => {
  const { errors, guardrails } = validate({ section: 'execute', value: null });
  assert.strictEqual(guardrails, null);
  assert.ok(errors.some((e) => /--value is required/.test(e)));
});

test('validate rejects invalid JSON in --value', () => {
  const { errors, guardrails } = validate({ section: 'execute', value: '{not json' });
  assert.strictEqual(guardrails, null);
  assert.ok(errors.some((e) => /not valid JSON/.test(e)));
});

test('validate rejects a non-array --value', () => {
  const { errors, guardrails } = validate({ section: 'execute', value: '{"id":"x"}' });
  assert.strictEqual(guardrails, null);
  assert.ok(errors.some((e) => /must be a JSON array/.test(e)));
});

test('validate accepts a JSON array and returns the parsed guardrails', () => {
  const { errors, guardrails } = validate({
    section: 'execute',
    value: '[{"id":"no-secrets","severity":"error"}]',
  });
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(guardrails, [{ id: 'no-secrets', severity: 'error' }]);
});

// ---------------------------------------------------------------------------
// End-to-end: writes .sdlc/config.json execute.guardrails
// ---------------------------------------------------------------------------

test('writes guardrails to .sdlc/config.json under the execute section', () => {
  const dir = makeTempDir();
  try {
    const guardrails = [{ id: 'no-console-log', description: 'no console.log', severity: 'error' }];
    const res = run(['--section', 'execute', '--value', JSON.stringify(guardrails)], dir);

    assert.strictEqual(res.status, 0, res.stderr);
    assert.ok(res.json, `expected a manifest path on stdout, got: ${res.stdout}`);
    assert.deepStrictEqual(res.json.errors, []);
    assert.strictEqual(res.json.section, 'execute');
    assert.strictEqual(res.json.count, 1);

    const configPath = path.join(dir, '.sdlc', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepStrictEqual(config.execute.guardrails, guardrails);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('read-merge-write preserves other top-level config.json sections', () => {
  const dir = makeTempDir();
  try {
    fs.mkdirSync(path.join(dir, '.sdlc'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.sdlc', 'config.json'),
      JSON.stringify({ plan: { otherSetting: true } })
    );

    const guardrails = [{ id: 'no-secrets' }];
    const res = run(['--value', JSON.stringify(guardrails)], dir);

    assert.strictEqual(res.status, 0, res.stderr);
    const configPath = path.join(dir, '.sdlc', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepStrictEqual(config.execute.guardrails, guardrails);
    // writeSection replaces the whole target section (matches the legacy
    // .sh's writeSection(root, 'execute', { guardrails }) call) but merging
    // across *other* top-level sections is preserved by writeProjectConfig.
    assert.strictEqual(config.plan.otherSetting, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing --value exits 1 with an error manifest', () => {
  const dir = makeTempDir();
  try {
    const res = run([], dir);

    assert.strictEqual(res.status, 1);
    assert.ok(res.json, `expected a manifest path on stdout, got: ${res.stdout}`);
    assert.ok(res.json.errors.length > 0);
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
    const res = run(['--value', '{not json'], dir);

    assert.strictEqual(res.status, 1);
    assert.ok(res.json.errors.some((e) => /not valid JSON/.test(e)));

    const configPath = path.join(dir, '.sdlc', 'config.json');
    assert.strictEqual(fs.existsSync(configPath), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
