'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseArgs,
  detectBlock,
  enrich,
  hasExistingContextKey,
  OPENSPEC_ENRICH_VERSION,
} = require('./openspec-enrich.js');

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs: defaults when no flags passed', () => {
  const result = parseArgs(['node', 'openspec-enrich.js']);
  assert.strictEqual(result.remove, false);
  assert.strictEqual(result.outputFile, false);
});

test('parseArgs: recognizes --remove and --output-file', () => {
  const result = parseArgs(['node', 'openspec-enrich.js', '--remove', '--output-file']);
  assert.strictEqual(result.remove, true);
  assert.strictEqual(result.outputFile, true);
});

test('parseArgs: --project-root takes the following value', () => {
  const result = parseArgs(['node', 'openspec-enrich.js', '--project-root', '/tmp/foo']);
  assert.strictEqual(result.projectRoot, '/tmp/foo');
});

// ---------------------------------------------------------------------------
// detectBlock
// ---------------------------------------------------------------------------

test('detectBlock: not found in plain content', () => {
  const result = detectBlock('context: |\n  hello\n');
  assert.strictEqual(result.found, false);
});

test('detectBlock: found with correct version', () => {
  const content = `foo\n# BEGIN MANAGED BY lift-sdlc (v2)\nbar\n# END MANAGED BY lift-sdlc (v2)\nbaz\n`;
  const result = detectBlock(content);
  assert.strictEqual(result.found, true);
  assert.strictEqual(result.version, 2);
});

test('detectBlock: begin without matching end is not found', () => {
  const content = `# BEGIN MANAGED BY lift-sdlc (v2)\nbar\n`;
  const result = detectBlock(content);
  assert.strictEqual(result.found, false);
});

// ---------------------------------------------------------------------------
// hasExistingContextKey
// ---------------------------------------------------------------------------

test('hasExistingContextKey: detects a top-level context: key', () => {
  assert.strictEqual(hasExistingContextKey('context: |\n  hi\n', { found: false }), true);
});

test('hasExistingContextKey: does not flag context: key inside the managed block', () => {
  const content = `# BEGIN MANAGED BY lift-sdlc (v2)\ncontext: |\n  hi\n# END MANAGED BY lift-sdlc (v2)\n`;
  const block = detectBlock(content);
  assert.strictEqual(hasExistingContextKey(content, block), false);
});

// ---------------------------------------------------------------------------
// enrich
// ---------------------------------------------------------------------------

function withTmpConfig(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-enrich-'));
  const configPath = path.join(dir, 'config.yaml');
  if (content !== null) fs.writeFileSync(configPath, content, 'utf8');
  try {
    return fn(configPath, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('enrich: missing file returns ok:false, action:missing', () => {
  withTmpConfig(null, (configPath) => {
    const result = enrich(configPath, {});
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.action, 'missing');
  });
});

test('enrich: appends the managed block when none exists', () => {
  withTmpConfig('name: my-project\n', (configPath) => {
    const result = enrich(configPath, {});
    assert.strictEqual(result.action, 'append');
    assert.strictEqual(result.changed, true);
    const written = fs.readFileSync(configPath, 'utf8');
    assert.match(written, /BEGIN MANAGED BY lift-sdlc/);
  });
});

test('enrich: skips append when a top-level context: key already exists', () => {
  withTmpConfig('context: |\n  existing\n', (configPath) => {
    const result = enrich(configPath, {});
    assert.strictEqual(result.action, 'skipped-existing-context');
    assert.strictEqual(result.changed, false);
  });
});

test('enrich: unchanged when block is already at current version', () => {
  const content = `# BEGIN MANAGED BY lift-sdlc (v${OPENSPEC_ENRICH_VERSION})\nold\n# END MANAGED BY lift-sdlc (v${OPENSPEC_ENRICH_VERSION})\n`;
  withTmpConfig(content, (configPath) => {
    const result = enrich(configPath, {});
    assert.strictEqual(result.action, 'unchanged');
    assert.strictEqual(result.changed, false);
  });
});

test('enrich: updates in place when block is at a lower version', () => {
  const content = `# BEGIN MANAGED BY lift-sdlc (v1)\nold content\n# END MANAGED BY lift-sdlc (v1)\n`;
  withTmpConfig(content, (configPath) => {
    const result = enrich(configPath, {});
    assert.strictEqual(result.action, 'update');
    assert.strictEqual(result.changed, true);
    const written = fs.readFileSync(configPath, 'utf8');
    assert.match(written, new RegExp(`BEGIN MANAGED BY lift-sdlc \\(v${OPENSPEC_ENRICH_VERSION}\\)`));
  });
});

test('enrich: no-op with warning when block is at a higher version than the plugin ships', () => {
  const content = `# BEGIN MANAGED BY lift-sdlc (v99)\nfuture\n# END MANAGED BY lift-sdlc (v99)\n`;
  withTmpConfig(content, (configPath) => {
    const result = enrich(configPath, {});
    assert.strictEqual(result.action, 'unchanged');
    assert.strictEqual(result.changed, false);
    assert.match(result.warning, /v99/);
  });
});

test('enrich --remove: removes an existing block', () => {
  const content = `keep\n# BEGIN MANAGED BY lift-sdlc (v${OPENSPEC_ENRICH_VERSION})\nold\n# END MANAGED BY lift-sdlc (v${OPENSPEC_ENRICH_VERSION})\n`;
  withTmpConfig(content, (configPath) => {
    const result = enrich(configPath, { remove: true });
    assert.strictEqual(result.action, 'removed');
    assert.strictEqual(result.changed, true);
    const written = fs.readFileSync(configPath, 'utf8');
    assert.doesNotMatch(written, /BEGIN MANAGED BY lift-sdlc/);
    assert.match(written, /keep/);
  });
});

test('enrich --remove: no-op when no block is present', () => {
  withTmpConfig('name: my-project\n', (configPath) => {
    const result = enrich(configPath, { remove: true });
    assert.strictEqual(result.action, 'removed');
    assert.strictEqual(result.changed, false);
  });
});
