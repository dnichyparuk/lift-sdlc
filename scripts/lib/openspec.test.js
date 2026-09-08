'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const os     = require('node:os');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, 'openspec.js');

function run(args, cwd) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd });
}

function makeProjectRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-cli-test-'));
}

// ---------------------------------------------------------------------------
// CLI entry point (`--is-archived --change <name>`) — issue: no test file
// previously existed for scripts/lib/openspec.js's CLI (parseCliArgs/main,
// require.main === module block).
// ---------------------------------------------------------------------------

test('CLI: missing --is-archived -> exit 1, usage on stderr', () => {
  const root = makeProjectRoot();
  const result = run(['--change', 'add-foo'], root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: openspec\.js --is-archived --change <name>/);
  assert.equal(result.stdout, '');
});

test('CLI: missing --change -> exit 1, usage on stderr', () => {
  const root = makeProjectRoot();
  const result = run(['--is-archived'], root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: openspec\.js --is-archived --change <name>/);
});

test('CLI: no flags at all -> exit 1, usage on stderr', () => {
  const root = makeProjectRoot();
  const result = run([], root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: openspec\.js --is-archived --change <name>/);
});

test('CLI: --is-archived --change <name>, change not archived -> exit 0, {"archived":false}', () => {
  const root = makeProjectRoot();
  const result = run(['--is-archived', '--change', 'add-foo'], root);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '{"archived":false}\n');
});

test('CLI: --is-archived --change <name>, change archived -> exit 0, {"archived":true}', () => {
  const root = makeProjectRoot();
  const archiveDir = path.join(root, 'openspec', 'changes', 'archive', '20240101-add-foo');
  fs.mkdirSync(archiveDir, { recursive: true });

  const result = run(['--is-archived', '--change', 'add-foo'], root);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '{"archived":true}\n');
});

test('CLI: flags in either order are parsed the same', () => {
  const root = makeProjectRoot();
  const result = run(['--change', 'add-bar', '--is-archived'], root);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '{"archived":false}\n');
});
