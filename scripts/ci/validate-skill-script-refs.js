#!/usr/bin/env node
/**
 * @file ci/validate-skill-script-refs.js
 * @description Validates that every script reference inside `skills/**\/*.md`
 *   and `agents/*.md` is real and correctly invoked. Three manual audits found
 *   the same recurring defect class:
 *     1. a SKILL.md names a `scripts/...` path that does not exist,
 *     2. it passes a `--flag` the target script never parses,
 *     3. it invokes a `writeOutput()`-backed script bare (`node …`) even though
 *        that script prints a temp-file PATH on stdout and therefore MUST be
 *        captured (`VAR=$(node …)`).
 *   A fourth, warning-level check catches the inverse drift: prose claiming a
 *   `writeJsonLine()` script "prints a path" when it prints JSON directly.
 *
 *   See `scripts/lib/output.js` for the two output protocols this encodes.
 *
 * @usage node scripts/ci/validate-skill-script-refs.js [--root <dir>] [--json]
 * @exit 0 no error-level violations, 1 violations found, 2 crash
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');

/** Violation kinds. */
const KIND_MISSING_SCRIPT = 'missing-script';
const KIND_UNKNOWN_FLAG = 'unknown-flag';
const KIND_UNCAPTURED = 'uncaptured-writeoutput';
const KIND_PATH_CLAIM = 'path-claim-on-jsonline';

/** Lines of prose scanned either side of an invocation for the inverse check. */
const CONTEXT_RADIUS = 5;

/**
 * Matches a `scripts/<...>.js` (or `.cjs`) path fragment. The surrounding
 * token (the part before `scripts/`) is recovered by walking backwards, so
 * this deliberately only anchors on the fragment itself.
 */
const SCRIPT_PATH_RE = /scripts\/[A-Za-z0-9_.<>-]+(?:\/[A-Za-z0-9_.<>-]+)*\.c?js/g;

/** Characters that can legitimately precede `scripts/` inside one path token. */
const PATH_PREFIX_CHARS = /[A-Za-z0-9_.<>${}/\\~-]/;

/** A long-form CLI flag. */
const FLAG_RE = /--[A-Za-z][A-Za-z0-9-]*/g;

/**
 * Prose that claims a script prints a filesystem path. Used only for the
 * inverse (`writeJsonLine`) warning.
 */
const PATH_CLAIM_RES = [
  /\b(?:prints?|outputs?|emits?|writes?|returns?)\s+(?:out\s+)?(?:only\s+)?(?:a|the)\s+(?:absolute\s+|temp(?:orary)?[-\s]?file\s+|file\s+|output[-\s]?file\s+)?path\b/i,
  /\bpath\s+on\s+stdout\b/i,
];

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Parse command-line flags. Manual parser, mirroring validate-guardrails.js.
 */
function parseArgs(args) {
  const result = { root: REPO_ROOT, json: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--root' && i + 1 < args.length) {
      result.root = args[i + 1];
      i++;
    } else if (args[i] === '--json') {
      result.json = true;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

/**
 * Collect every markdown file the checker scans: `skills/**\/*.md` (recursive)
 * plus `agents/*.md` (top level only). Returns repo-relative POSIX paths.
 */
function listMarkdownFiles(root) {
  const out = [];

  const walk = (dir, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), childRel);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        out.push(childRel);
      }
    }
  };

  walk(path.join(root, 'skills'), 'skills');

  const agentsDir = path.join(root, 'agents');
  let agentEntries = [];
  try {
    agentEntries = fs.readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    agentEntries = [];
  }
  for (const entry of agentEntries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(`agents/${entry.name}`);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Invocation extraction
// ---------------------------------------------------------------------------

/**
 * Slice the argument text that belongs to an invocation: everything after the
 * script path up to the first UNBALANCED `)` (which closes the enclosing
 * `$(...)` capture) or end of line. Nested `$(...)` are tracked so a flag that
 * follows an inline command substitution is not silently dropped.
 */
function sliceArgText(rest) {
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '(' && i > 0 && rest[i - 1] === '$') {
      depth++;
    } else if (ch === ')') {
      if (depth === 0) return rest.slice(0, i);
      depth--;
    }
  }
  return rest;
}

