'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseArgs, validate } = require('./setup-init');

const SCRIPT = path.join(__dirname, 'setup-init.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'setup-init-'));
}

function run(args, cwd) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
  return res;
}

function readOutputFile(res) {
  const filePath = res.stdout.trim();
  assert.ok(filePath, `expected an output file path on stdout, got: ${JSON.stringify(res.stdout)}`);
  const contents = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(contents);
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs: --project-config and --local-config placeholder-substituted JSON', () => {
  const result = parseArgs(['node', 'setup-init.js', '--project-config', '{"pr":{"draft":true}}', '--local-config', '{"ship":{"auto":false}}']);
  assert.deepEqual(result, { projectConfig: '{"pr":{"draft":true}}', localConfig: '{"ship":{"auto":false}}' });
});

test('parseArgs: neither flag given -> both null', () => {
  const result = parseArgs(['node', 'setup-init.js']);
  assert.deepEqual(result, { projectConfig: null, localConfig: null });
});

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

test('validate: valid JSON for both configs -> no errors', () => {
  const errors = validate({ projectConfig: '{"a":1}', localConfig: '{"b":2}' });
  assert.deepEqual(errors, []);
});

test('validate: null configs (flags omitted) -> no errors', () => {
  const errors = validate({ projectConfig: null, localConfig: null });
  assert.deepEqual(errors, []);
});

test('validate: invalid JSON in --project-config is reported', () => {
  const errors = validate({ projectConfig: '{not json', localConfig: null });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /--project-config is not valid JSON/);
});

test('validate: invalid JSON in --local-config is reported', () => {
  const errors = validate({ projectConfig: null, localConfig: '{not json' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /--local-config is not valid JSON/);
});

// ---------------------------------------------------------------------------
// CLI success path
// ---------------------------------------------------------------------------

test('CLI: creates .sdlc/ with project and local config from placeholder-substituted JSON', () => {
  const dir = makeTempDir();
  try {
    const res = run([
      '--project-config', JSON.stringify({ pr: { expectedAccount: 'octocat' } }),
      '--local-config', JSON.stringify({ ship: { auto: true } }),
    ], dir);

    assert.equal(res.status, 0, res.stderr);
    const output = readOutputFile(res);
    assert.deepEqual(output.errors, []);
    assert.equal(output.created.projectConfig.action, 'created');
    assert.equal(output.created.localConfig.action, 'created');

    const projectConfig = JSON.parse(fs.readFileSync(path.join(dir, '.sdlc', 'config.json'), 'utf8'));
    assert.equal(projectConfig.pr.expectedAccount, 'octocat');

    const localConfig = JSON.parse(fs.readFileSync(path.join(dir, '.sdlc', 'local.json'), 'utf8'));
    assert.equal(localConfig.ship.auto, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: no config flags -> .sdlc/ scaffolded, both configs skipped', () => {
  const dir = makeTempDir();
  try {
    const res = run([], dir);

    assert.equal(res.status, 0, res.stderr);
    const output = readOutputFile(res);
    assert.deepEqual(output.errors, []);
    assert.equal(output.created.projectConfig.action, 'skipped');
    assert.equal(output.created.localConfig.action, 'skipped');
    assert.ok(fs.existsSync(path.join(dir, '.sdlc', '.gitignore')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLI error path
// ---------------------------------------------------------------------------

test('CLI: invalid --project-config JSON exits 1 with errors[]', () => {
  const dir = makeTempDir();
  try {
    const res = run(['--project-config', '{not json'], dir);

    assert.equal(res.status, 1);
    const output = readOutputFile(res);
    assert.ok(output.errors.length > 0);
    assert.match(output.errors[0], /--project-config is not valid JSON/);
    assert.ok(!fs.existsSync(path.join(dir, '.sdlc', 'config.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: invalid --local-config JSON exits 1 with errors[]', () => {
  const dir = makeTempDir();
  try {
    const res = run(['--local-config', '{not json'], dir);

    assert.equal(res.status, 1);
    const output = readOutputFile(res);
    assert.ok(output.errors.length > 0);
    assert.match(output.errors[0], /--local-config is not valid JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
