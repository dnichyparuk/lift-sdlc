# Phase 2 (`agy`-Native Optimization) Implementation Plan

**Goal:** Achieve 0 errors and 0 warnings in `agy plugin validate .`, eliminate silent 24 KB `SKILL.md` truncations across all 9 oversized skills, flatten `ship.py` to strict Depth 1 via namespace-isolated Python coroutine loading, add consumer-only `rules/AGENTS.md` and `assets/logo.svg`, replace pure-filesystem/graph plan critique lanes (`G3`, `G4`, `G10`, `G12`) with deterministic Node checks, wire `.sdlc/local.json` `execute` override precedence into `config.js` and `execute.py`, and add hermetic hook/workflow smoke tests.
**Architecture:** Four-wave parallel plan with zero intra-wave file overlap and at most one `Risk: High` task per wave. Wave 1 builds foundational rules, config precedence, deterministic plan static critique, and smoke harnesses; Wave 2 exposes reusable Python workflow coroutines and trims the first 5 oversized `SKILL.md` files; Wave 3 unifies `ship.py` to Depth 1 and trims `execute-plan-sdlc` and `received-review-sdlc`; Wave 4 trims `ship-sdlc` and enables the strict 24 KB / 0-warning validation gate.
**Source:** Argon Architect Reviewer (`pro` tier) assessment of `lift-sdlc` v0.27.2 on Antigravity CLI `agy` v1.5.17 (building on Phase 1 P0–P2 alignment).
**Verification:** `npm test && npm run lint && npm run check:all && npm run test:learning-loop && python3 -m py_compile skills/*/workflows/*.py && agy plugin validate .`

---

## Wave 1 — Foundations, Rules, Config Precedence, Static Gates & Smoke Harnesses

### Task 1: Create consumer-only `rules/AGENTS.md` and `assets/logo.svg`

**Complexity:** Trivial
**Risk:** Low
**Depends on:** none
**Verify:** agy plugin validate .
**Files:**
- Create: `rules/AGENTS.md`
- Create: `assets/logo.svg`

**Description:**
Keep root `AGENTS.md` untouched for plugin contributors, and create a minimal consumer-only `rules/AGENTS.md` (<1.5 KB, ~30 lines) enforcing strictly universal runtime invariants (Plan mode routes to `/plan-sdlc`, never autonomously add `- [~]` skipped checkboxes, never stage `.sdlc/` runtime artifacts, always pass explicit `--plan <path>` to `/execute-plan-sdlc` and `/ship-sdlc`). Add a clean SVG icon at `assets/logo.svg` and reference `"logo": "assets/logo.svg"` in `plugin.json`.

**Acceptance criteria:**
- [x] `rules/AGENTS.md` exists, is ≤ 2,048 bytes, and contains zero contributor-only repo rules (`npm run check:all`, `docs/changes-log.md`, etc.)
- [x] `assets/logo.svg` exists as a valid SVG and is wired in `plugin.json`
- [x] `agy plugin validate .` reports `rules 1` and emits zero logo/rules warnings

### Task 2: Wire `.sdlc/local.json` `execute` override precedence in `scripts/lib/config.js`

**Complexity:** Standard
**Risk:** Medium
**Depends on:** none
**Verify:** node --test scripts/lib/config.test.js
**Files:**
- Modify: `scripts/lib/config.js`
- Modify: `scripts/lib/config.test.js`

**Description:**
Update `readSection(root, 'execute')` in `scripts/lib/config.js` to merge `.sdlc/local.json`'s `execute` section over `.sdlc/config.json`, deep-merging nested `priorWaveContextCaps` so local caps do not erase sibling project caps or `guardrails[]`. Add a local-safe write path (`{ target: 'local' }` or `writeLocalSection`) so developer `standardWorkerEnum` never leaks into tracked `.sdlc/config.json`.

**Acceptance criteria:**
- [x] `readSection(root, 'execute')` returns `.sdlc/local.json` `standardWorkerEnum` and deep-merged `priorWaveContextCaps` over `.sdlc/config.json` while preserving project `guardrails[]`
- [x] Writing local `execute` overrides updates `.sdlc/local.json` without mutating `.sdlc/config.json`
- [x] Unit tests in `scripts/lib/config.test.js` cover precedence, deep-merge, and local write isolation

