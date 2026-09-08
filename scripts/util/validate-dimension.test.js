'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const { parseArgs, runValidateDimension } = require('./validate-dimension');

const SCRIPT = path.join(__dirname, 'validate-dimension.js');

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

function makeTmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-dimension-'));
  const file = path.join(dir, 'dimension.md');
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

const VALID_DIMENSION = `---
name: my-dimension
description: A test dimension.
triggers:
  - "**/*.js"
---

Review instructions go here, well past ten characters.
`;

const INVALID_DIMENSION = `---
description: Missing the name field.
triggers:
  - "**/*.js"
---

Body text.
`;

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs reads the positional file-path argument', () => {
  const parsed = parseArgs(['node', 'validate-dimension.js', '/tmp/foo.md']);
  assert.strictEqual(parsed.target, '/tmp/foo.md');
  assert.deepStrictEqual(parsed.errors, []);
});

test('parseArgs reports a usage error when no file-path is given', () => {
  const parsed = parseArgs(['node', 'validate-dimension.js']);
  assert.strictEqual(parsed.target, null);
  assert.match(parsed.errors[0], /Usage: validate-dimension\.js <file-path>/);
});

// ---------------------------------------------------------------------------
// runValidateDimension — core logic with injectable deps
// ---------------------------------------------------------------------------

test('runValidateDimension exits 1 with usage text when no file-path is given', () => {
  const res = runValidateDimension(['node', 'validate-dimension.js']);
  assert.strictEqual(res.exitCode, 1);
  assert.match(res.stderr, /Usage: validate-dimension\.js <file-path>/);
});

test('runValidateDimension exits 1 when the file does not exist', () => {
  const res = runValidateDimension(['node', 'validate-dimension.js', '/no/such/file.md'], {
    existsFn: () => false,
  });
  assert.strictEqual(res.exitCode, 1);
  assert.match(res.stderr, /File not found: \/no\/such\/file\.md/);
});

test('runValidateDimension exits 0 and prints the success message for a valid file', () => {
  const file = makeTmpFile(VALID_DIMENSION);
  const res = runValidateDimension(['node', 'validate-dimension.js', file]);
  assert.strictEqual(res.exitCode, 0);
  assert.match(res.stdout, /Dimension file is valid\./);
  assert.strictEqual(res.stderr, '');
});

test('runValidateDimension exits 2 and prints errors for an invalid file', () => {
  const file = makeTmpFile(INVALID_DIMENSION);
  const res = runValidateDimension(['node', 'validate-dimension.js', file]);
  assert.strictEqual(res.exitCode, 2);
  assert.match(res.stderr, /Error \(D2\): Missing required field: name/);
});

test('runValidateDimension prints warnings to stdout without failing on warnings-only files', () => {
  const res = runValidateDimension(['node', 'validate-dimension.js', 'dummy.md'], {
    existsFn: () => true,
    validateFn: () => ({
      errors: [],
      warnings: [{ check: 'D6', message: 'bad severity', line: 3 }],
    }),
  });
  assert.strictEqual(res.exitCode, 0);
  assert.match(res.stdout, /Warning \(D6\): bad severity at line 3/);
  assert.match(res.stdout, /Dimension file is valid\./);
});

// ---------------------------------------------------------------------------
// End-to-end CLI
// ---------------------------------------------------------------------------

test('CLI exits 1 with usage text when invoked with no arguments', () => {
  const res = run([]);
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /Usage: validate-dimension\.js <file-path>/);
});

test('CLI exits 1 when the target file does not exist', () => {
  const res = run(['/no/such/file.md']);
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /File not found/);
});

test('CLI exits 0 and prints the success message for a valid file', () => {
  const file = makeTmpFile(VALID_DIMENSION);
  const res = run([file]);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /Dimension file is valid\./);
});

test('CLI exits 2 and prints validation errors for an invalid file', () => {
  const file = makeTmpFile(INVALID_DIMENSION);
  const res = run([file]);
  assert.strictEqual(res.status, 2);
  assert.match(res.stderr, /Error \(D2\)/);
});
