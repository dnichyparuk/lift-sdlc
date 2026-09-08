'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const {
  parseArgs,
  listMarkdownFiles,
  extractInvocations,
  extractFlags,
  sliceArgText,
  sourceParsesFlag,
  isPassthroughWrapper,
  isInsideOpenCapture,
  shortCircuitFlags,
  checkInvocation,
  scanReferences,
  REPO_ROOT,
} = require('./validate-skill-script-refs');

const SCRIPT = path.join(__dirname, 'validate-skill-script-refs.js');

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
}

/** Build a throwaway repo tree: { 'scripts/util/a.js': '…', 'skills/x/SKILL.md': '…' }. */
function makeTree(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-script-refs-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

/** Minimal invocation descriptor for unit-testing checkInvocation directly. */
function inv(over = {}) {
  return {
    file: 'skills/demo/SKILL.md',
    line: 1,
    scriptPath: 'util/demo.js',
    isCommand: true,
    captured: false,
    flags: [],
    raw: '<PLUGIN_ROOT>/scripts/util/demo.js',
    context: '',
    ...over,
  };
}

const WRITE_OUTPUT_SRC = `
const { writeOutput } = require('../lib/output');
function main() {
  writeOutput({ ok: true }, 'demo', 0);
}
`;

const JSON_LINE_SRC = `
const { writeJsonLine } = require('../lib/output');
function main() {
  writeJsonLine({ ok: true });
}
`;

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

test('parseArgs defaults to this repo root and non-JSON output', () => {
  const parsed = parseArgs([]);
  assert.strictEqual(parsed.root, REPO_ROOT);
  assert.strictEqual(parsed.json, false);
});

test('parseArgs reads --root and --json', () => {
  const parsed = parseArgs(['--root', '/tmp/foo', '--json']);
  assert.strictEqual(parsed.root, '/tmp/foo');
  assert.strictEqual(parsed.json, true);
});

// ---------------------------------------------------------------------------
// Argument slicing / flag extraction
// ---------------------------------------------------------------------------

test('sliceArgText stops at the unbalanced ) that closes a capture', () => {
  assert.strictEqual(sliceArgText('" --a --b) trailing prose'), '" --a --b');
});

test('sliceArgText keeps flags that follow an inline $( … ) substitution', () => {
  assert.strictEqual(sliceArgText('" --a "$(date)" --b'), '" --a "$(date)" --b');
});

test('extractFlags ignores <placeholder> spans', () => {
  assert.deepStrictEqual(extractFlags('--dimensions <name,...> --base <branch>'), [
    '--dimensions',
    '--base',
  ]);
});

test('extractFlags de-duplicates repeated flags', () => {
  assert.deepStrictEqual(extractFlags('--label a --label b'), ['--label']);
});

// ---------------------------------------------------------------------------
// Capture detection
// ---------------------------------------------------------------------------

test('isInsideOpenCapture recognises VAR=$(node, including through a pipeline', () => {
  assert.strictEqual(isInsideOpenCapture('VAR=$('), true);
  assert.strictEqual(isInsideOpenCapture('SAVE=$(echo x | '), true);
  assert.strictEqual(isInsideOpenCapture('  - Invoke `VAR=$('), true);
});

test('isInsideOpenCapture rejects bare and already-closed invocations', () => {
  assert.strictEqual(isInsideOpenCapture(''), false);
  assert.strictEqual(isInsideOpenCapture('A=$(date) && '), false);
  assert.strictEqual(isInsideOpenCapture('echo $(foo) | '), false);
});

// ---------------------------------------------------------------------------
// Flag-parsing idioms
// ---------------------------------------------------------------------------

test('sourceParsesFlag accepts a literal comparison', () => {
  assert.strictEqual(sourceParsesFlag("if (a === '--base') {}", '--base'), true);
  assert.strictEqual(sourceParsesFlag("if (a === '--base') {}", '--nope'), false);
});

test('sourceParsesFlag accepts flags assembled from a bare name', () => {
  const src = "const idx = argv.indexOf(`--${name}`); getArg('r-path');";
  assert.strictEqual(sourceParsesFlag(src, '--r-path'), true);
  assert.strictEqual(sourceParsesFlag(src, '--not-there'), false);
});

test('sourceParsesFlag treats --output-file as the manifest protocol selector', () => {
  assert.strictEqual(sourceParsesFlag(WRITE_OUTPUT_SRC, '--output-file'), true);
  // …but only for writeOutput-backed scripts.
  assert.strictEqual(sourceParsesFlag(JSON_LINE_SRC, '--output-file'), false);
});

test('isPassthroughWrapper detects an argv tail spread in the SAME function body', () => {
  const src = `
function main(argv) {
  const forwardArgs = argv.slice(2);
  spawnSync('gh', ['pr', 'create', ...forwardArgs]);
}
`;
  assert.strictEqual(isPassthroughWrapper(src), true);
  assert.strictEqual(isPassthroughWrapper("const args = argv.slice(2); if (args[0] === '--x') {}"), false);
});

test('isPassthroughWrapper follows a returned binding destructured by name into its caller', () => {
  // Mirrors the real shape used by util/verify-pipeline.js, util/await-review.js,
  // util/create-pr.js and util/plan-mode-check.js.
  const src = `
function parseArgs(argv) { return { forwardArgs: argv.slice(2) }; }
function run(argv) {
  const { forwardArgs } = parseArgs(argv);
  spawnSync('gh', ['pr', 'create', ...forwardArgs]);
}
`;
  assert.strictEqual(isPassthroughWrapper(src), true);
});

test('isPassthroughWrapper does not follow the destructuring bridge for an unrelated call', () => {
  // The caller destructures `forwardArgs` from a DIFFERENT function than the
  // one that binds it from argv — no bridge, no match.
  const src = `
function parseArgs(argv) { return { forwardArgs: argv.slice(2) }; }
function other() { return { forwardArgs: ['unrelated'] }; }
function run() {
  const { forwardArgs } = other();
  spawnSync('gh', ['pr', 'create', ...forwardArgs]);
}
`;
  assert.strictEqual(isPassthroughWrapper(src), false);
});

test('isPassthroughWrapper rejects a same-named binding shadowed in an unrelated scope', () => {
  // The plan.js false positive this scope-aware check exists to fix:
  // plan.js:58 binds `args` from argv.slice(2) inside parseArgs, but the
  // `...args` spread inside runExplorePack's spawnSync call is an UNRELATED
  // local `const args = ['--output-file']` — a file-wide scan cannot tell
  // these apart; a scope-aware one must.
  const src = `
function parseArgs(argv) {
  const args = argv.slice(2);
  return { args };
}
function runExplorePack() {
  const args = ['--output-file'];
  spawnSync(process.execPath, [exploreScript, ...args], {});
}
`;
  assert.strictEqual(isPassthroughWrapper(src), false);
});

test('isPassthroughWrapper does not match a spread whose name only shares a prefix', () => {
  const src = `
function main(argv) {
  const args = argv.slice(2);
  const argsExtra = ['other'];
  spawnSync('gh', ['pr', ...argsExtra]);
}
`;
  assert.strictEqual(isPassthroughWrapper(src), false);
});

test('isPassthroughWrapper rejects a property spread off the binding, not the binding itself', () => {
  // `...args.warnings` spreads a PROPERTY of args, not args itself.
  const src = `
function main(argv) {
  const args = argv.slice(2);
  spawnSync('gh', ['pr', ...args.warnings]);
}
`;
  assert.strictEqual(isPassthroughWrapper(src), false);
});

test('isPassthroughWrapper rejects a spread inside a non-spawn array literal', () => {
  const src = `
function main(argv) {
  const args = argv.slice(2);
  const other = ['x', ...args];
  console.log(other);
}
`;
  assert.strictEqual(isPassthroughWrapper(src), false);
});

test('isPassthroughWrapper returns false for the real plan.js and version.js sources', () => {
  const planSrc = fs.readFileSync(path.join(REPO_ROOT, 'scripts/skill/plan.js'), 'utf8');
  const versionSrc = fs.readFileSync(path.join(REPO_ROOT, 'scripts/skill/version.js'), 'utf8');
  assert.strictEqual(isPassthroughWrapper(planSrc), false);
  assert.strictEqual(isPassthroughWrapper(versionSrc), false);
});

// ---------------------------------------------------------------------------
// Short-circuit mode detection
// ---------------------------------------------------------------------------

test('shortCircuitFlags finds a mode handler that exits without writeOutput', () => {
  const src = `
const { writeOutput } = require('../lib/output');
function runMarkMode(name) {
  process.stderr.write('[demo] --mark written\\n');
  process.exit(0);
}
function main() { writeOutput({}, 'demo', 0); }
`;
  assert.deepStrictEqual([...shortCircuitFlags(src)], ['--mark']);
});

test('shortCircuitFlags ignores handlers that themselves call writeOutput', () => {
  const src = `
const { writeOutput } = require('../lib/output');
function runLoadMode() { writeOutput({}, 'demo', 0); }
'--load';
`;
  assert.deepStrictEqual([...shortCircuitFlags(src)], []);
});

// ---------------------------------------------------------------------------
// checkInvocation — synthetic inputs
// ---------------------------------------------------------------------------

test('checkInvocation reports missing-script when the target does not exist', () => {
  const out = checkInvocation(inv(), null);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'missing-script');
  assert.strictEqual(out[0].severity, 'error');
  assert.match(out[0].detail, /scripts\/util\/demo\.js does not exist/);
});