### Task 3: Replace pure-filesystem/graph plan critique lanes (`G3`, `G4`, `G10`, `G12`) with deterministic Node checks

**Complexity:** Standard
**Risk:** Medium
**Depends on:** none
**Verify:** node --test scripts/lib/plan-static-critique.test.js scripts/ci/validate-plan-format.test.js scripts/skill/plan.test.js
**Files:**
- Create: `scripts/lib/plan-static-critique.js`
- Create: `scripts/lib/plan-static-critique.test.js`
- Modify: `scripts/ci/validate-plan-format.js`
- Modify: `scripts/skill/plan.js`
- Modify: `skills/plan-sdlc/resources/lane-static-structural-prompt.md`

**Description:**
Share `extractTasks`, `extractField`, and `checkPF4` from `scripts/ci/validate-plan-format.js` into `scripts/lib/plan-static-critique.js`. Implement deterministic `G3` (DAG cycles), `G4` (shared `Modify:` files without explicit `Depends on:` ordering), `G10` (`Modify:` exists on disk or in earlier `Create:`), and `G12` (missing dependency targets). Add `plan.js --critique-static --plan <path>` emitting `{ gateIds: ["G3", "G4", "G10", "G12"], issues, passes, laneStatus: "ok" }`, drop `file-existence` from `buildLanes()`, and narrow `static-structural` to `{G1, G2, G7}` (`gemini-4-hydrogen-medium` / `flash`).

**Acceptance criteria:**
- [x] `node scripts/skill/plan.js --critique-static --plan <path>` evaluates `G3`, `G4`, `G10`, and `G12` deterministically with 0 LLM calls
- [x] `buildLanes()` no longer emits `file-existence` and narrows `static-structural` to `{G1, G2, G7}`
- [x] Unit tests cover cycle detection, missing deps, unsequenced shared `Modify:` conflicts, and missing/created-in-plan file existence

### Task 4: Harden CI link/schema checks and add hermetic hook & workflow smoke tests

**Complexity:** Standard
**Risk:** Low
**Depends on:** none
**Verify:** node --test hooks/hook-envelope-smoke.test.js scripts/ci/workflow-smoke.test.js scripts/lib/discovery.test.js scripts/ci/validate-plugin-schema.test.js
**Files:**
- Modify: `scripts/lib/discovery.js`
- Modify: `scripts/ci/validate-plugin-schema.js`
- Create: `hooks/hook-envelope-smoke.test.js`
- Create: `scripts/ci/workflow-smoke.test.js`

**Description:**
Extend `checkPD5` in `scripts/lib/discovery.js` to validate lowercase `./resources/*.md` links so extracted skill resources cannot dangle. Add a `--check-skill-size` flag (checking `<= 24,000` bytes on `SKILL.md` and `rules/AGENTS.md`) and 0-warning `agy` output validation to `scripts/ci/validate-plugin-schema.js`. Create offline hermetic `hooks/hook-envelope-smoke.test.js` (spawning all 9 hooks with camelCase `agy` v1.5+ payloads) and `scripts/ci/workflow-smoke.test.js` (Python harness mocking `call_tool("run_command", ...)` and `agent()`).

**Acceptance criteria:**
- [x] `checkPD5` validates `./resources/*.md` references across all skills
- [x] `hooks/hook-envelope-smoke.test.js` verifies all 9 `hooks.json` scripts emit valid `agy` v1.5+ JSON envelopes
- [x] `scripts/ci/workflow-smoke.test.js` verifies `py_compile` and mocked `call_tool("run_command", ...)` / `agent()` execution across all 4 workflows

---

## Wave 2 — Reusable Python Coroutines, Runtime Wiring & First 5 `SKILL.md` Trims

### Task 5: Expose reusable Python workflow coroutines and wire `standardWorkerEnum` into `execute.py`

**Complexity:** Complex
**Risk:** Medium
**Depends on:** Task 2
**Verify:** python3 -m py_compile skills/execute-plan-sdlc/workflows/execute.py skills/review-sdlc/workflows/review.py skills/received-review-sdlc/workflows/verify.py && node --test scripts/ci/workflow-smoke.test.js
**Files:**
- Modify: `scripts/util/execute-context-advisory.js`
- Modify: `skills/execute-plan-sdlc/workflows/execute.py`
- Modify: `skills/review-sdlc/workflows/review.py`
- Modify: `skills/received-review-sdlc/workflows/verify.py`

