'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.join(__dirname, 'pre-tool-git-guard.js');

function runHook(stdin) {
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: stdin,
    encoding: 'utf8',
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