test('checkInvocation reports unknown-flag for a flag the script never parses', () => {
  const src = "if (a === '--known') {}";
  const out = checkInvocation(inv({ flags: ['--known', '--bogus'] }), src);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'unknown-flag');
  assert.match(out[0].detail, /does not parse --bogus/);
});

test('checkInvocation skips the flag check for a passthrough wrapper', () => {
  const src = `
function parseArgs(argv) { return { forwardArgs: argv.slice(2) }; }
function run(argv) {
  const { forwardArgs } = parseArgs(argv);
  spawnSync('gh', ['pr', 'create', ...forwardArgs]);
}
`;
  const out = checkInvocation(inv({ flags: ['--title', '--body'] }), src);
  assert.deepStrictEqual(out, []);
});

test('checkInvocation reports uncaptured-writeoutput for a bare node call', () => {
  const out = checkInvocation(inv(), WRITE_OUTPUT_SRC);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'uncaptured-writeoutput');
  assert.strictEqual(out[0].severity, 'error');
  assert.match(out[0].detail, /prints a path, not JSON/);
});

test('checkInvocation accepts a captured writeOutput invocation', () => {
  assert.deepStrictEqual(checkInvocation(inv({ captured: true }), WRITE_OUTPUT_SRC), []);
});

test('checkInvocation does not require capture for a short-circuit mode flag', () => {
  const src = `
const { writeOutput } = require('../lib/output');
function parseArgs(a) { if (a === '--mark') return true; }
function runMarkMode(name) {
  process.stderr.write('[demo] --mark\\n');
  process.exit(0);
}
function main() { writeOutput({}, 'demo', 0); }
`;
  assert.deepStrictEqual(checkInvocation(inv({ flags: ['--mark'] }), src), []);
});