**Description:**
Add a non-breaking `--meta` flag to `scripts/util/execute-context-advisory.js` returning `{ guardrails, advisory, standardWorkerEnum, priorWaveContextCaps }` from `readSection(cwd, 'execute')`. Refactor `execute.py`, `review.py`, and `verify.py` to export `async def run_execute(wf_args, cwd, plugin_root)`, `run_review(...)`, and `run_verify(...)` called by `main()`, and wire `execute.py` to resolve `standardWorkerEnum` from `--meta` / `wf_args` before defaulting to `"pro"`.

**Acceptance criteria:**
- [x] All 3 Python workflows expose `run_<name>(...)` coroutines callable both standalone via `main()` and via namespace-isolated `exec()`
- [x] `execute.py` honors `execute.standardWorkerEnum: "inherit"` from `.sdlc/local.json` / `.sdlc/config.json` via `--meta`
- [x] All 3 workflows pass `py_compile` and `workflow-smoke.test.js`

### Task 6: Wire `plan.js --critique-static` into `plan-sdlc/SKILL.md` and trim below 20 KB

**Complexity:** Standard
**Risk:** Medium
**Depends on:** Task 3
**Verify:** npm run check:refs && npm run check:discovery
**Files:**
- Modify: `skills/plan-sdlc/SKILL.md`
- Create: `skills/plan-sdlc/resources/openspec-and-handoff-details.md`

**Description:**
Update `skills/plan-sdlc/SKILL.md` Step 3 to invoke `node "<PLUGIN_ROOT>/scripts/skill/plan.js" --critique-static --plan "<PLAN_FILE_PATH>"` for `{G3, G4, G10, G12}` alongside the remaining semantic lanes covering `{G1..G17}`. Move cold OpenSpec/handoff edge matrices to `skills/plan-sdlc/resources/openspec-and-handoff-details.md` while keeping Steps 0–7 happy path and `DO NOT` inline.

**Acceptance criteria:**
- [x] `skills/plan-sdlc/SKILL.md` is ≤ 20,480 bytes
- [x] Step 3 runs `plan.js --critique-static` and merges `{G1..G17}` by lane name
- [x] `npm run check:refs` and `npm run check:discovery` pass with 0 broken links

### Task 7: Trim `jira-sdlc/SKILL.md` below 20 KB

**Complexity:** Standard
**Risk:** Low
**Depends on:** Task 4
**Verify:** npm run check:refs && npm run check:discovery
**Files:**
- Modify: `skills/jira-sdlc/SKILL.md`
- Create: `skills/jira-sdlc/resources/operations-and-telemetry.md`

**Description:**
Move verbose bulk-op examples, `--init-templates` walkthroughs, and multi-site edge cases to `skills/jira-sdlc/resources/operations-and-telemetry.md`, keeping cache lookup, write-guard artifact gate (`Step 2.5–2.7`), `Quality Gates`, and `DO NOT` inline.

**Acceptance criteria:**
- [ ] `skills/jira-sdlc/SKILL.md` is ≤ 20,480 bytes
- [ ] Write-guard gate, `Quality Gates`, and `DO NOT` remain inline in `SKILL.md`
- [ ] `npm run check:refs` and `npm run check:discovery` pass

### Task 8: Trim `pr-sdlc/SKILL.md` below 20 KB

**Complexity:** Standard
**Risk:** Low
**Depends on:** Task 4
**Verify:** npm run check:refs && npm run check:discovery
**Files:**
- Modify: `skills/pr-sdlc/SKILL.md`
- Create: `skills/pr-sdlc/resources/label-inference-guide.md`

**Description:**
Move `pr.labels` off/rules/llm mode tables and custom PR template edge rules to `skills/pr-sdlc/resources/label-inference-guide.md`, keeping the 8-section template, `pr.js` prepare/link-gate `VERBATIM` blocks, and `DO NOT` inline.

