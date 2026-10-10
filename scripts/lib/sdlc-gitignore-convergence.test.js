'use strict';

// `.sdlc/.gitignore` is written by two plugins: lift-sdlc (`ensureSdlcGitignore`
// in ./config.js) and the Claude Code `sdlc` plugin. A project that runs both
// must get the same bytes whichever writer ran last. This test runs lift's
// writer and a faithful copy of the `sdlc` writer in both orders over a grid
// of inputs and checks that the results are byte-identical and that each
// writer is idempotent.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ensureSdlcGitignore } = require('./config');

// ---------------------------------------------------------------------------
// Fixture: the `sdlc` writer, copied from the Claude Code plugin `sdlc`
// 0.21.29, scripts/lib/config.js — `normalizeBlankLines` (lines 667-695),
// `SDLC_GITIGNORE_PATTERNS` / markers (lines 703-711) and
// `ensureSdlcGitignore` (lines 721-792). Only the file I/O is replaced by a
// string-in/string-out signature; the line logic is unchanged. Do not import
// the other plugin: this copy pins the behaviour lift-sdlc converges with.
// ---------------------------------------------------------------------------

function sdlcNormalizeBlankLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return [];
  const isBlank = (s) => s === '' || /^\s*$/.test(s);

  // Trim leading blanks
  let start = 0;
  while (start < lines.length && isBlank(lines[start])) start++;
  // Trim trailing blanks
  let end = lines.length - 1;
  while (end >= start && isBlank(lines[end])) end--;
  if (end < start) return [];

  // Collapse consecutive blank runs to one
  const out = [];
  let prevBlank = false;
  for (let i = start; i <= end; i++) {
    const blank = isBlank(lines[i]);
    if (blank) {
      if (prevBlank) continue;
      out.push('');
      prevBlank = true;
    } else {
      out.push(lines[i]);
      prevBlank = false;
    }
  }
  return out;
}

const SDLC_PATTERNS = [
  '*',
  '!.gitignore',
  '!config.json',
  '!review-dimensions/',
  '!review-dimensions/**',
];
const SDLC_BEGIN = '# >>> sdlc-utilities managed (do not edit) — selective ignores';
const SDLC_END   = '# <<< sdlc-utilities managed';

function sdlcWriter(existing) {
  const managedBlock = [SDLC_BEGIN, ...SDLC_PATTERNS, SDLC_END].join('\n');

  const lines = existing === '' ? [] : existing.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const managedPatternSet = new Set(SDLC_PATTERNS);
  const otherLinesRaw = [];
  let insideBlock = false;
  for (const line of lines) {
    if (line === SDLC_BEGIN) {
      insideBlock = true;
      continue;
    }
    if (line === SDLC_END) {
      insideBlock = false;
      continue;
    }
    if (insideBlock) {
      continue;
    }
    if (managedPatternSet.has(line.trim())) {
      continue;
    }
    otherLinesRaw.push(line);
  }

  const otherLines = sdlcNormalizeBlankLines(otherLinesRaw);

  let next;
  if (otherLines.length > 0) {
    next = otherLines.join('\n') + '\n' + managedBlock + '\n';
  } else {
    next = managedBlock + '\n';
  }
  return next;
}

// ---------------------------------------------------------------------------
// lift-sdlc writer, string-in/string-out over a scratch project
// ---------------------------------------------------------------------------

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-gitignore-converge-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function liftWriter(existing) {
  const file = path.join(scratch, '.sdlc', '.gitignore');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, existing, 'utf8');
  ensureSdlcGitignore(scratch);
  return fs.readFileSync(file, 'utf8');
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const LIFT_BEGIN = '# >>> lift-sdlc managed (do not edit) — selective ignores';
const LIFT_END   = '# <<< lift-sdlc managed';
const LEARNINGS = ['!learnings/', '!learnings/pending/', '!learnings/pending/**'];

const BLOCKS = {
  // As written by lift-sdlc <= 0.27.1 on its own.
  liftFull: [LIFT_BEGIN, ...SDLC_PATTERNS, ...LEARNINGS, LIFT_END],
  // As left by the sdlc writer after it stripped its patterns from the block.
  liftReduced: [LIFT_BEGIN, ...LEARNINGS, LIFT_END],
  sdlcFull: [SDLC_BEGIN, ...SDLC_PATTERNS, SDLC_END],
  // As left by lift-sdlc <= 0.27.1 after it stripped the sdlc block's patterns.
  sdlcEmptied: [SDLC_BEGIN, SDLC_END],
};

const CONFIGS = [['empty', []]];
for (const l of ['liftFull', 'liftReduced']) CONFIGS.push([l, [BLOCKS[l]]]);
for (const s of ['sdlcFull', 'sdlcEmptied']) CONFIGS.push([s, [BLOCKS[s]]]);
for (const s of ['sdlcFull', 'sdlcEmptied']) {
  for (const l of ['liftFull', 'liftReduced']) {
    CONFIGS.push([`${s}+${l}`, [BLOCKS[s], BLOCKS[l]]]);
    CONFIGS.push([`${l}+${s}`, [BLOCKS[l], BLOCKS[s]]]);
  }
}

