'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const {
  parseArgs,
  extractFrontmatter,
  readToolsValue,
  checkToolBoundary,
  runAgyValidate,
  evaluate,
  REQUIRED_TOOLS_VALUE,
  AGENTS_TO_CHECK,
  SKIP_NOTE,
  REPO_ROOT,
} = require('./validate-plugin-schema');

const SCRIPT = path.join(__dirname, 'validate-plugin-schema.js');

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

const GOOD_AGENT_MD = `---
name: learn-synthesis-orchestrator
description: test fixture
subagent: true
tools: view_file
model: gemini-3.8-flash-low
---

# Body
`;

/** Build a throwaway plugin-dir tree with both read-only agent files. */
function makePluginDir({ synthesisTools = 'view_file', reviewTools = 'view_file', omitReview = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-schema-'));
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'agents', 'learn-synthesis-orchestrator.md'),
    GOOD_AGENT_MD.replace('tools: view_file', `tools: ${synthesisTools}`)
  );
  if (!omitReview) {
    fs.writeFileSync(
      path.join(dir, 'agents', 'learn-review-only.md'),
      GOOD_AGENT_MD.replace('name: learn-synthesis-orchestrator', 'name: learn-review-only').replace(
        'tools: view_file',
        `tools: ${reviewTools}`
      )
    );
  }
  return dir;
}

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs defaults --plugin-dir to REPO_ROOT', () => {
  const parsed = parseArgs([]);
  assert.equal(parsed.pluginDir, REPO_ROOT);
});

test('parseArgs reads --plugin-dir', () => {
  const parsed = parseArgs(['--plugin-dir', '/tmp/some-plugin']);
  assert.equal(parsed.pluginDir, '/tmp/some-plugin');
});

// ---------------------------------------------------------------------------
// extractFrontmatter / readToolsValue
// ---------------------------------------------------------------------------

test('extractFrontmatter pulls the block between the first two --- lines', () => {
  const fm = extractFrontmatter(GOOD_AGENT_MD);
  assert.match(fm, /tools: view_file/);
  assert.doesNotMatch(fm, /# Body/);
});

test('extractFrontmatter returns null when there is no frontmatter block', () => {
  assert.equal(extractFrontmatter('# just a heading\n'), null);
});

test('readToolsValue reads the exact tools: value', () => {
  assert.equal(readToolsValue(GOOD_AGENT_MD), 'view_file');
});

test('readToolsValue returns null when frontmatter has no tools: line', () => {
  const noTools = GOOD_AGENT_MD.replace('tools: view_file\n', '');
  assert.equal(readToolsValue(noTools), null);
});

test('readToolsValue does not match a tools: mention in the body, only in frontmatter', () => {
  const text = `---
name: x
---

tools: Read, Write, Bash
`;
  assert.equal(readToolsValue(text), null);
});

// ---------------------------------------------------------------------------
// checkToolBoundary — the allowlist assertion (R18)
// ---------------------------------------------------------------------------

test('checkToolBoundary AGENTS_TO_CHECK names exactly the two read-only agents', () => {
  assert.deepEqual(AGENTS_TO_CHECK, [
    'agents/learn-synthesis-orchestrator.md',
    'agents/learn-review-only.md',
  ]);
  assert.equal(REQUIRED_TOOLS_VALUE, 'view_file');
});

test('checkToolBoundary passes when both agents declare exactly tools: view_file', () => {
  const dir = makePluginDir();
  assert.deepEqual(checkToolBoundary(dir), []);
});

test('checkToolBoundary fails on a superset (an additional read-only tool is still a violation)', () => {
  const dir = makePluginDir({ synthesisTools: 'view_file, grep_search' });
  const violations = checkToolBoundary(dir);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].file, 'agents/learn-synthesis-orchestrator.md');
  assert.match(violations[0].reason, /expected exactly "view_file"/);
});

test('checkToolBoundary fails when a write-capable tool is granted', () => {
  const dir = makePluginDir({ reviewTools: 'view_file, replace_file_content' });
  const violations = checkToolBoundary(dir);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].file, 'agents/learn-review-only.md');
});

test('checkToolBoundary fails when a required agent file is missing', () => {
  const dir = makePluginDir({ omitReview: true });
  const violations = checkToolBoundary(dir);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].file, 'agents/learn-review-only.md');
  assert.match(violations[0].reason, /cannot read file/);
});

test('checkToolBoundary reports both agents independently when both are wrong', () => {
  const dir = makePluginDir({ synthesisTools: 'Read', reviewTools: 'Read, Write' });
  const violations = checkToolBoundary(dir);
  assert.equal(violations.length, 2);
});

test('checkToolBoundary passes against the real repo agent files', () => {
  assert.deepEqual(checkToolBoundary(REPO_ROOT), []);
});

// ---------------------------------------------------------------------------
// runAgyValidate — spawnSync argv-array wrapper
// ---------------------------------------------------------------------------

