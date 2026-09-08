'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { PassThrough } = require('node:stream');

const { runValidateLinksCli, parseArgs, readStdin } = require('./validate-links-cli');

function fakeStream() {
  const chunks = [];
  return {
    write: (s) => { chunks.push(s); return true; },
    text: () => chunks.join(''),
  };
}

test('parseArgs: no args -> file null', () => {
  assert.deepStrictEqual(parseArgs(['node', 'x.js']), { file: null });
});

test('parseArgs: --file <path> is captured', () => {
  assert.deepStrictEqual(parseArgs(['node', 'x.js', '--file', '/tmp/body.txt']), { file: '/tmp/body.txt' });
});

test('parseArgs: unknown parameter throws', () => {
  assert.throws(() => parseArgs(['node', 'x.js', '--bogus']), /Unknown parameter: --bogus/);
});

test('runValidateLinksCli: success via --file prints OK to stdout, exit 0', async () => {
  const stdout = fakeStream();
  const stderr = fakeStream();
  const code = await runValidateLinksCli(['node', 'x.js', '--file', '/fake/body.txt'], {
    readFileSync: (p) => { assert.strictEqual(p, '/fake/body.txt'); return 'no urls here'; },
    validate: async (text, ctx) => {
      assert.strictEqual(text, 'no urls here');
      assert.deepStrictEqual(ctx, {}); // callers MUST NOT construct ctx JSON
      return { ok: true, violations: [], skipped: [] };
    },
    stdout,
    stderr,
  });
  assert.strictEqual(code, 0);
  assert.match(stdout.text(), /^OK: link verification passed\n$/);
  assert.strictEqual(stderr.text(), '');
});

test('runValidateLinksCli: success via stdin fallback notes skipped count', async () => {
  const stdout = fakeStream();
  const code = await runValidateLinksCli(['node', 'x.js'], {
    readInput: async () => 'body from stdin',
    validate: async () => ({ ok: true, violations: [], skipped: [{ url: 'https://x.com/a', line: 1, reason: 'skip-list' }] }),
    stdout,
    stderr: fakeStream(),
  });
  assert.strictEqual(code, 0);
  assert.match(stdout.text(), /OK: link verification passed \(1 skipped\)/);
});

test('runValidateLinksCli: violations print to stderr via format(), exit 1', async () => {
  const stderr = fakeStream();
  const violations = [{ url: 'http://bad', line: 3, reason: 'url-invalid' }];
  const code = await runValidateLinksCli(['node', 'x.js', '--file', '/fake/body.txt'], {
    readFileSync: () => 'text with http://bad url',
    validate: async () => ({ ok: false, violations, skipped: [] }),
    format: (v) => { assert.strictEqual(v, violations); return 'FORMATTED VIOLATIONS'; },
    stdout: fakeStream(),
    stderr,
  });
  assert.strictEqual(code, 1);
  assert.match(stderr.text(), /FORMATTED VIOLATIONS/);
});

test('runValidateLinksCli: unknown flag -> exit 2, usage error on stderr', async () => {
  const stderr = fakeStream();
  const code = await runValidateLinksCli(['node', 'x.js', '--bogus'], { stderr });
  assert.strictEqual(code, 2);
  assert.match(stderr.text(), /Unknown parameter: --bogus/);
});

test('runValidateLinksCli: unreadable --file -> exit 2', async () => {
  const stderr = fakeStream();
  const code = await runValidateLinksCli(['node', 'x.js', '--file', '/nope.txt'], {
    readFileSync: () => { throw new Error('ENOENT: no such file or directory'); },
    stderr,
  });
  assert.strictEqual(code, 2);
  assert.match(stderr.text(), /cannot read --file \/nope\.txt/);
});

test('runValidateLinksCli: stdin read failure -> exit 2', async () => {
  const stderr = fakeStream();
  const code = await runValidateLinksCli(['node', 'x.js'], {
    readInput: async () => { throw new Error('stream error'); },
    stderr,
  });
  assert.strictEqual(code, 2);
  assert.match(stderr.text(), /failed to read stdin/);
});

test('runValidateLinksCli: validate() throws -> caught, exit 2, error on stderr (never rejects)', async () => {
  const stderr = fakeStream();
  const code = await runValidateLinksCli(['node', 'x.js', '--file', '/fake/body.txt'], {
    readFileSync: () => 'body text',
    validate: async () => { throw new Error('boom: validator crashed'); },
    stdout: fakeStream(),
    stderr,
  });
  assert.strictEqual(code, 2);
  assert.match(stderr.text(), /validate-links-cli: validate\(\) crashed: .*boom: validator crashed/s);
});

test('runValidateLinksCli: end-to-end against the real links.js validator (no mocked validate)', async () => {
  // Exercises the real scripts/lib/links.js validateLinks() with a
  // structurally-invalid URL that fails the URL constructor before any
  // network branch is reached — no network access required.
  const stdout = fakeStream();
  const stderr = fakeStream();
  const code = await runValidateLinksCli(['node', 'x.js', '--file', '/fake/body.txt'], {
    readFileSync: () => 'see http://[::1 for details',
    stdout,
    stderr,
  });
  assert.strictEqual(code, 1);
  assert.match(stderr.text(), /url-invalid/);
});

test('readStdin: removes its data/end/error listeners from the stream on settle', async () => {
  const stream = new PassThrough();
  const promise = readStdin(stream);
  stream.end('hello world');
  const result = await promise;
  assert.strictEqual(result, 'hello world');
  assert.strictEqual(stream.listenerCount('data'), 0);
  assert.strictEqual(stream.listenerCount('end'), 0);
  assert.strictEqual(stream.listenerCount('error'), 0);
});
