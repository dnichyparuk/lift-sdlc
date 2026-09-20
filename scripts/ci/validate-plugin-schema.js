#!/usr/bin/env node
/**
 * @file ci/validate-plugin-schema.js
 * @description Wraps `agy plugin validate <plugin-dir>` and adds two
 *   hand-rolled assertions that no schema tool checks for us:
 *     1. a frontmatter assertion for the two read-only self-learning agents
 *        (`agents/learn-synthesis-orchestrator.md`, `agents/learn-review-only.md`);
 *     2. a structural check of `hooks.json` against the official Antigravity
 *        hooks contract (https://antigravity.google/docs/hooks): `PreToolUse`
 *        and `PostToolUse` arrays hold `{ matcher?, hooks: [handler] }`
 *        wrapper objects, while `PreInvocation`, `PostInvocation` and `Stop`
 *        arrays hold handler objects DIRECTLY (`{ type?, command, timeout? }`).
 *        Wrapping a non-tool event's handler in `{ hooks: [...] }` makes the
 *        CLI reject the WHOLE plugin hooks.json at load time
 *        (`hooks.go: Failed to parse hooks for plugin <name>: invalid hook
 *        "<group>": command hook must specify 'command'`) while
 *        `agy plugin validate` still reports `✔ hooks : N processed`.
 *
 *   HONESTY NOTE (do not remove, do not let a future reader mistake a green
 *   run for schema conformance): `agy plugin validate` is a DISCOVERY
 *   COUNTER, not a schema validator. Empirically confirmed on this repo — a
 *   synthetic plugin with a bogus frontmatter field on a skill, and an agent
 *   declaring `tools: Read, Write, Bash` with `model: gpt-4`, BOTH still exit
 *   0 from `agy plugin validate`. It checks that files parse and are
 *   discovered (`✔ skills : N processed`, `✔ agents : N processed`,
 *   `✔ hooks : N processed`) — it does NOT check field names, tool names, or
 *   model ids against any schema. A green `check:plugin` run therefore proves
 *   only "files parse and were discovered by Antigravity tooling", never
 *   "these files conform to a schema".
 *
 *   The real signal in THIS script is the hand-rolled tool-boundary
 *   assertion below: it greps both read-only agents' `tools:` frontmatter
 *   line and fails unless it is EXACTLY `view_file` — an allowlist, not a
 *   denylist, so it needs no upkeep as new tool names appear in
 *   docs/plugin-api-specs.md. That assertion runs unconditionally, even when
 *   the `agy` binary itself is missing.
 *
 *   Precedent (mirrors scripts/ci/validate-skill-script-refs.js and its
 *   `check:refs` wiring exactly): this repo has no `.github/workflows/` and
 *   no automated trigger for ANY check script today. `check:plugin` is real
 *   and runnable the same way `check:refs` is — available via `npm run
 *   check:plugin`, not auto-triggered by anything. That is what "wired into
 *   CI" means by this repo's own existing standard for the phrase.
 *
 * @usage node scripts/ci/validate-plugin-schema.js [--plugin-dir <path>]
 * @exit 0 valid (schema + tool-boundary + hooks shape), or `agy` not
 *          installed (schema check skipped, the two hand-rolled assertions
 *          still run and must pass)
 * @exit 1 agy-reported schema violation, either read-only agent's `tools:`
 *          value is not exactly `view_file`, or hooks.json violates the
 *          official event-array shapes
 * @exit 2 crash
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');

/** The one and only permitted `tools:` value for these two agents (allowlist, not denylist — see header). */
const REQUIRED_TOOLS_VALUE = 'view_file';

/** The read-only self-learning agents this script mechanically asserts on. Fixed list (per Contract's `sync: none`) — not derived from docs/plugin-api-specs.md. */
const AGENTS_TO_CHECK = [
  'agents/learn-synthesis-orchestrator.md',
  'agents/learn-review-only.md',
];

