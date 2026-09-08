'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseArgs, cleanup, main } = require('./review-cleanup');

const CLI = path.join(__dirname, 'review-cleanup.js');

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { chunks.push(s); return true; };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return chunks.join('');
}

test('parseArgs reads the positional manifest-file-path', () => {
  assert.deepStrictEqual(parseArgs(['node', 'review-cleanup.js', '/tmp/manifest.json']), { manifestFile: '/tmp/manifest.json' });
  assert.deepStrictEqual(parseArgs(['node', 'review-cleanup.js']), { manifestFile: null });
});

test('success path: removes the sdlc-review- diff dir and the manifest file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-cleanup-test-'));
  const diffDir = path.join(dir, 'sdlc-review-abc123');
  fs.mkdirSync(diffDir);
  fs.writeFileSync(path.join(diffDir, 'diff.patch'), 'some diff content');
  const manifestFile = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({ diff_dir: diffDir }));

  try {
    const code = main(['node', 'review-cleanup.js', manifestFile]);
    assert.strictEqual(code, 0);
    assert.strictEqual(fs.existsSync(diffDir), false, 'diff dir should be removed');
    assert.strictEqual(fs.existsSync(manifestFile), false, 'manifest file should be removed');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('safety guard: a diff_dir NOT containing "sdlc-review-" is never removed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-cleanup-test-'));
  const unsafeDir = path.join(dir, 'not-a-review-dir');
  fs.mkdirSync(unsafeDir);
  fs.writeFileSync(path.join(unsafeDir, 'keepme.txt'), 'do not delete me');
  const manifestFile = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({ diff_dir: unsafeDir }));

  try {
    const code = main(['node', 'review-cleanup.js', manifestFile]);
    assert.strictEqual(code, 0);
    assert.strictEqual(fs.existsSync(unsafeDir), true, 'unsafe dir must survive the safety guard');
    assert.strictEqual(fs.existsSync(path.join(unsafeDir, 'keepme.txt')), true);
    // the manifest itself is still cleaned up
    assert.strictEqual(fs.existsSync(manifestFile), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('missing-manifest path: nonexistent manifest file is a silent no-op, exit 0', () => {
  const missing = path.join(os.tmpdir(), `review-cleanup-missing-${Date.now()}.json`);
  const code = main(['node', 'review-cleanup.js', missing]);
  assert.strictEqual(code, 0);
});

test('error path: malformed manifest JSON is caught and reported as a warning, exit 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-cleanup-test-'));
  const manifestFile = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestFile, '{ not valid json');

  try {
    let code;
    const err = captureStderr(() => {
      code = main(['node', 'review-cleanup.js', manifestFile]);
    });
    assert.strictEqual(code, 0);
    assert.match(err, /Warning: Cleanup failed - /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('error path: no MANIFEST_FILE argument -> exit 2, usage error on stderr', () => {
  let code;
  const err = captureStderr(() => {
    code = main(['node', 'review-cleanup.js']);
  });
  assert.strictEqual(code, 2);
  assert.match(err, /ERROR: No MANIFEST_FILE provided\./);
});

test('cleanup() swallows a rmSync failure and reports a warning via injected stderr', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-cleanup-test-'));
  const diffDir = path.join(dir, 'sdlc-review-boom');
  fs.mkdirSync(diffDir);
  const manifestFile = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({ diff_dir: diffDir }));

  const chunks = [];
  const fakeStderr = { write: (s) => { chunks.push(s); } };

  try {
    cleanup(manifestFile, {
      rmSync: () => { throw new Error('boom'); },
      stderr: fakeStderr,
    });
    assert.match(chunks.join(''), /Warning: Cleanup failed - boom/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI (subprocess): success path removes manifest and sdlc-review- dir, exit 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-cleanup-cli-test-'));
  const diffDir = path.join(dir, 'sdlc-review-cli');
  fs.mkdirSync(diffDir);
  const manifestFile = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({ diff_dir: diffDir }));

  try {
    const res = run([manifestFile]);
    assert.strictEqual(res.status, 0);
    assert.strictEqual(fs.existsSync(diffDir), false);
    assert.strictEqual(fs.existsSync(manifestFile), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI (subprocess): missing argument -> exit 2', () => {
  const res = run([]);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /ERROR: No MANIFEST_FILE provided\./);
});
