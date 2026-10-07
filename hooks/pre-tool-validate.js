#!/usr/bin/env node
/**
 * pre-tool-validate.js
 * PreToolUse hook — "Shift-Left" validation of edited files before they are written.
 *
 * Host: Antigravity (https://antigravity.google/docs/hooks/). This repo is an
 * Antigravity-native plugin — hooks.json registers this hook against Antigravity
 * tool-call matchers (`write_to_file|replace_file_content|...`), so the payload
 * read from stdin is the Antigravity shape
 * `{ toolCall: { name, args: { TargetFile, CodeContent } } }` and the output
 * written to stdout is `{ decision, reason }`. The legacy `args.Target` /
 * `args.Content` fields are still read as fallbacks (harmless, kept for
 * backward compatibility) but are not the primary path. Claude Code's
 * payload/output shapes — `{ tool_name, tool_input: { file_path, content } }`
 * input and `hookSpecificOutput` output — are intentionally NOT supported
 * here; adding a second input shape would risk a half-ported guard that fails
 * open on one host.
 *
 * Plan scope (#17): a whole-file write to a `.md` directly in a `plans` folder is validated only when the
 * content declares itself an executable plan (`**Goal:**` + a `### Task N:` heading
 * outside fenced code) and the path is not under `archive/` or `archived/`. PF5 runs
 * with `--allow-closed-criteria`, so a ticked or `[~]`-closed plan can be rewritten.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');

// 1. Read stdin
let input = {};
try {
  const raw = fs.readFileSync(0, 'utf8');
  if (raw.trim()) {
    input = JSON.parse(raw);
  }
} catch {
  // Stdin unreadable or non-JSON — fail closed, consistent with the other
  // PreToolUse guard hook (pre-tool-git-guard.js).
  process.stdout.write(JSON.stringify({ decision: 'deny', reason: 'pre-tool-validate.js: could not parse tool-call input as JSON (fail-closed). If this repeats for every command, the host is sending malformed payloads — inspect hooks.json or temporarily disable this hook.' }) + '\n');
  process.exit(0);
}

const toolCall = input.toolCall || {};
const args = toolCall.args || {};
const targetFile = args.TargetFile || args.Target || null;

if (!targetFile) {
  process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
  process.exit(0);
}

// Extract content based on tool
let proposedContent = null;
if (toolCall.name === 'write_to_file' || toolCall.name === 'write_file') {
  proposedContent = args.CodeContent || args.Content || '';
} else if (toolCall.name === 'replace_file_content' || toolCall.name === 'multi_replace_file_content') {
  // We can't perfectly reconstruct the file here without reading the original
  // and applying patches. For simplicity in this port, we will allow it 
  // and rely on SKILL.md for deep replace validation, or we just validate what we can.
  // For now, allow replacements and only block full writes if they are invalid.
  process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
  process.exit(0);
} else {
  process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
  process.exit(0);
}

// 2. Pattern matching
const DIMENSION_RE = /[/\\]\.(?:antigravity|sdlc)[/\\]review-dimensions[/\\][^/\\]+\.ya?ml$/;
const PR_TEMPLATE_RE = /[/\\]\.(?:antigravity|sdlc)[/\\]pr-template\.md$/;
const PLAN_RE = /[/\\]plans[/\\][^/\\]+\.md$/;

const isDimension = DIMENSION_RE.test(targetFile);
const isPrTemplate = PR_TEMPLATE_RE.test(targetFile);
const isPlan = PLAN_RE.test(targetFile);

if (!isDimension && !isPrTemplate && !isPlan) {
  process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
  process.exit(0);
}

// 3. Scope of plan validation (#17).
// A `*/plans/*.md` path alone does not make a file an executable plan: plans folders also hold
// READMEs, plan guidelines, briefs and the skeleton plan-sdlc writes before the tasks exist. Only
// content that declares itself an executable plan — a `**Goal:**` line and at least one
// `### Task N:` heading outside fenced code — is validated. Files under an `archive/` or `archived/`
// directory are history and are not validated either.
const scriptsDir = path.resolve(__dirname, '..', 'scripts');
const ARCHIVE_RE = /[/\\]archived?[/\\]/i;
if (isPlan) {
  let outOfScope = ARCHIVE_RE.test(targetFile);
  if (!outOfScope) {
    try {
      const { isExecutablePlan } = require(path.join(scriptsDir, 'ci', 'validate-plan-format.js'));
      outOfScope = !isExecutablePlan(proposedContent);
    } catch { /* detector unavailable: validate the file as before rather than skip it */ }
  }
  if (outOfScope) {
    process.stdout.write(JSON.stringify({ decision: 'allow' }) + '\n');
    process.exit(0);
  }
}

// 4. Locate validator scripts
let validatorScript;
if (isDimension) {
  validatorScript = path.join(scriptsDir, 'ci', 'validate-dimensions.js');
} else if (isPrTemplate) {
  validatorScript = path.join(scriptsDir, 'ci', 'validate-pr-template.js');
} else {
  validatorScript = path.join(scriptsDir, 'ci', 'validate-plan-format.js');
}

// 5. Run validator on a temporary file.
// The proposed content is not on disk yet, so it is written to a private temporary directory (unique
// name, removed in `finally` on every path, including a denial) and validated from there. The validator
// prints the path it was given, so the temporary path is replaced by the real target path in the
// findings, which keeps `<file>:<line>: <problem>` lines usable.
let decision;
let tempDir = null;
try {
  if (isPlan) {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-'));
    const tempFile = path.join(tempDir, path.basename(targetFile));
    fs.writeFileSync(tempFile, proposedContent, 'utf8');
    try {
      // --allow-closed-criteria: a plan whose boxes are all ticked ("- [x]") or skipped ("- [~]")
      // is a finished plan being rewritten, not a malformed one; PF5's "open box" rule is for a
      // plan before execution and is checked there by plan-sdlc's final format step.
      execFileSync(process.execPath, [validatorScript, '--file', tempFile, '--markdown', '--allow-closed-criteria'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      decision = { decision: 'allow' };
    } catch (err) {
      const stdout = (err.stdout || '').trim();
      const stderr = (err.stderr || '').trim();
      const findings = (stdout || stderr || err.message).split(tempFile).join(targetFile);
      decision = { decision: 'deny', reason: `Validation Failed:\n${findings}` };
    }
  } else {
    // validate-dimensions.js and validate-pr-template.js only support project-root validation, not
    // single files. For dimensions and pr-template we fall back to allow. This is a known limitation
    // of the Shift-Left port.
    decision = { decision: 'allow' };
  }
} catch (err) {
  decision = { decision: 'deny', reason: `Validation Failed:\n${err.message}` };
} finally {
  if (tempDir) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

process.stdout.write(JSON.stringify(decision) + '\n');
process.exit(0);