const SKIP_NOTE =
  'validate-plugin-schema: `agy` binary not found on PATH — schema check skipped ' +
  '(tool-boundary assertion still ran). Note: even when `agy` IS installed, a green ' +
  '`agy plugin validate` only proves plugin files parse and are discovered — it does ' +
  'not check field names, tool names, or model ids against a schema.';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Parse command-line flags. Manual parser, mirroring validate-skill-script-refs.js.
 * @param {string[]} args
 * @returns {{pluginDir: string}}
 */
function parseArgs(args) {
  const result = { pluginDir: REPO_ROOT };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--plugin-dir' && i + 1 < args.length) {
      result.pluginDir = args[i + 1];
      i++;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tool-boundary assertion (the real signal — see header)
// ---------------------------------------------------------------------------

/**
 * Extract the YAML frontmatter block (the text between the first two `---`
 * lines) from a markdown file's content, or `null` when there is none.
 * @param {string} text
 * @returns {string|null}
 */
function extractFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return m ? m[1] : null;
}

/**
 * Read the `tools:` frontmatter value from one agent file's content.
 * @param {string} text
 * @returns {string|null} the trimmed value, or `null` when no `tools:` line
 *   is found in the frontmatter block.
 */
function readToolsValue(text) {
  const frontmatter = extractFrontmatter(text);
  if (frontmatter === null) return null;
  const m = /^tools:\s*(.*)$/m.exec(frontmatter);
  if (!m) return null;
  return m[1].trim();
}

/**
 * Independently of `agy`'s schema check — which validates frontmatter SHAPE
 * only, never a `tools:` value's CONTENT (confirmed empirically, see header)
 * — assert that both read-only self-learning agents grant exactly
 * `view_file` and nothing else: not a superset, not even another read-only
 * tool.
 *
 * @param {string} pluginDir
 * @returns {Array<{file: string, reason: string}>} violations, empty when both pass
 */
