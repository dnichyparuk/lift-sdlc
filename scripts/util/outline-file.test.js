'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgs, outlineLines, main, OUTLINE_RE, MAX_MATCHES } = require('./outline-file');

function withTempFile(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outline-file-test-'));
  const filePath = path.join(dir, 'sample.ts');
  fs.writeFileSync(filePath, content);
  try {
    return fn(filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(s); return true; };
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join('');
}

function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write;
  process.stderr.write = (s) => { chunks.push(s); return true; };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return chunks.join('');
}

test('parseArgs reads the positional file path', () => {
  assert.deepStrictEqual(parseArgs(['node', 'outline-file.js', '/some/file.ts']), { filePath: '/some/file.ts' });
  assert.deepStrictEqual(parseArgs(['node', 'outline-file.js']), { filePath: null });
});

test('OUTLINE_RE matches the same keywords as the original grep -E alternation', () => {
  const keywords = ['export', 'import', 'class', 'def', 'function', 'struct', 'interface', 'type', 'enum', 'const', 'let', 'var'];
  for (const kw of keywords) {
    assert.ok(OUTLINE_RE.test(`${kw} foo`), `expected match for bare "${kw} foo"`);
    assert.ok(OUTLINE_RE.test(`  \t${kw} foo`), `expected match for indented "${kw} foo"`);
  }
  assert.ok(!OUTLINE_RE.test('  const'), 'keyword with no trailing whitespace+content should not match');
  assert.ok(!OUTLINE_RE.test('  // const x = 1'), 'comment line should not match');
  assert.ok(!OUTLINE_RE.test('someVarConst foo'), 'keyword must be a whole leading token, not a substring');
});

test('outlineLines returns 1-indexed "line:content" matches in file order (success path)', () => {
  const content = [
    'import { x } from "y";',
    '',
    '// a comment',
    'export function foo() {',
    '  const bar = 1;',
    '}',
  ].join('\n');
  const matches = outlineLines(content);
  assert.deepStrictEqual(matches, [
    '1:import { x } from "y";',
    '4:export function foo() {',
    '5:  const bar = 1;',
  ]);
});

test('outlineLines caps output at MAX_MATCHES (300) matched lines', () => {
  const lines = [];
  for (let i = 0; i < 500; i++) lines.push(`const v${i} = ${i};`);
  const matches = outlineLines(lines.join('\n'));
  assert.strictEqual(matches.length, MAX_MATCHES);
  assert.strictEqual(matches[0], '1:const v0 = 0;');
  assert.strictEqual(matches[MAX_MATCHES - 1], `${MAX_MATCHES}:const v${MAX_MATCHES - 1} = ${MAX_MATCHES - 1};`);
});

test('main() success path: prints the OUTLINE header then matched lines, exit 0', () => {
  withTempFile('const a = 1;\nlet b = 2;\n', (filePath) => {
    let code;
    const out = captureStdout(() => { code = main(['node', 'outline-file.js', filePath]); });
    assert.strictEqual(code, 0);
    assert.ok(out.startsWith(`--- OUTLINE FOR ${filePath} ---\n`));
    assert.ok(out.includes('1:const a = 1;'));
    assert.ok(out.includes('2:let b = 2;'));
  });
});

test('main() error path: missing file_path argument returns exit 1 and usage on stderr', () => {
  let code;
  const err = captureStderr(() => { code = main(['node', 'outline-file.js']); });
  assert.strictEqual(code, 1);
  assert.match(err, /Usage: outline-file\.js <file_path>/);
});

test('main() error path: nonexistent file returns exit 1 and error on stderr', () => {
  let code;
  const missing = path.join(os.tmpdir(), `does-not-exist-${Date.now()}.ts`);
  const err = captureStderr(() => { code = main(['node', 'outline-file.js', missing]); });
  assert.strictEqual(code, 1);
  assert.match(err, /Error: File not found/);
});