/**
 * Extract the long flags passed on an invocation line. `<placeholder>` spans
 * are stripped first — the manual audit confirmed those are documentation
 * placeholders, never literal flags.
 */
function extractFlags(argText) {
  const withoutPlaceholders = argText.replace(/<[^<>\n]*>/g, ' ');
  const found = withoutPlaceholders.match(FLAG_RE) || [];
  return [...new Set(found)];
}

/**
 * Is the text preceding a `node` keyword inside a still-open `VAR=$(`
 * command substitution? `VAR=$(node …`, `VAR=$(echo x | node …` and
 * `` `VAR=$(node …` `` all qualify; a bare `node …`, or a line where an
 * earlier `VAR=$(…)` has already closed, does not.
 */
function isInsideOpenCapture(before) {
  let depth = 0;
  let capturedDepth = null;
  for (let i = 0; i < before.length; i++) {
    if (before[i] === '(') {
      depth++;
      if (
        capturedDepth === null &&
        before[i - 1] === '$' &&
        /[A-Z][A-Z0-9_]*=$/.test(before.slice(0, i - 1))
      ) {
        capturedDepth = depth;
      }
    } else if (before[i] === ')') {
      if (capturedDepth !== null && depth === capturedDepth) capturedDepth = null;
      depth--;
    }
  }
  return capturedDepth !== null;
}

/**
 * Walk backwards from `idx` collecting the path token that precedes
 * `scripts/` (e.g. `<PLUGIN_ROOT>/`, `.github/`, `plugins/lift-sdlc/`).
 */
function readPathPrefix(line, idx) {
  let start = idx;
  while (start > 0 && PATH_PREFIX_CHARS.test(line[start - 1])) start--;
  return line.slice(start, idx);
}

/**
 * Find every script reference on one line and describe it.
 *
 * @param {string} line
 * @param {string} file  repo-relative path of the markdown file
 * @param {number} lineNo 1-based
 * @param {string[]} lines all lines of the file (for prose context)
 * @returns {object[]} invocation descriptors
 */
