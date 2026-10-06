'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.join(__dirname, 'pre-tool-validate.js');

function runHook(stdin, env) {
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: stdin,
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  });
  assert.strictEqual(result.status, 0, `hook should exit 0 (stderr: ${result.stderr})`);
  return JSON.parse(result.stdout.trim());
}

test('pre-tool-validate: malformed stdin denies with actionable fail-closed reason', () => {
  const output = runHook('{not valid json');
  assert.strictEqual(output.decision, 'deny');
  assert.strictEqual(
    output.reason,
    'pre-tool-validate.js: could not parse tool-call input as JSON (fail-closed). If this repeats for every command, the host is sending malformed payloads — inspect hooks.json or temporarily disable this hook.'
  );
});

test('pre-tool-validate: a valid safe command (no target file) allows', () => {
  const input = JSON.stringify({ toolCall: { args: { command: 'ls -la' } } });
  const output = runHook(input);
  assert.strictEqual(output.decision, 'allow');
});

test('pre-tool-validate: a write_to_file to an unrelated file allows (Antigravity write_to_file/TargetFile+CodeContent payload)', () => {
  const input = JSON.stringify({
    toolCall: {
      name: 'write_to_file',
      args: { TargetFile: '/tmp/some-unrelated-file.js', CodeContent: 'console.log(1);' },
    },
  });
  const output = runHook(input);
  assert.strictEqual(output.decision, 'allow');
});

test('pre-tool-validate: a replace_file_content edit allows (Antigravity replace_file_content/TargetFile+CodeContent payload)', () => {
  const input = JSON.stringify({
    toolCall: {
      name: 'replace_file_content',
      args: { TargetFile: '/tmp/some-unrelated-file.js', CodeContent: 'console.log(2);' },
    },
  });
  const output = runHook(input);
  assert.strictEqual(output.decision, 'allow');
});

/** A plan in the canonical format whose single task has the given acceptance-criteria lines. */
function planWith(...criteria) {
  return [
    '# Demo Implementation Plan',
    '',
    '**Goal:** Demo.',
    '**Architecture:** Demo.',
    '**Source:** conversation context',
    '**Verification:** npm test',
    '',
    '---',
    '',
    '### Task 1: Step',
    '',
    '**Complexity:** Trivial',
    '**Risk:** Low',
    '**Depends on:** none',
    '**Verify:** tests',
    '',
    '**Description:**',
    'Do the step.',
    '',
    '**Acceptance criteria:**',
    ...criteria,
    '',
  ].join('\n');
}

function planWriteInput(targetFile, content) {
  return JSON.stringify({ toolCall: { name: 'write_to_file', args: { TargetFile: targetFile, CodeContent: content } } });
}

/** Runs the hook with a private TMPDIR and returns the output plus what is left in that TMPDIR. */
function runPlanHook(targetFile, content) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-test-'));
  try {
    const output = runHook(planWriteInput(targetFile, content), { TMPDIR: tmp, TMP: tmp, TEMP: tmp });
    return { output, leftovers: fs.readdirSync(tmp) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('pre-tool-validate: a valid plan write allows and leaves no temporary files', () => {
  const { output, leftovers } = runPlanHook('/proj/plans/demo.md', planWith('- [ ] a'));
  assert.strictEqual(output.decision, 'allow');
  assert.deepStrictEqual(leftovers, []);
});

test('pre-tool-validate: a denied plan write names the real target path, not the temporary one, and leaves no temporary files', () => {
  const target = '/proj/plans/demo.md';
  const content = planWith('- [ ] a', '- [~] skipped without a comment');
  const { output, leftovers } = runPlanHook(target, content);
  assert.strictEqual(output.decision, 'deny');
  const line = content.split('\n').findIndex((l) => l.startsWith('- [~]')) + 1;
  assert.ok(output.reason.includes(`${target}:${line}:`), `reason should cite ${target}:${line}, got:\n${output.reason}`);
  assert.ok(!output.reason.includes('validate-'), `reason must not expose the temporary path, got:\n${output.reason}`);
  assert.deepStrictEqual(leftovers, [], 'the temporary directory must be removed after a denial');
});

test('pre-tool-validate: a denied plan write still denies when the plan has a skipped box with a valid comment but another task fails', () => {
  const content = planWith('- [~] skipped', '  *Skipped on 2026-10-06: the next task covers it and the branch is merged.*');
  const { output, leftovers } = runPlanHook('/proj/plans/demo.md', content);
  // PF5 fails (no open box) but PF6 passes: the denial must come from PF5 and not mention the temporary path.
  assert.strictEqual(output.decision, 'deny');
  assert.ok(!output.reason.includes('validate-'));
  assert.deepStrictEqual(leftovers, []);
});

test('pre-tool-validate: a dimension file write still allows without leaving temporary files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-test-'));
  try {
    const output = runHook(
      planWriteInput('/proj/.sdlc/review-dimensions/security.yaml', 'name: security\n'),
      { TMPDIR: tmp, TMP: tmp, TEMP: tmp },
    );
    assert.strictEqual(output.decision, 'allow');
    assert.deepStrictEqual(fs.readdirSync(tmp), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
