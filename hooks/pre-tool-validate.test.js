'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK_PATH = path.join(__dirname, 'pre-tool-validate.js');

function runHook(stdin) {
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: stdin,
    encoding: 'utf8',
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
