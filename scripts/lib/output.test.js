'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const OUTPUT_LIB = path.resolve(__dirname, 'output.js');

function runNode(script) {
  return spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// writeOutput
// ---------------------------------------------------------------------------

test('writeOutput: writes JSON to a temp file and prints only the path on stdout', () => {
  const res = runNode(`
    const { writeOutput } = require(${JSON.stringify(OUTPUT_LIB)});
    writeOutput({ foo: 'bar' }, 'output-test');
  `);
  assert.strictEqual(res.status, 0);
  const printedPath = res.stdout.trim();
  assert.ok(printedPath.length > 0, 'should print a path');
  assert.strictEqual(path.dirname(printedPath), os.tmpdir());
  assert.match(path.basename(printedPath), /^output-test-[0-9a-f]{8}\.json$/);

  try {
    const content = fs.readFileSync(printedPath, 'utf8');
    assert.strictEqual(content, JSON.stringify({ foo: 'bar' }, null, 2) + '\n');
  } finally {
    fs.rmSync(printedPath, { force: true });
  }
});

test('writeOutput: honors a custom exit code', () => {
  const res = runNode(`
    const { writeOutput } = require(${JSON.stringify(OUTPUT_LIB)});
    writeOutput({ x: 1 }, 'output-test-exit', 3);
  `);
  assert.strictEqual(res.status, 3);
  const printedPath = res.stdout.trim();
  fs.rmSync(printedPath, { force: true });
});

// ---------------------------------------------------------------------------
// writeJsonLine
// ---------------------------------------------------------------------------

test('writeJsonLine: default — compact JSON line, exit code 0', () => {
  const res = runNode(`
    const { writeJsonLine } = require(${JSON.stringify(OUTPUT_LIB)});
    writeJsonLine({ a: 1, b: 2 });
  `);
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, JSON.stringify({ a: 1, b: 2 }) + '\n');
});

test('writeJsonLine: opts.exitCode sets the process exit code', () => {
  const res = runNode(`
    const { writeJsonLine } = require(${JSON.stringify(OUTPUT_LIB)});
    writeJsonLine({ ok: false }, { exitCode: 5 });
  `);
  assert.strictEqual(res.status, 5);
});

test('writeJsonLine: legacy integer-arg shim treats the bare number as exitCode', () => {
  const res = runNode(`
    const { writeJsonLine } = require(${JSON.stringify(OUTPUT_LIB)});
    writeJsonLine({ ok: false }, 7);
  `);
  assert.strictEqual(res.status, 7);
  assert.strictEqual(res.stdout, JSON.stringify({ ok: false }) + '\n');
});

test('writeJsonLine: opts.indent pretty-prints the JSON payload', () => {
  const res = runNode(`
    const { writeJsonLine } = require(${JSON.stringify(OUTPUT_LIB)});
    writeJsonLine({ a: 1 }, { indent: 2 });
  `);
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, JSON.stringify({ a: 1 }, null, 2) + '\n');
});

test('writeJsonLine: opts.exit === false suppresses process.exit, letting the caller continue', () => {
  const res = runNode(`
    const { writeJsonLine } = require(${JSON.stringify(OUTPUT_LIB)});
    writeJsonLine({ step: 1 }, { exit: false });
    console.log('AFTER');
  `);
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, JSON.stringify({ step: 1 }) + '\nAFTER\n');
});

// ---------------------------------------------------------------------------
// emitText
// ---------------------------------------------------------------------------

test('emitText: writes the string as-is and exits 0 by default', () => {
  const res = runNode(`
    const { emitText } = require(${JSON.stringify(OUTPUT_LIB)});
    emitText('hello world');
  `);
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, 'hello world\n');
});

test('emitText: does not double a trailing newline already present', () => {
  const res = runNode(`
    const { emitText } = require(${JSON.stringify(OUTPUT_LIB)});
    emitText('hello world\\n');
  `);
  assert.strictEqual(res.status, 0);
  assert.strictEqual(res.stdout, 'hello world\n');
});

test('emitText: honors a custom exit code', () => {
  const res = runNode(`
    const { emitText } = require(${JSON.stringify(OUTPUT_LIB)});
    emitText('boom', 2);
  `);
  assert.strictEqual(res.status, 2);
  assert.strictEqual(res.stdout, 'boom\n');
});