**Acceptance criteria:**
- [x] `skills/pr-sdlc/SKILL.md` is ≤ 20,480 bytes
- [x] 8-section template, `VERBATIM` CLI blocks, and `DO NOT` remain inline
- [x] `npm run check:refs` and `npm run check:discovery` pass

### Task 9: Trim `setup-sdlc/SKILL.md` and `version-sdlc/SKILL.md` below 20 KB

**Complexity:** Standard
**Risk:** Low
**Depends on:** Task 4
**Verify:** npm run check:refs && npm run check:discovery
**Files:**
- Modify: `skills/setup-sdlc/SKILL.md`
- Modify: `skills/version-sdlc/SKILL.md`
- Create: `skills/setup-sdlc/resources/section-and-migration-guide.md`
- Create: `skills/version-sdlc/resources/branch-fallback-rules.md`

**Description:**
Move cold migration/section detail tables from `setup-sdlc/SKILL.md` and detailed Branch A/B edge narratives from `version-sdlc/SKILL.md` into `resources/`, keeping `--only`, pre-flight, config-write hard rules, and `DO NOT` inline.

**Acceptance criteria:**
- [ ] Both `skills/setup-sdlc/SKILL.md` and `skills/version-sdlc/SKILL.md` are ≤ 20,480 bytes
- [ ] `npm run check:refs` and `npm run check:discovery` pass

### Task 10: Trim `learn-sdlc/SKILL.md` below 20 KB

**Complexity:** Standard
**Risk:** Low
**Depends on:** Task 4
**Verify:** npm run test:learning-loop && npm run check:refs
**Files:**
- Modify: `skills/learn-sdlc/SKILL.md`
- Create: `skills/learn-sdlc/resources/subcommands-and-recovery.md`

**Description:**
Move `--reject <pr>`, `--stale`, and detailed rollback-window edge branches to `skills/learn-sdlc/resources/subcommands-and-recovery.md`, keeping Steps 1–8 core assimilation loop, write-ownership rules, and `DO NOT` inline.

**Acceptance criteria:**
- [ ] `skills/learn-sdlc/SKILL.md` is ≤ 20,480 bytes
- [ ] `npm run test:learning-loop` and `npm run check:refs` pass

---

## Wave 3 — `ship.py` Depth-1 Unification & Top-3 `SKILL.md` Trims

### Task 11: Unify `ship.py` to Depth 1 via namespace-isolated `exec()` coroutine loading

**Complexity:** Complex
**Risk:** High
**Depends on:** Task 4, Task 5
**Verify:** python3 -m py_compile skills/ship-sdlc/workflows/ship.py && node --test scripts/ci/workflow-smoke.test.js
**Files:**
- Modify: `skills/ship-sdlc/workflows/ship.py`
- Modify: `scripts/ci/workflow-smoke.test.js`

**Description:**
Load `execute.py::run_execute`, `review.py::run_review`, and `verify.py::run_verify` inside `skills/ship-sdlc/workflows/ship.py` using namespace-isolated `exec()` inheriting `run_workflow` primitives. Eliminate `agent(type_name="self", ...)` hops for `execute`, `review`, and `await-remote-review` Step 3 verification; propagate `high_risk_wave` `needs_consent` from `run_execute`; and run `fetch-logs.js` + `verify-pipeline-sdlc-classify.js` deterministically before spawning a CI fix agent on `always-proposal`. Keep a lean fix agent for local pre-PR `received-review` against `review-comment.md`.

**Acceptance criteria:**
- [ ] `ship.py` executes `execute`, `review`, and remote PR thread verification directly at Depth 1 without `agent(type_name="self", ...)`
- [ ] `high_risk_wave` consent pauses propagate cleanly back to `ship-sdlc`
- [ ] `verify-pipeline` classifies logs deterministically before spawning any LLM agent
- [ ] `py_compile` and expanded `workflow-smoke.test.js` pass

### Task 12: Trim `execute-plan-sdlc/SKILL.md` below 18 KB and wire `--meta`

**Complexity:** Standard
**Risk:** Medium
**Depends on:** Task 5
**Verify:** node --test 'skills/execute-plan-sdlc/**/*.test.js' && npm run check:refs
**Files:**
- Modify: `skills/execute-plan-sdlc/SKILL.md`
- Create: `skills/execute-plan-sdlc/resources/manual-wave-fallback.md`