function extractLineInvocations(line, file, lineNo, lines) {
  const invocations = [];
  SCRIPT_PATH_RE.lastIndex = 0;
  let m;

  while ((m = SCRIPT_PATH_RE.exec(line)) !== null) {
    const matchText = m[0];
    const start = m.index;
    const end = start + matchText.length;
    const prefix = readPathPrefix(line, start);
    const fullToken = prefix + matchText;

    // --- Known false positive 1: `<…>` / `<placeholder>` tokens inside the
    // path itself. `<PLUGIN_ROOT>` lives in the PREFIX (fine); a placeholder
    // in the path body means the path is not a literal reference.
    if (/[<>]/.test(matchText)) continue;

    // --- Known false positive 2: `.github/scripts/*.cjs` — those name files
    // in a CONSUMING project, not in this repo.
    if (/(^|[/\\.])\.github[/\\]$/.test(prefix) || fullToken.includes('.github/')) continue;

    const scriptPath = matchText.slice('scripts/'.length);

    // Is this a `node <path>` command invocation, or a bare prose mention?
    const before = line.slice(0, start - prefix.length).replace(/["']$/, '');
    const nodeMatch = /(?:^|[\s`|(&;])node\s+$/.exec(before);
    const isCommand = nodeMatch !== null;

    let captured = false;
    let flags = [];
    if (isCommand) {
      // `nodeMatch[0]` is `node` plus its trailing spaces, and (unless the line
      // starts with it) one leading delimiter character that belongs to the
      // text before it. Keep that delimiter.
      const leadingDelimiter = nodeMatch[0].startsWith('node') ? 0 : 1;
      const beforeNode = before.slice(0, before.length - nodeMatch[0].length + leadingDelimiter);
      // `beforeNode` ends immediately before the `node` keyword. A captured
      // invocation reads `VAR=$(node …`. Markdown lead-ins (list markers,
      // backticks, indentation) and an intervening pipeline
      // (`VAR=$(echo x | node …`) are both fine — what matters is that a
      // `VAR=$(` capture is still OPEN at the `node` keyword.
      captured = isInsideOpenCapture(beforeNode);
      const rest = line.slice(end).replace(/^["']/, '');
      flags = extractFlags(sliceArgText(rest));
    }

    const from = Math.max(0, lineNo - 1 - CONTEXT_RADIUS);
    const to = Math.min(lines.length, lineNo + CONTEXT_RADIUS);

    invocations.push({
      file,
      line: lineNo,
      scriptPath,
      isCommand,
      captured,
      flags,
      raw: fullToken,
      context: lines.slice(from, to).join('\n'),
    });
  }

  return invocations;
}

/**
 * Extract every script reference from one markdown document.
 */
function extractInvocations(text, file) {
  const lines = text.split('\n');
  const invocations = [];
  for (let i = 0; i < lines.length; i++) {
    invocations.push(...extractLineInvocations(lines[i], file, i + 1, lines));
  }
  return invocations;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/**
 * Check one invocation descriptor against the target script's source.
 *
 * @param {object} inv     descriptor from `extractInvocations`
 * @param {string|null} source  the target script's OWN source text, or `null`
 *                              when the file does not exist. The output
 *                              protocol (`writeOutput` vs `writeJsonLine`) is
 *                              read from this and only this — a delegate's
 *                              protocol is not the caller's.
 * @param {string} [flagSource] the flag-parsing closure: `source` plus the
 *                              sources of local modules it requires and
 *                              scripts it spawns. Defaults to `source`.
 * @returns {object[]} violations — `{ file, line, kind, severity, detail }`
 */
function checkInvocation(inv, source, flagSource) {
  const violations = [];
  const at = { file: inv.file, line: inv.line, script: inv.scriptPath };

  if (source === null || source === undefined) {
    violations.push({
      ...at,
      kind: KIND_MISSING_SCRIPT,
      severity: 'error',
      detail: `scripts/${inv.scriptPath} does not exist`,
    });
    return violations;
  }

  const flagText = typeof flagSource === 'string' ? flagSource : source;

  if (inv.isCommand && !isPassthroughWrapper(source)) {
    for (const flag of inv.flags || []) {
      if (!sourceParsesFlag(flagText, flag)) {
        violations.push({
          ...at,
          kind: KIND_UNKNOWN_FLAG,
          severity: 'error',
          detail: `scripts/${inv.scriptPath} does not parse ${flag}`,
        });
      }
    }
  }

  if (inv.isCommand) {
    const shortCircuited = source.includes('writeOutput(')
      ? [...shortCircuitFlags(source)].some((f) => (inv.flags || []).includes(f))
      : false;

    if (source.includes('writeOutput(') && !shortCircuited && !inv.captured) {
      violations.push({
        ...at,
        kind: KIND_UNCAPTURED,
        severity: 'error',
        detail:
          `scripts/${inv.scriptPath} uses writeOutput() — it prints a path, not JSON. ` +
          'Capture it: VAR=$(node …)',
      });
    }
  }

  if (source.includes('writeJsonLine(') && !source.includes('writeOutput(')) {
    if (PATH_CLAIM_RES.some((re) => re.test(inv.context || ''))) {
      violations.push({
        ...at,
        kind: KIND_PATH_CLAIM,
        severity: 'warning',
        detail:
          `scripts/${inv.scriptPath} uses writeJsonLine() — it prints JSON on stdout, ` +
          'but the surrounding prose claims it prints a path',
      });
    }
  }

  return violations;
}

/**
 * Does the target script's source parse `flag`?
 *
 * Three parser idioms are recognised, because all three are in use in this
 * repo and all three genuinely accept the flag:
 *
 *   1. Literal comparison — `a === '--project-root'`. The flag appears as a
 *      string literal (`'--flag'` / `"--flag"` / `` `--flag` ``), optionally
 *      as a `--flag=` prefix test.
 *   2. Dynamic construction — `argv.indexOf(`--${name}`)` (scripts/lib/
 *      mcp-failure.js). The `--` prefix is built at runtime, so the source
 *      carries only the BARE name as a literal.
 *   3. Delegation — the flag is parsed by a local module the script
 *      `require`s, or by a script it spawns. The caller passes the
 *      concatenated closure as `source` (see `effectiveSource`).
 */
function sourceParsesFlag(source, flag) {
  // `--output-file` is the manifest protocol's OWN selector, not a per-script
  // flag. `scripts/lib/output.js::writeOutput()` implements it unconditionally
  // (issue #209 removed the stdout-JSON fallback), so every writeOutput-backed
  // script honours it whether or not its parseArgs names it — some encode that
  // explicitly (`error-report-prepare.js`, `harden-prepare.js`:
  // `if (a === '--output-file') continue; // handled by writeOutput`) and
  // `util/plan-mode-check.js` spawns `ship.js --output-file` on that basis.
  if (flag === '--output-file' && source.includes('writeOutput(')) return true;

  if (
    source.includes(`'${flag}'`) ||
    source.includes(`"${flag}"`) ||
    source.includes(`\`${flag}\``) ||
    source.includes(`'${flag}=`) ||
    source.includes(`"${flag}=`)
  ) {
    return true;
  }

  // Idiom 2: flags assembled from a bare name (`--${name}`).
  if (/--\$\{/.test(source)) {
    const bare = flag.replace(/^--/, '');
    if (source.includes(`'${bare}'`) || source.includes(`"${bare}"`)) return true;
  }

  return false;
}

/**
 * Split a source file into its top-level `function name(...) { … }` bodies.
 * Brace matching is naive (it does not skip braces inside strings, template
 * literals or comments) — deliberately so: an over-long body can only ever
 * ABSORB a `writeOutput(` call and therefore make the caller MORE strict,
 * never less. It fails safe.
 */
function topLevelFunctions(source) {
  const out = [];
  const re = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/gm;
  let m;
  while ((m = re.exec(source)) !== null) {
    const start = m.index + m[0].length - 1;
    let depth = 0;
    let i = start;
    for (; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) { i++; break; }
      }
    }
    out.push({ name: m[1], body: source.slice(start, i) });
  }
  return out;
}

/**
 * Flags that select a SHORT-CIRCUIT mode — a mode handler that terminates
 * WITHOUT ever calling `writeOutput()`, either by exiting 0 outright or by
 * emitting through the streaming protocol (`writeJsonLine` / `emitText`). Such
 * a command prints no path, so there is nothing for the caller to capture.
 *
 * Two motivating cases:
 *   - `scripts/skill/plan.js --mark <name>` — `runMarkMode` writes a marker to
 *     the plan state file and exits 0 long before the manifest path is reached.
 *   - `scripts/skill/commit.js --squash-execute` / `--stash-transaction` —
 *     `runSquashExecuteMode` / `runStashTransactionMode` emit one JSON line via
 *     `writeJsonLine`, which IS the payload; capturing it would be wrong.
 */
const shortCircuitCache = new Map();

function shortCircuitFlags(source) {
  const cached = shortCircuitCache.get(source);
  if (cached) return cached;
  const flags = computeShortCircuitFlags(source);
  shortCircuitCache.set(source, flags);
  return flags;
}

function computeShortCircuitFlags(source) {
  const flags = new Set();
  for (const fn of topLevelFunctions(source)) {
    if (fn.body.includes('writeOutput(')) continue;
    // A real mode handler owns process termination: it exits itself, or ends
    // via the streaming protocol. A plain helper does neither.
    const terminates =
      /process\.exit\(/.test(fn.body) ||
      fn.body.includes('writeJsonLine(') ||
      fn.body.includes('emitText(');
    if (!terminates) continue;
    // The mode flag is derived from the handler's NAME (`runMarkMode` →
    // `--mark`) and must be a flag the script really has. Harvesting every
    // `--flag` the body merely MENTIONS would over-exempt: runMarkMode's own
    // error strings name `--output-file` and `--show-current` too.
    for (const candidate of flagsFromFunctionName(fn.name)) {
      if (source.includes(candidate)) flags.add(candidate);
    }
  }
  return flags;
}

/** `runMarkMode` → `['--mark']`; `validateBodySubcommand` → `['--validate-body']`. */
function flagsFromFunctionName(name) {
  const core = name
    .replace(/^(?:run|do|handle)/, '')
    .replace(/(?:Mode|Handler|Subcommand|SubCommand|Command|Cmd)$/, '');
  if (!core) return [];
  const kebab = core.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  return kebab ? [`--${kebab}`] : [];
}

/**
 * Replace string, template-literal, regex-literal and comment content with
 * spaces (same length, line breaks preserved) so the brace/paren-balanced
 * scans below never treat a delimiter embedded in one of those spans as real
 * code. Regex-vs-division is disambiguated by the preceding significant
 * character, the same shortcut lightweight JS tokenizers use — good enough
 * to stop stray punctuation from skewing a boundary scan; it does not need
 * to be a correct tokenizer. Still textual, not an AST.
 */
function maskNonCode(source) {
  const chars = source.split('');
  const n = chars.length;
  const REGEX_PRECEDERS = /^[([{,;:=&|!?+\-*/%^~<>]$/;
  let i = 0;
  let lastSignificant = '';

  const blankRange = (start, end) => {
    for (let k = start; k < end; k++) {
      if (chars[k] !== '\n') chars[k] = ' ';
    }
  };

  while (i < n) {
    const ch = source[i];

    if (ch === '/' && source[i + 1] === '/') {
      let j = source.indexOf('\n', i);
      if (j === -1) j = n;
      blankRange(i, j);
      i = j;
      continue;
    }

    if (ch === '/' && source[i + 1] === '*') {
      let j = source.indexOf('*/', i + 2);
      j = j === -1 ? n : j + 2;
      blankRange(i, j);
      i = j;
      continue;
    }

    // Single/double-quoted strings and template literals (the latter blanked
    // WHOLESALE, `${...}` interpolation included — a spread inside a
    // template expression is a false negative we accept, not a false
    // positive we risk).
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < n && source[j] !== quote) {
        j += source[j] === '\\' ? 2 : 1;
      }
      j = Math.min(j + 1, n);
      blankRange(i, j);
      i = j;
      lastSignificant = quote;
      continue;
    }

    if (ch === '/' && (!lastSignificant || REGEX_PRECEDERS.test(lastSignificant))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n && source[j] !== '\n') {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) { closed = true; break; }
        j++;
      }
      if (closed) {
        let end = j + 1;
        while (end < n && /[a-z]/i.test(source[end])) end++;
        blankRange(i, end);
        i = end;
        lastSignificant = '/';
        continue;
      }
    }

    if (!/\s/.test(ch)) lastSignificant = ch;
    i++;
  }

  return chars.join('');
}

/** Escape a literal identifier for interpolation into a `new RegExp(...)`. */
function escapeForRegExp(name) {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Forward brace-balanced scan: index just past the `}` that closes `{` at `openIdx`. */
function findMatchingBraceForward(masked, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    if (masked[i] === '{') depth++;
    else if (masked[i] === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return masked.length;
}

/** Backward paren-balanced scan: index of the `(` that opens the `)` at `closeIdx`, or -1. */
function findMatchingParenBackward(masked, closeIdx) {
  let depth = 0;
  for (let i = closeIdx; i >= 0; i--) {
    if (masked[i] === ')') depth++;
    else if (masked[i] === '(') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Forward paren-balanced scan: index of the `)` that closes `(` at `openIdx`, or -1. */
function findMatchingParenForward(masked, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    if (masked[i] === '(') depth++;
    else if (masked[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Is the brace at `openIdx` a FUNCTION body opener — `function ... (...) {`,
 * a method/constructor `name(...) {`, or an arrow `(...) => {` / `x => {` —
 * as opposed to a control-flow block (`if`/`for`/`while`/`switch`/`catch`),
 * an object literal, or a bare block? Only the token(s) immediately before
 * the brace are inspected.
 */
function isFunctionOpenBrace(masked, openIdx) {
  let j = openIdx - 1;
  while (j >= 0 && /\s/.test(masked[j])) j--;
  if (j < 0) return false;
  if (masked[j] === '>' && masked[j - 1] === '=') return true; // `=> {`
  if (masked[j] !== ')') return false;
  const openParen = findMatchingParenBackward(masked, j);
  if (openParen === -1) return false;
  let k = openParen - 1;
  while (k >= 0 && /\s/.test(masked[k])) k--;
  const idEnd = k + 1;
  let idStart = idEnd;
  while (idStart > 0 && /[\w$]/.test(masked[idStart - 1])) idStart--;
  const keyword = masked.slice(idStart, idEnd);
  return !['if', 'for', 'while', 'switch', 'catch'].includes(keyword);
}

/**
 * The declared name of the function whose body opens at `openIdx`
 * (`function NAME(` or a method/shorthand `NAME(`), or `null` when the
 * opener has no such name (an arrow function, an anonymous `function`
 * expression, or no enclosing function at all).
 */
function enclosingFunctionName(masked, openIdx) {
  let j = openIdx - 1;
  while (j >= 0 && /\s/.test(masked[j])) j--;
  if (j < 0 || masked[j] !== ')') return null;
  const openParen = findMatchingParenBackward(masked, j);
  if (openParen === -1) return null;
  let k = openParen - 1;
  while (k >= 0 && /\s/.test(masked[k])) k--;
  const idEnd = k + 1;
  let idStart = idEnd;
  while (idStart > 0 && /[\w$]/.test(masked[idStart - 1])) idStart--;
  return masked.slice(idStart, idEnd) || null;
}

/**
 * Smallest enclosing function body containing `pos`: `[start, end)` where
 * `start` is the body's opening `{` and `end` is just past its matching `}`.
 * Climbs past non-function blocks (`if`, object literals, bare blocks, …) to
 * their own enclosing brace. When `pos` is not nested inside any function,
 * the whole source is the body — the "treat top-level as one body" case.
 */
function bodySpanAt(masked, pos) {
  let depth = 0;
  let openIdx = -1;
  for (let i = pos - 1; i >= 0; i--) {
    const ch = masked[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      if (depth === 0) { openIdx = i; break; }
      depth--;
    }
  }
  if (openIdx === -1) return [0, masked.length];
  if (isFunctionOpenBrace(masked, openIdx)) {
    return [openIdx, findMatchingBraceForward(masked, openIdx)];
  }
  return bodySpanAt(masked, openIdx);
}

/**
 * Body spans in which `name` may legitimately still hold the `argv.slice(2)`
 * value: the binding's own enclosing function body, PLUS — when that
 * function is itself named and its return value is destructured elsewhere
 * under the SAME name (`const { forwardArgs } = parseArgs(...)`, matching
 * the `return { forwardArgs: argv.slice(2) }` shape the repo's
 * spawn-forwarding wrappers use — `util/verify-pipeline.js`,
 * `util/await-review.js`, `util/create-pr.js`, `util/plan-mode-check.js`) —
 * the enclosing body of each such call site. One hop only; deliberately does
 * not chase further indirection.
 */
function candidateBodies(masked, bindingPos, name) {
  const own = bodySpanAt(masked, bindingPos);
  const bodies = [own];

  const fnName = enclosingFunctionName(masked, own[0]);
  if (!fnName) return bodies;

  const destructureRe = new RegExp(
    `(?:const|let|var)\\s*\\{[^}]*\\b${escapeForRegExp(name)}\\b[^}]*\\}\\s*=\\s*${escapeForRegExp(fnName)}\\s*\\(`,
    'g'
  );
  let dm;
  while ((dm = destructureRe.exec(masked)) !== null) {
    bodies.push(bodySpanAt(masked, dm.index));
  }
  return bodies;
}

/**
 * Does a `spawn*`/`exec*`/`fork(` call starting within `[bodyStart, bodyEnd)`
 * pass `...name` inside its argument list?
 */
function spreadInSpawnCall(masked, source, name, bodyStart, bodyEnd) {
  const callRe = /\b(?:spawn\w*|exec\w*|fork)\s*\(/g;
  callRe.lastIndex = bodyStart;
  const spreadRe = new RegExp(`\\.\\.\\.${escapeForRegExp(name)}(?![\\w$.])`);
  let m;
  while ((m = callRe.exec(masked)) !== null) {
    if (m.index >= bodyEnd) break;
    const openParen = m.index + m[0].length - 1;
    const closeParen = findMatchingParenForward(masked, openParen);
    if (closeParen === -1) continue;
    const argText = source.slice(openParen + 1, closeParen);
    if (spreadRe.test(argText)) return true;
  }
  return false;
}

/**
 * Is this script a transparent passthrough wrapper — one that hands its whole
 * argv tail to another process (`gh`, or a sibling script) without inspecting
 * it? Those legitimately do not name any of the flags they receive.
 *
 * Detected as: a binding `X = argv.slice(2)` (or `X: argv.slice(2)` inside a
 * returned object) whose value reaches a `...X` spread inside a
 * `spawn*`/`exec*`/`fork(` argument list, WITHIN THE SAME enclosing function
 * body — or, for the returned-object shape, within a caller that destructures
 * that exact property straight off a call to the binding's own function (see
 * `candidateBodies`). A file-wide substring match is not enough: two
 * same-named bindings in unrelated scopes (one deriving from argv, one not)
 * must not be conflated — `plan.js`'s `parseArgs` binds `args` from
 * `argv.slice(2)`, but the `...args` spread inside `runExplorePack`'s
 * `spawnSync` call is an UNRELATED local `const args = ['--output-file']`;
 * only scope-aware matching tells them apart.
 */
function isPassthroughWrapper(source) {
  const masked = maskNonCode(source);
  const bindingRe = /([A-Za-z_$][\w$]*)\s*[:=]\s*(?:process\.)?argv\.slice\(2\)/g;
  let m;
  while ((m = bindingRe.exec(masked)) !== null) {
    const name = m[1];
    for (const [start, end] of candidateBodies(masked, m.index, name)) {
      if (spreadInSpawnCall(masked, source, name, start, end)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

/** How many `require`/spawn hops to follow when building the flag closure. */
const CLOSURE_DEPTH = 2;

/**
 * Local script files this source delegates to: `require('./x')` /
 * `require('../lib/x')`, and `path.join(__dirname, '..', 'skill', 'y.js')`
 * targets (the shape the spawn-forwarding wrappers use). Returns absolute
 * paths that exist under `<root>/scripts`.
 */
function collectDelegates(source, scriptAbs, root) {
  const scriptsDir = path.join(root, 'scripts');
  const dir = path.dirname(scriptAbs);
  const out = new Set();

  const add = (candidate) => {
    const abs = candidate.endsWith('.js') ? candidate : candidate + '.js';
    if (!abs.startsWith(scriptsDir + path.sep)) return;
    try {
      if (fs.statSync(abs).isFile()) out.add(abs);
    } catch {
      /* not a delegate we can resolve */
    }
  };

  const requireRe = /require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = requireRe.exec(source)) !== null) {
    add(path.resolve(dir, m[1]));
  }

  const joinRe = /path\.join\(\s*__dirname\s*((?:,\s*'[^']*')+)\s*\)/g;
  while ((m = joinRe.exec(source)) !== null) {
    const segments = [...m[1].matchAll(/'([^']*)'/g)].map((s) => s[1]);
    if (segments.length && segments[segments.length - 1].endsWith('.js')) {
      add(path.resolve(dir, ...segments));
    }
  }

  return [...out];
}

/**
 * The text the flag check runs against: a script's own source concatenated
 * with the sources of the local modules/scripts it delegates argument
 * parsing to (thin CLI wrappers around `lib/validate-links-cli.js`, and the
 * spawn-forwarding `util/verify-pipeline.js` / `util/await-review.js`).
 */
function effectiveSource(scriptAbs, root, readFile, depth = CLOSURE_DEPTH) {
  const seen = new Set();
  const parts = [];

  const visit = (abs, remaining) => {
    if (seen.has(abs)) return;
    seen.add(abs);
    const src = readFile(abs);
    if (src === null) return;
    parts.push(src);
    if (remaining <= 0) return;
    for (const next of collectDelegates(src, abs, root)) {
      visit(next, remaining - 1);
    }
  };

  visit(scriptAbs, depth);
  return parts.join('\n');
}

/**
 * Scan the repo tree and return every violation found.
 *
 * @param {string} root  repo root (defaults to this repo)
 * @returns {object[]} violations
 */
function scanReferences(root = REPO_ROOT) {
  const violations = [];
  const fileCache = new Map();

  const readFile = (abs) => {
    if (fileCache.has(abs)) return fileCache.get(abs);
    let source = null;
    try {
      if (fs.statSync(abs).isFile()) source = fs.readFileSync(abs, 'utf8');
    } catch {
      source = null;
    }
    fileCache.set(abs, source);
    return source;
  };

  const closureCache = new Map();
  const loadClosure = (scriptAbs) => {
    if (closureCache.has(scriptAbs)) return closureCache.get(scriptAbs);
    const text = effectiveSource(scriptAbs, root, readFile);
    closureCache.set(scriptAbs, text);
    return text;
  };

  for (const file of listMarkdownFiles(root)) {
    const text = readFile(path.join(root, file));
    if (text === null) continue;
    for (const inv of extractInvocations(text, file)) {
      const abs = path.join(root, 'scripts', inv.scriptPath);
      const own = readFile(abs);
      violations.push(...checkInvocation(inv, own, own === null ? undefined : loadClosure(abs)));
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function formatRow(v) {
  return `${v.file}:${v.line}  ${v.kind}  ${v.detail}`;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  let violations;
  try {
    violations = scanReferences(flags.root);
  } catch (err) {
    process.stderr.write('CRASH: ' + err.message + '\n');
    process.exit(2);
    return;
  }

  const errors = violations.filter((v) => v.severity === 'error');
  const warnings = violations.filter((v) => v.severity !== 'error');

  if (flags.json) {
    process.stdout.write(JSON.stringify(violations, null, 2) + '\n');
  } else {
    for (const v of errors) process.stderr.write(formatRow(v) + '\n');
    for (const v of warnings) process.stderr.write(formatRow(v) + ' (warning)\n');
    if (errors.length === 0) {
      process.stdout.write(
        `Skill script references: OK (${warnings.length} warning${warnings.length === 1 ? '' : 's'})\n`
      );
    } else {
      process.stderr.write(
        `\n${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}\n`
      );
    }
  }

  process.exit(errors.length === 0 ? 0 : 1);
}

module.exports = {
  parseArgs,
  listMarkdownFiles,
  extractInvocations,
  extractFlags,
  sliceArgText,
  sourceParsesFlag,
  isPassthroughWrapper,
  isInsideOpenCapture,
  topLevelFunctions,
  shortCircuitFlags,
  collectDelegates,
  effectiveSource,
  checkInvocation,
  scanReferences,
  REPO_ROOT,
};

if (require.main === module) {
  main();
}