const PROJECT_LINES_BEFORE = ['# project rules', 'local-notes/', ''];
const PROJECT_LINES_AFTER = ['cache/', '', '# trailing note'];

function buildInputs() {
  const inputs = new Map();
  for (const [name, blocks] of CONFIGS) {
    for (let before = 0; before <= 3; before++) {
      for (let after = 0; after <= 3; after++) {
        for (const trailingNewline of [true, false]) {
          const lines = [
            ...PROJECT_LINES_BEFORE.slice(0, before),
            ...blocks.flat(),
            ...PROJECT_LINES_AFTER.slice(0, after),
          ];
          let text = lines.join('\n');
          if (trailingNewline && text !== '') text += '\n';
          const label = `${name} before=${before} after=${after} nl=${trailingNewline}`;
          if (!inputs.has(text)) inputs.set(text, label);
        }
      }
    }
  }
  return inputs;
}

const INPUTS = buildInputs();

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test(`convergence: lift→sdlc equals sdlc→lift, both writers idempotent (${INPUTS.size} inputs)`, () => {
  assert.ok(INPUTS.size >= 300, `expected a full grid of inputs, got ${INPUTS.size}`);
  for (const [input, label] of INPUTS) {
    const liftThenSdlc = sdlcWriter(liftWriter(input));
    const sdlcThenLift = liftWriter(sdlcWriter(input));
    assert.strictEqual(liftThenSdlc, sdlcThenLift, `orders diverge for ${label}`);

    const l1 = liftWriter(input);
    assert.strictEqual(liftWriter(l1), l1, `lift writer not idempotent for ${label}`);
    const s1 = sdlcWriter(input);
    assert.strictEqual(sdlcWriter(s1), s1, `sdlc writer not idempotent for ${label}`);

    // The converged file is a fixed point of both writers: no more flips.
    assert.strictEqual(liftWriter(liftThenSdlc), liftThenSdlc, `lift rewrites converged file for ${label}`);
    assert.strictEqual(sdlcWriter(liftThenSdlc), liftThenSdlc, `sdlc rewrites converged file for ${label}`);
  }
});

test('canonical shape: project lines, lift block, sdlc block, final newline', () => {
  const input = ['# project rules', ...BLOCKS.sdlcFull, 'cache/', ...BLOCKS.liftFull].join('\n');
  const expected = [
    '# project rules',
    'cache/',
    ...BLOCKS.liftReduced,
    ...BLOCKS.sdlcFull,
  ].join('\n') + '\n';
  assert.strictEqual(liftWriter(input), expected);
  assert.strictEqual(sdlcWriter(liftWriter(input)), expected);
  assert.strictEqual(liftWriter(sdlcWriter(input)), expected);
});

test('lift writer keeps the sdlc block verbatim and never duplicates it', () => {
  const sdlcText = BLOCKS.sdlcFull.join('\n');
  const out = liftWriter(['a', sdlcText, 'b', sdlcText].join('\n') + '\n');
  // The first complete sdlc block is kept as is; later copies are other
  // lines (stripped of the base patterns), exactly as the sdlc writer
  // treats them.
  assert.strictEqual(out.split(sdlcText).length - 1, 1);
});

test('lift alone (no sdlc block) still writes the full deny-all block', () => {
  assert.strictEqual(
    liftWriter(''),
    [LIFT_BEGIN, ...SDLC_PATTERNS, ...LEARNINGS, LIFT_END].join('\n') + '\n',
  );
});

test('known limitation: a project line after the sdlc block is moved before it', () => {
  // Placed by hand after the sdlc block, `!learnings/log.md` would un-ignore
  // the file. Both writers move it before the blocks, where sdlc's `*`
  // shadows it again for untracked files. Tracked files are unaffected,
  // which is why such files are tracked with `git add -f`.
  const input = [...BLOCKS.liftReduced, ...BLOCKS.sdlcFull, '!learnings/log.md'].join('\n') + '\n';
  // sdlc alone puts it right before its own block, after lift's block.
  assert.strictEqual(
    sdlcWriter(input),
    [...BLOCKS.liftReduced, '!learnings/log.md', ...BLOCKS.sdlcFull].join('\n') + '\n',
  );
  // Once both writers have run, in either order, it sits before both blocks.
  const expected = ['!learnings/log.md', ...BLOCKS.liftReduced, ...BLOCKS.sdlcFull].join('\n') + '\n';
  assert.strictEqual(liftWriter(input), expected);
  assert.strictEqual(sdlcWriter(liftWriter(input)), expected);
  assert.strictEqual(liftWriter(sdlcWriter(input)), expected);
});
