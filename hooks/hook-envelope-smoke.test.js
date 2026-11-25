'use strict';

/**
 * hook-envelope-smoke.test.js
 * Hermetic, offline smoke test that spawns all 9 hooks registered in hooks.json
 * with authentic Antigravity (agy v1.5+) camelCase stdin payloads pointing
 * stdin.cwd at an isolated temporary git repository, and asserts exit code 0
 * plus valid agy v1.5+ JSON output envelopes.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const HOOKS_JSON_PATH = path.join(PLUGIN_ROOT, 'hooks.json');

const VALID_DECISIONS = new Set(['allow', 'deny', 'continue']);

/** Collect every { group, event, command } entry from hooks.json. */
function collectRegisteredHooks(hooksDoc) {
  const entries = [];
  for (const [group, spec] of Object.entries(hooksDoc)) {
    for (const [event, arr] of Object.entries(spec)) {
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (Array.isArray(item.hooks)) {
          for (const h of item.hooks) {
            entries.push({ group, event, matcher: item.matcher || null, command: h.command });
          }
        } else if (item && typeof item.command === 'string') {
          entries.push({ group, event, matcher: null, command: item.command });
        }
      }
    }
  }
  return entries;
}

/** Resolve a `node ./hooks/<script>.js` command into an absolute script path. */
function resolveHookScript(command) {
  const m = /^node\s+(.+)$/.exec(command.trim());
  assert.ok(m, `Expected "node <script>" command, got: ${command}`);
  return path.resolve(PLUGIN_ROOT, m[1].trim());
}

/** Spawn a hook script from PLUGIN_ROOT (mirroring agy host behavior) with JSON stdin. */
function spawnHook(command, payload, extraEnv = {}) {
  const scriptPath = resolveHookScript(command);
  const res = spawnSync(process.execPath, [scriptPath], {
    cwd: PLUGIN_ROOT,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      // Ensure offline / isolated execution without inheriting external overrides
      SDLC_STATE_DIR_OVERRIDE: '',
      SDLC_JIRA_STORE_DIR_OVERRIDE: '',
      ...extraEnv,
    },
  });
  return res;
}

function assertValidSystemMessageOrEmpty(parsed, label) {
  assert.equal(typeof parsed, 'object', `${label}: output must be a JSON object`);
  assert.notEqual(parsed, null, `${label}: output must not be null`);
  if (Object.keys(parsed).length === 0) return;
  assert.ok(
    Array.isArray(parsed.injectSteps) && parsed.injectSteps.length > 0,
    `${label}: expected {} or { injectSteps: [{ systemMessage: { systemMessage } }] }, got: ${JSON.stringify(parsed)}`
  );
  const msg = parsed.injectSteps[0]?.systemMessage?.systemMessage;
  assert.equal(
    typeof msg,
    'string',
    `${label}: injectSteps[0].systemMessage.systemMessage must be a string`
  );
  assert.ok(msg.length > 0, `${label}: systemMessage must be non-empty`);
}

function assertValidDecisionEnvelope(parsed, label) {
  assert.equal(typeof parsed, 'object', `${label}: output must be a JSON object`);
  assert.notEqual(parsed, null, `${label}: output must not be null`);
  assert.ok(
    VALID_DECISIONS.has(parsed.decision),
    `${label}: expected decision in allow|deny|continue, got: ${JSON.stringify(parsed)}`
  );
  if (parsed.decision !== 'allow') {
    assert.equal(typeof parsed.reason, 'string', `${label}: non-allow decision should include string reason`);
  }
}