test('checkInvocation does not require capture for a prose mention', () => {
  assert.deepStrictEqual(checkInvocation(inv({ isCommand: false }), WRITE_OUTPUT_SRC), []);
});

test('checkInvocation warns when prose claims a writeJsonLine script prints a path', () => {
  const out = checkInvocation(
    inv({ context: 'Run it — the script prints the path of a temp JSON file.' }),
    JSON_LINE_SRC
  );
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].kind, 'path-claim-on-jsonline');
  assert.strictEqual(out[0].severity, 'warning');
});

test('checkInvocation does not warn when the prose describes JSON on stdout', () => {
  const out = checkInvocation(
    inv({ context: 'Parse the single JSON line on stdout.' }),
    JSON_LINE_SRC
  );
  assert.deepStrictEqual(out, []);
});

test('checkInvocation uses the delegate closure for flags but the OWN source for the protocol', () => {
  const own = "runValidateLinksCli(process.argv);";
  const closure = own + "\nif (a === '--file') {}";
  assert.deepStrictEqual(checkInvocation(inv({ flags: ['--file'] }), own, closure), []);
});

// ---------------------------------------------------------------------------
// extractInvocations — known false positives stay out
// ---------------------------------------------------------------------------

test('extractInvocations excludes .github/scripts/*.cjs target-project paths', () => {
  const md = 'Adds `.github/scripts/retag-release.cjs` to the consuming project.';
  assert.deepStrictEqual(extractInvocations(md, 'skills/x/SKILL.md'), []);
});

test('extractInvocations excludes <placeholder> path segments', () => {
  const md = 'Pattern: `<PLUGIN_ROOT>/scripts/<group>/<script-name>.js`.';
  assert.deepStrictEqual(extractInvocations(md, 'skills/x/SKILL.md'), []);
});

test('extractInvocations classifies node invocations, captures and flags', () => {
  const md = [
    '```shell',
    'OUT=$(node "<PLUGIN_ROOT>/scripts/util/demo.js" --alpha)',
    'node "<PLUGIN_ROOT>/scripts/util/demo.js" --beta',
    '```',
    'Prose mention of `scripts/util/demo.js`.',
  ].join('\n');

  const found = extractInvocations(md, 'skills/x/SKILL.md');
  assert.strictEqual(found.length, 3);

  assert.deepStrictEqual(
    found.map((f) => [f.line, f.isCommand, f.captured, f.flags]),
    [
      [2, true, true, ['--alpha']],
      [3, true, false, ['--beta']],
      [5, false, false, []],
    ]
  );
  assert.ok(found.every((f) => f.scriptPath === 'util/demo.js'));
});

