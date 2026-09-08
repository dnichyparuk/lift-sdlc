'use strict';

const test   = require('node:test');
const assert = require('node:assert');
const path   = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseArgs, truncateOutput, runCommand, runTruncated } = require('./run-truncated');

const SCRIPT = path.join(__dirname, 'run-truncated.js');

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

function lines(n, prefix = 'line') {
  return Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join('\n');
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs takes the command as a positional argument', () => {
  const parsed = parseArgs(['node', '/x/run-truncated.js', 'npm test']);
  assert.strictEqual(parsed.command, 'npm test');
  assert.strictEqual(parsed.maxHead, 100);
  assert.strictEqual(parsed.maxTail, 400);
  assert.strictEqual(parsed.unknown, null);
});

test('parseArgs accepts the --command alias and the line-count flags', () => {
  const parsed = parseArgs([
    'node', '/x/run-truncated.js',
    '--command', 'npm run build',
    '--max-head', '5',
    '--max-tail', '7',
  ]);
  assert.strictEqual(parsed.command, 'npm run build');
  assert.strictEqual(parsed.maxHead, 5);
  assert.strictEqual(parsed.maxTail, 7);
});

test('parseArgs falls back to the defaults for non-numeric line counts', () => {
  const parsed = parseArgs(['node', '/x/run-truncated.js', 'x', '--max-head', 'abc']);
  assert.strictEqual(parsed.maxHead, 100);
});

test('parseArgs reports an unknown flag', () => {
  const parsed = parseArgs(['node', '/x/run-truncated.js', '--bogus']);
  assert.strictEqual(parsed.unknown, '--bogus');
});

test('parseArgs leaves the command empty when nothing is passed', () => {
  assert.strictEqual(parseArgs(['node', '/x/run-truncated.js']).command, '');
});

// ---------------------------------------------------------------------------
// truncateOutput — mirrors run_truncated.sh:15-27
// ---------------------------------------------------------------------------

test('truncateOutput passes output through untouched when it fits', () => {
  const out = truncateOutput('a\nb\nc\n', 2, 2);
  assert.strictEqual(out, 'a\nb\nc\n');
});

test('truncateOutput keeps exactly maxHead + maxTail lines untruncated', () => {
  const body = lines(4);
  assert.strictEqual(truncateOutput(`${body}\n`, 2, 2), `${body}\n`);
});

test('truncateOutput truncates the middle once over the limit', () => {
  const out = truncateOutput(`${lines(5)}\n`, 2, 2);
  assert.strictEqual(
    out,
    'line1\nline2\n\n...[TRUNCATED_LOGS: 1 lines removed]...\n\nline4\nline5\n'
  );
});

test('truncateOutput reports the correct removed-line count', () => {
  const out = truncateOutput(`${lines(1000)}\n`);
  assert.match(out, /\.\.\.\[TRUNCATED_LOGS: 500 lines removed\]\.\.\./);
  assert.ok(out.startsWith('line1\nline2\n'));
  assert.ok(out.endsWith('line1000\n'));
  // 100 head + blank + marker + blank + 400 tail = 503 lines.
  assert.strictEqual(out.replace(/\n$/, '').split('\n').length, 503);
});

test('truncateOutput strips trailing newlines like a shell $(...) capture', () => {
  assert.strictEqual(truncateOutput('a\nb\n\n\n', 100, 400), 'a\nb\n');
});

test('truncateOutput turns empty output into a single blank line, like echo ""', () => {
  assert.strictEqual(truncateOutput('', 100, 400), '\n');
});

// ---------------------------------------------------------------------------
// runCommand
// ---------------------------------------------------------------------------

test('runCommand captures stdout and returns exit code 0', () => {
  const res = runCommand(`"${process.execPath}" -e "console.log('hello')"`);
  assert.strictEqual(res.exitCode, 0);
  assert.strictEqual(res.output, 'hello\n');
});

test('runCommand captures stderr too (2>&1 equivalent)', () => {
  const res = runCommand(`"${process.execPath}" -e "console.error('boom')"`);
  assert.strictEqual(res.exitCode, 0);
  assert.strictEqual(res.output, 'boom\n');
});

test('runCommand propagates a non-zero exit code with its output', () => {
  const res = runCommand(
    `"${process.execPath}" -e "console.log('out');console.error('err');process.exit(3)"`
  );
  assert.strictEqual(res.exitCode, 3);
  assert.match(res.output, /out/);
  assert.match(res.output, /err/);
});

// ---------------------------------------------------------------------------
// runTruncated
// ---------------------------------------------------------------------------

test('runTruncated prints Usage and exits 1 with no command', () => {
  const res = runTruncated(['node', '/x/run-truncated.js']);
  assert.strictEqual(res.exitCode, 1);
  assert.strictEqual(res.stdout, 'Usage: /x/run-truncated.js <command>\n');
});

test('runTruncated rejects an unknown flag on stderr', () => {
  const res = runTruncated(['node', '/x/run-truncated.js', '--nope']);
  assert.strictEqual(res.exitCode, 1);
  assert.strictEqual(res.stdout, '');
  assert.match(res.stderr, /Unknown parameter passed: --nope/);
});

test('runTruncated truncates a long capture and keeps the command exit code', () => {
  const res = runTruncated(
    ['node', '/x/run-truncated.js', 'fake', '--max-head', '1', '--max-tail', '1'],
    { runCommandFn: () => ({ output: `${lines(10)}\n`, exitCode: 7 }) }
  );
  assert.strictEqual(res.exitCode, 7);
  assert.strictEqual(
    res.stdout,
    'line1\n\n...[TRUNCATED_LOGS: 8 lines removed]...\n\nline10\n'
  );
});

// ---------------------------------------------------------------------------
// End-to-end CLI
// ---------------------------------------------------------------------------

test('CLI echoes short command output verbatim and exits 0', () => {
  const res = run([`"${process.execPath}" -e "console.log('ok')"`]);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(res.stdout, 'ok\n');
});

test('CLI exits with the wrapped command exit code', () => {
  const res = run([`"${process.execPath}" -e "process.exit(4)"`]);
  assert.strictEqual(res.status, 4);
});

test('CLI truncates long output using --max-head/--max-tail', () => {
  const gen = `"${process.execPath}" -e "for(let i=1;i<=10;i++)console.log('L'+i)"`;
  const res = run([gen, '--max-head', '2', '--max-tail', '2']);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(
    res.stdout,
    'L1\nL2\n\n...[TRUNCATED_LOGS: 6 lines removed]...\n\nL9\nL10\n'
  );
});

test('CLI exits 1 and prints Usage with no arguments', () => {
  const res = run([]);
  assert.strictEqual(res.status, 1);
  assert.match(res.stdout, /^Usage: .*run-truncated\.js <command>\n$/);
});
