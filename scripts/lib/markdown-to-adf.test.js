'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { convert } = require('./markdown-to-adf');

const SCRIPT = path.join(__dirname, 'markdown-to-adf.js');

// ---------------------------------------------------------------------------
// convert() — sanity check the library API used by the CLI's --file/stdin modes
// ---------------------------------------------------------------------------

test('convert: single paragraph produces one paragraph node', () => {
  const result = convert('Hello world');
  assert.deepEqual(result, {
    version: 1,
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }],
  });
});

// ---------------------------------------------------------------------------
// CLI: --help / -h fast path, with an open (never-closed) stdin pipe.
// Must exit promptly without waiting to read stdin.
// ---------------------------------------------------------------------------

test('CLI: --help exits 0 with Usage without reading an open stdin pipe', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--help'], {
    cwd: __dirname,
    encoding: 'utf8',
    timeout: 5000,
    // No `input` given: stdin stays open/unclosed for the child. If the
    // script tried to read stdin before exiting, this would hang until the
    // 5s timeout kills it and the assertions below would fail.
  });

  assert.notEqual(res.signal, 'SIGTERM', 'process hung and was killed by timeout');
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^Usage:/);
});

test('CLI: -h exits 0 with Usage without reading an open stdin pipe', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '-h'], {
    cwd: __dirname,
    encoding: 'utf8',
    timeout: 5000,
  });

  assert.notEqual(res.signal, 'SIGTERM', 'process hung and was killed by timeout');
  assert.equal(res.status, 0);
  assert.match(res.stdout, /^Usage:/);
});

// ---------------------------------------------------------------------------
// CLI: --file <path> mode
// ---------------------------------------------------------------------------

test('CLI: --file converts a markdown file and prints ADF JSON, exit 0', () => {
  const tmpFile = path.join(os.tmpdir(), `markdown-to-adf-test-${process.pid}-${Date.now()}.md`);
  fs.writeFileSync(tmpFile, '# Title\n\nSome paragraph.\n');
  try {
    const res = spawnSync(process.execPath, [SCRIPT, '--file', tmpFile], {
      cwd: __dirname,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.type, 'doc');
    assert.equal(parsed.content[0].type, 'heading');
    assert.equal(parsed.content[1].type, 'paragraph');
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test('CLI: --file with a missing path exits 1 with an error on stderr', () => {
  const res = spawnSync(process.execPath, [SCRIPT, '--file', '/does/not/exist.md'], {
    cwd: __dirname,
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /markdown-to-adf error:/);
});

// ---------------------------------------------------------------------------
// CLI: stdin mode — conversion of one paragraph
// ---------------------------------------------------------------------------

test('CLI: stdin mode converts one paragraph and prints ADF JSON, exit 0', () => {
  const res = spawnSync(process.execPath, [SCRIPT], {
    cwd: __dirname,
    input: 'Hello world',
    encoding: 'utf8',
    timeout: 5000,
  });
  assert.equal(res.status, 0, res.stderr);
  const parsed = JSON.parse(res.stdout);
  assert.deepEqual(parsed, {
    version: 1,
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }],
  });
});