// ---------------------------------------------------------------------------
// listMarkdownFiles
// ---------------------------------------------------------------------------

test('listMarkdownFiles walks skills/** recursively and agents/*.md', () => {
  const dir = makeTree({
    'skills/a/SKILL.md': 'x',
    'skills/a/resources/deep.md': 'x',
    'skills/a/notes.txt': 'x',
    'agents/one.md': 'x',
    'agents/nested/two.md': 'x',
  });
  const files = listMarkdownFiles(dir);
  assert.deepStrictEqual(files, [
    'skills/a/SKILL.md',
    'skills/a/resources/deep.md',
    'agents/one.md',
  ]);
});

// ---------------------------------------------------------------------------
// scanReferences + CLI on a synthetic tree
// ---------------------------------------------------------------------------

test('scanReferences finds violations in a synthetic tree', () => {
  const dir = makeTree({
    'scripts/util/demo.js': WRITE_OUTPUT_SRC + "\nif (a === '--alpha') {}\n",
    'skills/a/SKILL.md': [
      '```shell',
      'node "<PLUGIN_ROOT>/scripts/util/demo.js" --alpha',
      'node "<PLUGIN_ROOT>/scripts/util/gone.js"',
      'OUT=$(node "<PLUGIN_ROOT>/scripts/util/demo.js" --alpha --nope)',
      '```',
    ].join('\n'),
  });

  const kinds = scanReferences(dir).map((v) => `${v.line}:${v.kind}`);
  assert.deepStrictEqual(kinds, [
    '2:uncaptured-writeoutput',
    '3:missing-script',
    '4:unknown-flag',
  ]);
});

test('CLI exits 1 and lists violations on stderr', () => {
  const dir = makeTree({
    'scripts/util/demo.js': WRITE_OUTPUT_SRC,
    'skills/a/SKILL.md': 'node "<PLUGIN_ROOT>/scripts/util/demo.js"\n',
  });
  const r = run(['--root', dir]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /skills\/a\/SKILL\.md:1 {2}uncaptured-writeoutput/);
});

test('CLI --json emits a JSON array on stdout', () => {
  const dir = makeTree({
    'scripts/util/demo.js': WRITE_OUTPUT_SRC,
    'skills/a/SKILL.md': 'node "<PLUGIN_ROOT>/scripts/util/demo.js"\n',
  });
  const r = run(['--root', dir, '--json']);
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed));
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].kind, 'uncaptured-writeoutput');
});

test('CLI exits 0 on a clean synthetic tree', () => {
  const dir = makeTree({
    'scripts/util/demo.js': WRITE_OUTPUT_SRC,
    'skills/a/SKILL.md': 'OUT=$(node "<PLUGIN_ROOT>/scripts/util/demo.js")\n',
  });
  const r = run(['--root', dir]);
  assert.strictEqual(r.status, 0);
});

// ---------------------------------------------------------------------------
// The gate: the REAL repo tree must be clean
// ---------------------------------------------------------------------------

test('the real repo tree has ZERO error-level script-reference violations', () => {
  const errors = scanReferences(REPO_ROOT).filter((v) => v.severity === 'error');
  const detail = errors.map((v) => `${v.file}:${v.line}  ${v.kind}  ${v.detail}`).join('\n');
  assert.strictEqual(errors.length, 0, `expected no violations, got:\n${detail}`);
});

test('the checker actually scans a non-trivial number of real invocations', () => {
  // Guards against a regression that silently stops matching anything, which
  // would make the gate above pass vacuously.
  let total = 0;
  for (const file of listMarkdownFiles(REPO_ROOT)) {
    const text = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    total += extractInvocations(text, file).length;
  }
  assert.ok(total > 100, `expected >100 script references in the tree, found ${total}`);
});

test('running the CLI against the real tree exits 0', () => {
  const r = run([]);
  assert.strictEqual(r.status, 0, r.stderr);
});

test('the checker reports unknown-flag for a bogus flag on scripts/skill/plan.js', () => {
  // Regression guard for the isPassthroughWrapper false positive plan.js used
  // to trigger: before the scope-aware rewrite, plan.js was (wrongly) treated
  // as a passthrough wrapper, so its flag check was skipped entirely and a
  // bogus flag reported nothing.
  const planSrc = fs.readFileSync(path.join(REPO_ROOT, 'scripts/skill/plan.js'), 'utf8');
  const dir = makeTree({
    'scripts/skill/plan.js': planSrc,
    'skills/a/SKILL.md': 'node "<PLUGIN_ROOT>/scripts/skill/plan.js" --totally-bogus-flag\n',
  });
  const r = run(['--root', dir]);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /unknown-flag/);
  assert.match(r.stderr, /--totally-bogus-flag/);
});