**Description:**
Pass resolved `standard_worker_enum` / `prior_wave_context_caps` from `execute-context-advisory.js --meta` into `execute.py`, and move manual fallback Steps 2–8 to `skills/execute-plan-sdlc/resources/manual-wave-fallback.md`. Preserve `Plan Mode Check`, `Plan-argument gate`, `Post-compact recovery`, `Step 9` report, `DO NOT`, and every verbatim regex asserted by `skills/execute-plan-sdlc/plan-source.test.js`.

**Acceptance criteria:**
- [ ] `skills/execute-plan-sdlc/SKILL.md` is ≤ 18,432 bytes
- [ ] `skills/execute-plan-sdlc/plan-source.test.js` passes 100%
- [ ] `npm run check:refs` and `npm run check:discovery` pass

### Task 13: Trim `received-review-sdlc/SKILL.md` below 18 KB

**Complexity:** Standard
**Risk:** Medium
**Depends on:** Task 5
**Verify:** npm run check:refs && npm run check:discovery
**Files:**
- Modify: `skills/received-review-sdlc/SKILL.md`
- Create: `skills/received-review-sdlc/resources/verify-fallback-and-playbook.md`

**Description:**
Keep `Primary Dispatch` (`verify.py`), `Step 0/1a`, `alwaysFixSeverities` / `alwaysHardenFromReview`, Steps 4–12 consent/apply/link/reply hard gates, and `DO NOT` inline; move Step 1b/3a/3b legacy verifier instructions and Step 7 pushback examples into `skills/received-review-sdlc/resources/verify-fallback-and-playbook.md`.

**Acceptance criteria:**
- [ ] `skills/received-review-sdlc/SKILL.md` is ≤ 18,432 bytes
- [ ] All hard gates and `DO NOT` remain inline
- [ ] `npm run check:refs` and `npm run check:discovery` pass

---

## Wave 4 — Final `ship-sdlc` Router Trim, Strict 0-Warning Gate & Release Docs

### Task 14: Trim `ship-sdlc/SKILL.md` below 18 KB

**Complexity:** Standard
**Risk:** Medium
**Depends on:** Task 11
**Verify:** node --test scripts/skill/ship.test.js && npm run check:refs
**Files:**
- Modify: `skills/ship-sdlc/SKILL.md`
- Create: `skills/ship-sdlc/resources/legacy-ship-workflow.md`

**Description:**
Keep `Step 0`, `1a` (`--init-config`, `--gc`), `1a-engine` (`ship.py` and `pipeline-sdlc` routers), updated `needs_consent` handling (including `high_risk_wave` from `execute.py`), `Step 6` summary, and `DO NOT` inline; move `ship.engine === "legacy"` Steps 1b–5 prose into `skills/ship-sdlc/resources/legacy-ship-workflow.md`.

**Acceptance criteria:**
- [ ] `skills/ship-sdlc/SKILL.md` is ≤ 18,432 bytes
- [ ] `scripts/skill/ship.test.js`, `npm run check:refs`, and `npm run check:discovery` pass

### Task 15: Enable strict 24 KB / 0-warning validation gate and update docs

**Complexity:** Standard
**Risk:** Low
**Depends on:** Task 6, Task 7, Task 8, Task 9, Task 10, Task 12, Task 13, Task 14
**Verify:** agy plugin validate . && python3 -m py_compile skills/*/workflows/*.py && npm run check:all
**Files:**
- Modify: `scripts/ci/validate-plugin-schema.js`
- Modify: `docs/plugin-api-specs.md`
- Modify: `docs/changes-log.md`

**Description:**
Enable strict `<= 24,000` byte `SKILL.md` / `rules/AGENTS.md` and 0-warning `agy plugin validate` checks by default in `scripts/ci/validate-plugin-schema.js`, update `docs/plugin-api-specs.md` and `docs/changes-log.md`, and run the full exit verification suite.

**Acceptance criteria:**
- [ ] Every `skills/*/SKILL.md` and `rules/AGENTS.md` is ≤ 24,000 bytes
- [ ] `agy plugin validate .` exits 0 with **0 errors and 0 warnings**
- [ ] `python3 -m py_compile skills/*/workflows/*.py` and `npm run check:all` pass