test('runAgyValidate invokes agy plugin validate <dir> as an argv array (no shell string)', () => {
  let captured = null;
  const spawnFn = (cmd, args, opts) => {
    captured = { cmd, args, opts };
    return { status: 0, stdout: 'ok', stderr: '' };
  };
  runAgyValidate(spawnFn, '/some/plugin/dir');
  assert.equal(captured.cmd, 'agy');
  assert.deepEqual(captured.args, ['plugin', 'validate', '/some/plugin/dir']);
});

test('runAgyValidate detects ENOENT as "not installed"', () => {
  const spawnFn = () => ({
    error: Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' }),
    status: null,
    stdout: null,
    stderr: null,
  });
  const result = runAgyValidate(spawnFn, '/some/dir');
  assert.deepEqual(result, { installed: false });
});

test('runAgyValidate surfaces stdout/stderr and status when agy runs', () => {
  const spawnFn = () => ({ status: 0, stdout: '✔ agents : 9 processed\n', stderr: '' });
  const result = runAgyValidate(spawnFn, '/some/dir');
  assert.equal(result.installed, true);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /agents : 9 processed/);
});

// ---------------------------------------------------------------------------
// evaluate — orchestration, exit-code matrix (R21, agy-error branch via stub)
// ---------------------------------------------------------------------------

test('evaluate: agy pass + no tool violations -> exit 0, agy output surfaced', () => {
  const { exitCode, stdout, stderr } = evaluate({
    toolViolations: [],
    agyResult: { installed: true, status: 0, stdout: '✔ agents : 9 processed\n', stderr: '' },
  });
  assert.equal(exitCode, 0);
  assert.ok(stdout.some((l) => l.includes('agents : 9 processed')));
  assert.deepEqual(stderr, []);
});

test('evaluate: agy reports a schema error (stubbed) -> exit 1', () => {
  const { exitCode, stderr } = evaluate({
    toolViolations: [],
    agyResult: { installed: true, status: 1, stdout: '', stderr: '[error] bad frontmatter\n' },
  });
  assert.equal(exitCode, 1);
  assert.ok(stderr.some((l) => l.includes('schema error')));
  assert.ok(stderr.some((l) => l.includes('bad frontmatter')));
});

test('evaluate: tool-boundary violation alone -> exit 1 even when agy passes', () => {
  const { exitCode, stderr } = evaluate({
    toolViolations: [{ file: 'agents/learn-review-only.md', reason: 'tools: value is "Read", expected exactly "view_file"' }],
    agyResult: { installed: true, status: 0, stdout: '', stderr: '' },
  });
  assert.equal(exitCode, 1);
  assert.ok(stderr.some((l) => l.startsWith('tools-boundary: agents/learn-review-only.md')));
});

test('evaluate: agy not installed + no tool violations -> exit 0 with a clear skip note', () => {
  const { exitCode, stderr } = evaluate({
    toolViolations: [],
    agyResult: { installed: false },
  });
  assert.equal(exitCode, 0);
  assert.ok(stderr.includes(SKIP_NOTE));
});

test('evaluate: agy not installed BUT tool-boundary still fails -> exit 1 (assertion still runs)', () => {
  const { exitCode, stderr } = evaluate({
    toolViolations: [{ file: 'agents/learn-review-only.md', reason: 'no tools: line found in frontmatter' }],
    agyResult: { installed: false },
  });
  assert.equal(exitCode, 1);
  assert.ok(stderr.includes(SKIP_NOTE));
  assert.ok(stderr.some((l) => l.startsWith('tools-boundary:')));
});

test('evaluate: both agy failure and tool-boundary failure -> exit 1, both surfaced', () => {
  const { exitCode, stderr } = evaluate({
    toolViolations: [{ file: 'agents/learn-synthesis-orchestrator.md', reason: 'tools: value is "Read", expected exactly "view_file"' }],
    agyResult: { installed: true, status: 1, stdout: '', stderr: '[error] bad tools field\n' },
  });
  assert.equal(exitCode, 1);
  assert.ok(stderr.some((l) => l.startsWith('tools-boundary:')));
  assert.ok(stderr.some((l) => l.includes('schema error')));
});

// ---------------------------------------------------------------------------
// CLI end-to-end (real process, real repo — exercises the happy path only;
// the schema-error branch is covered above via injected spawnFn, since the
// real agy binary exits 0 on every input this repo could construct)
// ---------------------------------------------------------------------------

test('CLI: running against this repo exits 0 (or 1 only via a real agy schema finding) and prints something', () => {
  const result = run([]);
  assert.ok(result.status === 0 || result.status === 1);
  assert.ok((result.stdout + result.stderr).length > 0);
});

test('CLI: --plugin-dir with a fixture that has correct tools: values and no agy involvement issue does not crash', () => {
  const dir = makePluginDir();
  const result = run(['--plugin-dir', dir]);
  assert.notEqual(result.status, 2);
});

test('CLI: --plugin-dir with a bad tools: value exits 1', () => {
  const dir = makePluginDir({ synthesisTools: 'Read, Write' });
  const result = run(['--plugin-dir', dir]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tools-boundary: agents\/learn-synthesis-orchestrator\.md/);
});