function checkToolBoundary(pluginDir) {
  const violations = [];
  for (const rel of AGENTS_TO_CHECK) {
    const abs = path.join(pluginDir, rel);
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      violations.push({ file: rel, reason: `cannot read file: ${err.message}` });
      continue;
    }
    const value = readToolsValue(text);
    if (value === null) {
      violations.push({ file: rel, reason: 'no tools: line found in frontmatter' });
    } else if (value !== REQUIRED_TOOLS_VALUE) {
      violations.push({
        file: rel,
        reason: `tools: value is "${value}", expected exactly "${REQUIRED_TOOLS_VALUE}"`,
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// hooks.json shape assertion (official contract — see header)
// ---------------------------------------------------------------------------

/** Events whose array elements are `{ matcher?, hooks: [handler, ...] }` wrappers. */
const MATCHER_EVENTS = ['PreToolUse', 'PostToolUse'];
/** Events whose array elements are handler objects directly (matcher ignored). */
const DIRECT_EVENTS = ['PreInvocation', 'PostInvocation', 'Stop'];
const ALL_EVENTS = [...MATCHER_EVENTS, ...DIRECT_EVENTS];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validate one handler object (`{ type?, command, timeout? }`).
 * @param {*} handler
 * @param {string} where  human-readable location for the message
 * @returns {string[]} reasons (empty when valid)
 */
function checkHandler(handler, where) {
  const reasons = [];
  if (!isPlainObject(handler)) {
    reasons.push(`${where}: handler must be an object`);
    return reasons;
  }
  if (typeof handler.command !== 'string' || handler.command.trim() === '') {
    reasons.push(`${where}: handler must specify a non-empty string "command"`);
  }
  if (handler.type !== undefined && handler.type !== 'command') {
    reasons.push(`${where}: handler "type" must be "command" when present (got ${JSON.stringify(handler.type)})`);
  }
  if (handler.timeout !== undefined && !Number.isInteger(handler.timeout)) {
    reasons.push(`${where}: handler "timeout" must be an integer (seconds) when present`);
  }
  return reasons;
}

/**
 * Pure structural check of a parsed hooks.json document.
 * @param {*} doc  parsed JSON
 * @returns {string[]} reasons (empty when the document conforms)
 */
function validateHooksDocument(doc) {
  const reasons = [];
  if (!isPlainObject(doc)) {
    return ['top level must be an object mapping hook-group names to event maps'];
  }
  for (const [group, spec] of Object.entries(doc)) {
    if (!isPlainObject(spec)) {
      reasons.push(`"${group}": must be an object of event arrays`);
      continue;
    }
    for (const [key, value] of Object.entries(spec)) {
      if (key === 'enabled') {
        if (typeof value !== 'boolean') reasons.push(`"${group}".enabled: must be a boolean`);
        continue;
      }
      if (!ALL_EVENTS.includes(key)) {
        reasons.push(`"${group}": unknown event "${key}" (supported: ${ALL_EVENTS.join(', ')})`);
        continue;
      }
      if (!Array.isArray(value)) {
        reasons.push(`"${group}".${key}: must be an array`);
        continue;
      }
      value.forEach((el, i) => {
        const where = `"${group}".${key}[${i}]`;
        if (MATCHER_EVENTS.includes(key)) {
          if (!isPlainObject(el)) { reasons.push(`${where}: must be a { matcher?, hooks: [...] } object`); return; }
          if (el.command !== undefined) {
            reasons.push(`${where}: ${key} elements must wrap handlers in "hooks": [...] — a bare handler here is not read by the CLI`);
          }
          if (el.matcher !== undefined && typeof el.matcher !== 'string') {
            reasons.push(`${where}: "matcher" must be a string`);
          }
          if (!Array.isArray(el.hooks) || el.hooks.length === 0) {
            reasons.push(`${where}: must contain a non-empty "hooks" array`);
            return;
          }
          el.hooks.forEach((h, j) => reasons.push(...checkHandler(h, `${where}.hooks[${j}]`)));
        } else {
          if (!isPlainObject(el)) { reasons.push(`${where}: must be a handler object`); return; }
          if (el.hooks !== undefined || el.matcher !== undefined) {
            reasons.push(
              `${where}: ${key} elements must be handler objects DIRECTLY ({ "command": ... }); ` +
              'a { "matcher"/"hooks": [...] } wrapper here makes the CLI reject the whole plugin hooks.json ' +
              '("command hook must specify \'command\'")'
            );
            return;
          }
          reasons.push(...checkHandler(el, where));
        }
      });
    }
  }
  return reasons;
}

/**
 * Read `<pluginDir>/hooks.json` (optional component — absent file is not a
 * violation) and validate its shape against the official contract.
 * @param {string} pluginDir
 * @returns {Array<{file: string, reason: string}>}
 */
function checkHooksShape(pluginDir) {
  const rel = 'hooks.json';
  const abs = path.join(pluginDir, rel);
  if (!fs.existsSync(abs)) return [];
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    return [{ file: rel, reason: `cannot read file: ${err.message}` }];
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return [{ file: rel, reason: `invalid JSON: ${err.message}` }];
  }
  return validateHooksDocument(doc).map((reason) => ({ file: rel, reason }));
}

// ---------------------------------------------------------------------------
// agy wrapper
// ---------------------------------------------------------------------------

/**
 * Run `agy plugin validate <pluginDir>` via `spawnFn` (an argv array — no
 * shell). Distinguishes "binary not installed" (ENOENT) from every other
 * outcome so the caller can skip the schema check gracefully in the former
 * case while still surfacing agy's own output in the latter.
 *
 * @param {Function} spawnFn  injectable — defaults to `child_process.spawnSync`.
 *   Tests inject a stub here because the real `agy` binary currently exits 0
 *   on every input this repo has been able to construct (see header) — the
 *   schema-violation failure branch below can only be exercised this way.
 * @param {string} pluginDir
 * @returns {{installed: false} | {installed: true, status: number|null, stdout: string, stderr: string}}
 */
function runAgyValidate(spawnFn, pluginDir) {
  const result = spawnFn('agy', ['plugin', 'validate', pluginDir], { encoding: 'utf8' });
  if (result.error) {
    if (result.error.code === 'ENOENT') {
      return { installed: false };
    }
    // Some other spawn failure (EACCES, a killed process, ...) — the process
    // never produced its own stdout/stderr, so fold the real reason in rather
    // than reporting a bare "schema error (exit null)" with no explanation.
    const spawnErrorLine = `agy plugin validate spawn error: ${result.error.message}`;
    return {
      installed: true,
      status: result.status,
      stdout: result.stdout || '',
      stderr: (result.stderr ? result.stderr + '\n' : '') + spawnErrorLine,
    };
  }
  return {
    installed: true,
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

// ---------------------------------------------------------------------------
// Orchestration (pure — no I/O, easy to test)
// ---------------------------------------------------------------------------

/**
 * Combine the tool-boundary violations and the agy result into a final
 * exit code and the lines to print. Kept pure/side-effect-free so tests can
 * drive every branch (agy missing, agy schema error, agy pass, tool-boundary
 * failure, combinations thereof) without spawning a real process.
 *
 * @param {{toolViolations: Array<{file: string, reason: string}>, hooksViolations?: Array<{file: string, reason: string}>, agyResult: object}} input
 * @returns {{exitCode: 0|1, stdout: string[], stderr: string[]}}
 */
function evaluate({ toolViolations, hooksViolations = [], agyResult }) {
  const stdout = [];
  const stderr = [];

  for (const v of toolViolations) {
    stderr.push(`tools-boundary: ${v.file}: ${v.reason}`);
  }
  for (const v of hooksViolations) {
    stderr.push(`hooks-shape: ${v.file}: ${v.reason}`);
  }
  const localFailures = toolViolations.length + hooksViolations.length;

  if (!agyResult.installed) {
    stderr.push(SKIP_NOTE);
    return { exitCode: localFailures > 0 ? 1 : 0, stdout, stderr };
  }

  // Surface agy's own output (the "✔ agents: N processed" / "✔ hooks: N
  // processed" lines) rather than swallowing it.
  if (agyResult.stdout) stdout.push(agyResult.stdout);
  if (agyResult.stderr) stderr.push(agyResult.stderr);

  const schemaOk = agyResult.status === 0;
  if (!schemaOk) {
    stderr.push(
      `validate-plugin-schema: agy plugin validate reported a schema error (exit ${agyResult.status})`
    );
  }

  const exitCode = !schemaOk || localFailures > 0 ? 1 : 0;
  return { exitCode, stdout, stderr };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function writeLines(stream, lines) {
  for (const line of lines) {
    stream.write(line.endsWith('\n') ? line : line + '\n');
  }
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const pluginDir = path.resolve(flags.pluginDir);

  // Runs unconditionally — even when `agy` itself is absent (see header and
  // Contract: "tool-boundary assertion still runs").
  const toolViolations = checkToolBoundary(pluginDir);
  const hooksViolations = checkHooksShape(pluginDir);

  const agyResult = runAgyValidate(spawnSync, pluginDir);

  const { exitCode, stdout, stderr } = evaluate({ toolViolations, hooksViolations, agyResult });
  writeLines(process.stdout, stdout);
  writeLines(process.stderr, stderr);

  process.exit(exitCode);
}

module.exports = {
  parseArgs,
  extractFrontmatter,
  readToolsValue,
  checkToolBoundary,
  checkHooksShape,
  validateHooksDocument,
  MATCHER_EVENTS,
  DIRECT_EVENTS,
  runAgyValidate,
  evaluate,
  REQUIRED_TOOLS_VALUE,
  AGENTS_TO_CHECK,
  SKIP_NOTE,
  REPO_ROOT,
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write('CRASH: ' + err.message + '\n');
    process.exit(2);
  }
}
