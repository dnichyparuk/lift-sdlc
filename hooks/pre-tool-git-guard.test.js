'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.join(__dirname, 'pre-tool-git-guard.js');
const { initState } = require('../scripts/lib/state');
const { exec } = require('../scripts/lib/git');

function runHook(stdin, env) {
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: stdin,
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  });
  assert.strictEqual(result.status, 0, `hook should exit 0 (stderr: ${result.stderr})`);
  return JSON.parse(result.stdout.trim());
}

test('pre-tool-git-guard: malformed stdin denies with actionable fail-closed reason', () => {
  const output = runHook('{not valid json');
  assert.strictEqual(output.decision, 'deny');
  assert.strictEqual(
    output.reason,
    'pre-tool-git-guard.js: could not parse tool-call input as JSON (fail-closed). If this repeats for every command, the host is sending malformed payloads — inspect hooks.json or temporarily disable this hook.'
  );
});

test('pre-tool-git-guard: a valid safe command allows (Antigravity run_command/CommandLine payload)', () => {
  const input = JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'git status' } } });
  const output = runHook(input);
  assert.strictEqual(output.decision, 'allow');
});

test('pre-tool-git-guard: git push --force denies (Antigravity run_command/CommandLine payload)', () => {
  const input = JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'git push --force origin main' } } });
  const output = runHook(input);
  assert.strictEqual(output.decision, 'deny');
  assert.ok(output.reason && output.reason.length > 0);
});

test('pre-tool-git-guard: legacy args.command fallback still denies git push --force (fallback path, not primary)', () => {
  const input = JSON.stringify({ toolCall: { name: 'run_command', args: { command: 'git push --force origin main' } } });
  const output = runHook(input);
  assert.strictEqual(output.decision, 'deny');
  assert.ok(output.reason && output.reason.length > 0);
});

test('pre-tool-git-guard: git add -A without exclusions is denied', () => {
  const input = JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'git add -A' } } });
  const output = runHook(input);
  assert.strictEqual(output.decision, 'deny');
  assert.ok(output.reason.includes('git add -A may stage internal state files'));
});

test('pre-tool-git-guard: git add -A with exclusions is allowed', () => {
  const input = JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'git add -A -- ":!.sdlc/"' } } });
  const output = runHook(input);
  assert.strictEqual(output.decision, 'allow');
});

test('pre-tool-git-guard: force push to protected branch is denied', () => {
  const input = JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'git push origin main --force' } } });
  const output = runHook(input);
  assert.strictEqual(output.decision, 'deny');
  assert.ok(output.reason.includes('force push to protected branch') || output.reason.includes('git push --force'));
});

test('pre-tool-git-guard: git push --force-with-lease to a protected branch is allowed regardless of arg order', () => {
  const branchFirst = runHook(JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'git push origin main --force-with-lease' } } }));
  assert.strictEqual(branchFirst.decision, 'allow');

  const flagFirst = runHook(JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'git push --force-with-lease origin main' } } }));
  assert.strictEqual(flagFirst.decision, 'allow');
});

test('pre-tool-git-guard: git add -A bypass via unrelated ":!" substring is still denied', () => {
  const input = JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'git add -A && echo ":!"' } } });
  const output = runHook(input);
  assert.strictEqual(output.decision, 'deny');
  assert.ok(output.reason.includes('git add -A may stage internal state files'));
});

test('pre-tool-git-guard: Two-Dimensional Identity & Safe Branch Guard', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-guard-test-'));
  const prevOverride = process.env.SDLC_STATE_DIR_OVERRIDE;
  process.env.SDLC_STATE_DIR_OVERRIDE = tempDir;

  try {
    const realBranch = exec('git branch --show-current') || 'feature/test';

    // git merge is denied in auto mode while the pipeline is advancing,
    // regardless of branch identity.
    initState('ship', realBranch, {
      branch: realBranch,
      flags: { auto: true },
      steps: [{ name: 'execute', status: 'in_progress' }],
    });
    const mergeOutput = runHook(
      JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'git merge origin/main' } } }),
      { SDLC_STATE_DIR_OVERRIDE: tempDir, SDLC_BRANCH_OVERRIDE: realBranch }
    );
    assert.strictEqual(mergeOutput.decision, 'deny');
    assert.ok(mergeOutput.reason.includes('git merge in auto mode'));

    // A mutating command is denied when run on a branch that doesn't match
    // the active pipeline's expected branch.
    const expectedBranch = 'expected-branch-that-does-not-exist-in-this-checkout';
    initState('ship', realBranch, {
      branch: expectedBranch,
      flags: { auto: false },
      steps: [{ name: 'execute', status: 'in_progress' }],
    });
    const commitOutput = runHook(
      JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'git commit -m "wip"' } } }),
      { SDLC_STATE_DIR_OVERRIDE: tempDir, SDLC_BRANCH_OVERRIDE: realBranch }
    );
    assert.strictEqual(commitOutput.decision, 'deny');
    assert.ok(commitOutput.reason.includes(expectedBranch));
  } finally {
    if (prevOverride !== undefined) {
      process.env.SDLC_STATE_DIR_OVERRIDE = prevOverride;
    } else {
      delete process.env.SDLC_STATE_DIR_OVERRIDE;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