describe('hook-envelope-smoke (all 9 hooks.json scripts)', () => {
  let tempRepo;
  let hooksDoc;
  let registered;

  before(() => {
    hooksDoc = JSON.parse(fs.readFileSync(HOOKS_JSON_PATH, 'utf8'));
    registered = collectRegisteredHooks(hooksDoc);

    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-envelope-smoke-'));
    execFileSync('git', ['init', '-b', 'main'], { cwd: tempRepo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'smoke@example.com'], { cwd: tempRepo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Smoke Test'], { cwd: tempRepo, stdio: 'ignore' });
    fs.writeFileSync(path.join(tempRepo, 'README.md'), '# Smoke Repo\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: tempRepo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'chore: init smoke repo'], { cwd: tempRepo, stdio: 'ignore' });
  });

  after(() => {
    if (tempRepo) {
      fs.rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  it('hooks.json registers exactly 9 hook commands and all are covered below', () => {
    assert.equal(registered.length, 9, `Expected 9 registered hooks, found ${registered.length}`);
    const groups = new Set(registered.map((r) => r.group));
    const expectedGroups = [
      'git-guard',
      'question-suppression',
      'session-context',
      'drift-nudge',
      'stop-block',
      'state-save',
      'plan-integrity-guard',
      'jira-write-guard',
      'validation-guard',
    ];
    for (const g of expectedGroups) {
      assert.ok(groups.has(g), `Missing expected hook group "${g}" in hooks.json`);
    }
  });

  it('SessionStart (session-context) emits valid injectSteps systemMessage or {}', () => {
    const hook = registered.find((r) => r.group === 'session-context');
    const res = spawnHook(hook.command, {
      cwd: tempRepo,
      workspacePaths: [tempRepo],
      sessionId: 'smoke-session-1',
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout.trim());
    assertValidSystemMessageOrEmpty(parsed, 'session-context');
  });

  it('PostInvocation (drift-nudge) emits valid injectSteps systemMessage or {}', () => {
    const hook = registered.find((r) => r.group === 'drift-nudge');
    const res = spawnHook(hook.command, {
      cwd: tempRepo,
      workspacePaths: [tempRepo],
      sessionId: 'smoke-session-1',
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout.trim());
    assertValidSystemMessageOrEmpty(parsed, 'drift-nudge');
  });

  it('PreToolUse (git-guard) allows safe run_command and denies force push', () => {
    const hook = registered.find((r) => r.group === 'git-guard');
    const allowRes = spawnHook(hook.command, {
      cwd: tempRepo,
      workspacePaths: [tempRepo],
      toolCall: { name: 'run_command', args: { CommandLine: 'git status' } },
    });
    assert.equal(allowRes.status, 0, `stderr: ${allowRes.stderr}`);
    const allowParsed = JSON.parse(allowRes.stdout.trim());
    assertValidDecisionEnvelope(allowParsed, 'git-guard allow');
    assert.equal(allowParsed.decision, 'allow');

    const denyRes = spawnHook(hook.command, {
      cwd: tempRepo,
      workspacePaths: [tempRepo],
      toolCall: { name: 'run_command', args: { CommandLine: 'git push --force origin main' } },
    });
    assert.equal(denyRes.status, 0, `stderr: ${denyRes.stderr}`);
    const denyParsed = JSON.parse(denyRes.stdout.trim());
    assertValidDecisionEnvelope(denyParsed, 'git-guard deny');
    assert.equal(denyParsed.decision, 'deny');
  });

  it('PreToolUse (question-suppression) emits valid decision for ask_question', () => {
    const hook = registered.find((r) => r.group === 'question-suppression');
    const res = spawnHook(hook.command, {
      cwd: tempRepo,
      workspacePaths: [tempRepo],
      toolCall: {
        name: 'ask_question',
        args: {
          questions: [{ question: 'Choose a format', options: ['JSON', 'YAML'] }],
        },
      },
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout.trim());
    assertValidDecisionEnvelope(parsed, 'question-suppression');
    assert.equal(parsed.decision, 'allow');
  });

  it('PreToolUse (validation-guard) emits valid decision for write_to_file', () => {
    const hook = registered.find((r) => r.group === 'validation-guard');
    const res = spawnHook(hook.command, {
      cwd: tempRepo,
      workspacePaths: [tempRepo],
      toolCall: {
        name: 'write_to_file',
        args: {
          TargetFile: path.join(tempRepo, 'notes.md'),
          CodeContent: '# Smoke Notes\n',
        },
      },
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout.trim());
    assertValidDecisionEnvelope(parsed, 'validation-guard');
    assert.equal(parsed.decision, 'allow');
  });

  it('PreToolUse (jira-write-guard) denies without approval token and allows with fresh paired artifacts', () => {
    const hook = registered.find((r) => r.group === 'jira-write-guard');
    const tempStore = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-guard-smoke-'));
    const payload = {
      cwd: tempRepo,
      workspacePaths: [tempRepo],
      toolCall: {
        name: 'mcp_atlassian_createJiraIssue',
        args: { projectKey: 'DEMO', summary: 'Smoke test issue' },
      },
    };

    try {
      // (a) Fail-closed deny when no approval token exists
      const denyRes = spawnHook(hook.command, payload, {
        SDLC_JIRA_STORE_DIR_OVERRIDE: tempStore,
      });
      assert.equal(denyRes.status, 0, `stderr: ${denyRes.stderr}`);
      const denyParsed = JSON.parse(denyRes.stdout.trim());
      assertValidDecisionEnvelope(denyParsed, 'jira-write-guard deny');
      assert.equal(denyParsed.decision, 'deny');

      // (b) Allow when a fresh paired approval-<hash>.token + critique-<hash>.json exists
      const testHash = 'a'.repeat(64);
      fs.writeFileSync(
        path.join(tempStore, `critique-${testHash}.json`),
        JSON.stringify({ initial: 'draft', findings: [], final: 'draft' }),
        'utf8'
      );
      fs.writeFileSync(
        path.join(tempStore, `approval-${testHash}.token`),
        String(Date.now()),
        'utf8'
      );

      const allowRes = spawnHook(hook.command, payload, {
        SDLC_JIRA_STORE_DIR_OVERRIDE: tempStore,
      });
      assert.equal(allowRes.status, 0, `stderr: ${allowRes.stderr}`);
      const allowParsed = JSON.parse(allowRes.stdout.trim());
      assertValidDecisionEnvelope(allowParsed, 'jira-write-guard allow');
      assert.equal(allowParsed.decision, 'allow');
    } finally {
      fs.rmSync(tempStore, { recursive: true, force: true });
    }
  });

  for (const stopGroup of ['stop-block', 'state-save', 'plan-integrity-guard']) {
    it(`Stop (${stopGroup}) emits valid decision envelope`, () => {
      const hook = registered.find((r) => r.group === stopGroup);
      const res = spawnHook(hook.command, {
        cwd: tempRepo,
        workspacePaths: [tempRepo],
        terminationReason: 'NO_TOOL_CALL',
        continuationActive: false,
      });
      assert.equal(res.status, 0, `stderr: ${res.stderr}`);
      const parsed = JSON.parse(res.stdout.trim());
      assertValidDecisionEnvelope(parsed, stopGroup);
      assert.equal(parsed.decision, 'allow');
    });
  }
});
