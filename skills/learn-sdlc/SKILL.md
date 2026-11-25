---
name: learn-sdlc
description: "Use this skill to assimilate recurring learning changesets into new plan/execute guardrails — a human-gated loop that reads the pending changesets under .sdlc/learnings/pending/, proposes guardrail additions only for signatures that met the recurrence threshold, applies them to .sdlc/config.json on a throwaway assimilation branch behind a strengthen-only regression gate, attaches a read-only pre-screen assessment, and opens a PR for a human to merge or reject. Strengthen-only: never relaxes, rewrites, or removes an existing guardrail. Arguments: [--reject <pr>] [--stale]. Triggers on: assimilate learnings, learn from learnings, promote learnings to guardrails, run the self-learning loop, reject an assimilation PR, stale guardrail report, learn-sdlc."
user-invocable: true
argument-hint: "[--reject <pr>] [--stale]"
---

# Assimilating Learnings Into Guardrails

This skill closes the self-learning loop: recurring learning changesets accumulate under `.sdlc/learnings/pending/`, and once the same `signature` recurs enough times this skill turns it into a brand-new **plan** or **execute** guardrail in `.sdlc/config.json` — proposed by a read-only subagent, applied by this skill body, gated mechanically by a strengthen-only regression check, pre-screened by a second read-only subagent, and finally merged or rejected by a **human** on a PR.

**Announce at start:** "I'm using learn-sdlc (sdlc v{sdlc_version})." — extract the version from the `sdlc:` line in the session-start system-reminder. If no version is in context, omit the parenthetical.

**Where the guardrails land:** every addition goes into `.sdlc/config.json`'s `plan.guardrails` or `execute.guardrails` array, reaching **`plan-sdlc` and `execute-plan-sdlc` only** — never `review-sdlc` or `.sdlc/review-dimensions/`.

**Write ownership:** this SKILL.md is the *only* writer of `.sdlc/config.json` in the assimilation path (Step 4). Neither subagent can write — both declare `tools: view_file` with no write-capable tool — and no script in this flow synthesizes the mutation. Scripts only prepare, validate, roll back, commit, and push what this body wrote.

---

## Step 0 — Parse Arguments and Route

| Invocation | Route |
|---|---|
| `/learn-sdlc` (no arguments) | The assimilation run — Steps 1 through 10 below |
| `/learn-sdlc --reject <pr>` | Read [`./resources/subcommands-and-recovery.md`](./resources/subcommands-and-recovery.md) and execute **Subcommand: `--reject <pr>`** |
| `/learn-sdlc --stale` | Read [`./resources/subcommands-and-recovery.md`](./resources/subcommands-and-recovery.md) and execute **Subcommand: `--stale`** |

`--reject` and `--stale` are mutually exclusive with each other and with the assimilation run. If both are present, stop with an error message and run nothing. Do not run Steps 1–10 on either subcommand route.

---

## Step 1 — CONSUME: Run the Prepare Script

> **VERBATIM** — Execute this command directly with `node` and the absolute plugin path (replace `<PLUGIN_ROOT>` with the absolute path to this plugin; CLI location pattern: `<PLUGIN_ROOT>/scripts/<skill|util|lib>/<script-name>.js`). Do not modify, rephrase, or simplify the flags.

```shell
MANIFEST_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/learn-prepare.js" --output-file)
EXIT_CODE_PREPARE=$?
```
> **Contract (Input/Output):**
> - **Input**: none — discovers pending changesets, `learn.recurrenceThreshold` (default 3), default branch, and current branch.
> - **Output**: prints the temp-file location of the JSON assimilation manifest on stdout (`MANIFEST_FILE`), with exit status `EXIT_CODE_PREPARE`.

The script fetches `origin/<defaultBranch>`, enforces a clean tree, snapshots `.sdlc/config.json`, filters pending changesets against `rejected_guardrails` on the default branch and the recurrence threshold, and — **only when at least one signature is eligible** — creates `sdlc/assimilation-<timestamp>` off `origin/<defaultBranch>`. Pending changesets stay untracked until Step 8.

**On non-zero `EXIT_CODE_PREPARE`:** exit 1 surfaces `errors[]` from `MANIFEST_FILE`; exit 2 surfaces stderr (crash — do not re-dispatch). Clean up (**Step 10**) and stop without running `learn-apply.js --abort` (no branch exists). See [`./resources/subcommands-and-recovery.md`](./resources/subcommands-and-recovery.md).

---

## Step 2 — Read the Thin Manifest Slice and Gate

Read **only** these fields from `MANIFEST_FILE`:

- `eligible[].signature`, `eligible[].impact`, and the `eligible`/`waiting`/`skipped` **counts** — never the entries' full bodies
- `branchName`, `initialBranch`, `defaultBranch`, `preImageStatus`
- `errors[]`

**Do not read `preImage` or full `eligible[].files` contents into the main context, ever.** Those heavy fields exist in the manifest for the two subagents.

Display the counts:

```
learn-sdlc: assimilation manifest loaded
  Eligible signatures: {eligible.length}
  Waiting (below threshold): {waiting.length}
  Skipped (malformed or rejected): {skipped.length}
  Assimilation branch: {branchName or "—"}
```

**If `eligible` is empty:** report `waiting` and `skipped` counts (plus each `skipped` entry's `filePath` and `reason`), state nothing met the threshold, clean up (**Step 10**) and stop. No branch was created (`branchName` is `null`), so no rollback is needed.

**Recovery window (Steps 2 through 7):** From here on, `manifest.branchName` exists. Any non-success outcome in **Steps 3, 4, 6, or 7** (Step 5 excluded — it has its own exit-code handling) must roll back via `learn-apply.js --abort` (passing `--manifest "$MANIFEST_FILE"`), then clean up (**Step 10**) and stop. On `--abort` exit 2, surface `MANUAL RECOVERY REQUIRED` verbatim without retrying. The window closes at the end of Step 7. Full recovery command, contracts, and edge branches are in [`./resources/subcommands-and-recovery.md`](./resources/subcommands-and-recovery.md).

---

## Step 3 — SYNTHESIZE: Dispatch the learn-synthesis-orchestrator Subagent

Dispatch before any file is written. The agent proposes; it cannot apply.

Use `invoke_subagent` with:

```json
{
  "Subagents": [
    {
      "TypeName": "learn-synthesis-orchestrator",
      "Role": "Guardrail synthesis",
      "Model": "pro",
      "Prompt": "MANIFEST_FILE: <FILE>\nPROJECT_ROOT: <cwd>"
    }
  ]
}
```

Substitute `<FILE>` with `MANIFEST_FILE` from Step 1 and `<cwd>` with the current working directory.

The agent returns ONLY a JSON object in this exact shape:

```json
{
  "additions": [
    {
      "section": "plan | execute",
      "guardrail": { "id": "kebab-case-id", "description": "string", "severity": "error | warning" },
      "signature": "the eligible entry's exact signature"
    }
  ]
}
```

Capture as `PROPOSAL`. **No file has been written yet.**

- If JSON parsing fails or `additions` is missing: Step 3 failure — run `--abort` per the recovery window, clean up (**Step 10**), and stop. Do not retry or hand-repair the JSON.
- If `PROPOSAL.additions` is empty: report nothing warranted a guardrail, run `--abort` per the recovery window, clean up (**Step 10**), and stop.

---

## Step 4 — APPLY: Write the Proposal Into `.sdlc/config.json`

**This step is owned by this skill body and by nothing else in the flow.** Apply `PROPOSAL.additions` to `<cwd>/.sdlc/config.json` on the checked-out assimilation branch (`manifest.branchName`).

Choose the tool by `manifest.preImageStatus` (`'error'` fails closed in Step 1):

| `preImageStatus` | Tool | Why |
|---|---|---|
| `absent` | `Write` / `write_to_file` | File does not exist yet on the assimilation branch |
| `resolved` | `Edit` / `replace_file_content` | File exists; an in-place edit keeps untouched bytes identical |

**How to apply each addition:**

1. Append each `entry.guardrail` (`{id, description, severity}` verbatim — no added, renamed, or dropped fields) to the end of `<entry.section>.guardrails[]`.
2. When `preImageStatus === 'absent'`, write a new JSON document containing only sections receiving additions, e.g. `{"plan": {"guardrails": [...]}, "execute": {"guardrails": [...]}}`.
3. When `preImageStatus === 'resolved'`, **append only**. Never reorder, reword, re-key, re-severity, or remove an existing guardrail, and never touch any other section. Step 5's gate diffs every pre-existing id against `preImage`.
4. Never write a `rejected_guardrails` entry here (`learn-reject.js` owns that list).
5. Keep the file valid JSON, 2-space indented, with a trailing newline.

If the write fails or `.sdlc/config.json` is invalid JSON: Step 4 failure — run `--abort` per the recovery window, clean up (**Step 10**), and stop.

---

## Step 5 — VALIDATE: Run the Mechanical Gate

> **VERBATIM** — Execute this command directly with `node` and the absolute plugin path. Do not modify, rephrase, or simplify the flags.

```shell
REGRESSION_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/learn-apply.js" \
  --validate \
  --manifest "$MANIFEST_FILE")
EXIT_CODE_VALIDATE=$?
```
> **Contract (Input/Output):**
> - **Input**: `--validate --manifest <path>` — reads post-synthesis `.sdlc/config.json` from disk.
> - **Output**: on exit 0, prints the temp-file path of the JSON regression result (`REGRESSION_FILE`), with exit status `EXIT_CODE_VALIDATE`.

`--validate` checks guardrail schema for `plan` and `execute`, then runs the strengthen-only regression diff against `manifest.preImage`, leaving the working tree in place for Step 8.

- **Exit 0:** continue to Step 6 with `REGRESSION_FILE`.
- **Exit 1:** failed and **already** rolled back `.sdlc/config.json` and checked out `manifest.initialBranch`. Surface stderr, clean up (**Step 10**), and **stop** — do **not** dispatch `learn-review-only`, do **not** run `--ship`, and do **not** run `--abort`.
- **Exit 2:** automatic rollback failed. Surface `MANUAL RECOVERY REQUIRED` stderr **verbatim**, note the repo may still be on the assimilation branch with modified `.sdlc/config.json`, clean up (**Step 10**), and stop — do not attempt `--abort`. See [`./resources/subcommands-and-recovery.md`](./resources/subcommands-and-recovery.md).

---

## Step 6 — PRE-SCREEN: Dispatch the learn-review-only Subagent

Reached **only** after `--validate` exited 0.

Use `invoke_subagent` with:

```json
{
  "Subagents": [
    {
      "TypeName": "learn-review-only",
      "Role": "Guardrail assessment",
      "Model": "flash",
      "Prompt": "MANIFEST_FILE: <FILE>\nPROJECT_ROOT: <cwd>"
    }
  ]
}
```

Substitute `<FILE>` with `MANIFEST_FILE` and `<cwd>` with the current working directory. Pass nothing else: the agent compares `manifest.preImage` against on-disk `.sdlc/config.json`.

The agent returns bare assessment text (no JSON, no code fence). Capture as `ASSESSMENT`. **No file has been written yet.** The assessment is advisory and cannot approve, block, or modify anything. If the dispatch fails or returns nothing usable: Step 6 failure — run `--abort` per the recovery window, clean up (**Step 10**), and stop.

---

## Step 7 — Write the Assessment to the Pinned Path

Pin the path so Steps 7, 8, and 10 reference the **same** file:

```shell
ASSESSMENT_FILE=$(node -e "process.stdout.write(require('<PLUGIN_ROOT>/scripts/lib/output.js').createOutputFile('sdlc-learn-assessment'))")
```

Write `ASSESSMENT` to `ASSESSMENT_FILE` with this skill's own write tool (`Write` / `write_to_file`) — verbatim, with no added heading, fence, or commentary (`--ship` fences it safely).

If the write fails: Step 7 failure — run `--abort` per the recovery window, clean up (**Step 10**), and stop. **Step 7 is the last step the recovery window covers.**

---

## Step 8 — SHIP: Commit, Push, Open the PR

> **VERBATIM** — Execute this command directly with `node` and the absolute plugin path. Do not modify, rephrase, or simplify the flags.

```shell
PR_URL=$(node "<PLUGIN_ROOT>/scripts/skill/learn-apply.js" \
  --ship \
  --manifest "$MANIFEST_FILE" \
  --assessment-file "$ASSESSMENT_FILE" \
  --regression-file "$REGRESSION_FILE")
EXIT_CODE_SHIP=$?
```
> **Contract (Input/Output):**
> - **Input**: `--ship --manifest <path> --assessment-file <path> --regression-file <path>` (all three required).
> - **Output**: PR URL on stdout (`PR_URL`); exit status `EXIT_CODE_SHIP`.

`--ship` stages **only** `.sdlc/config.json` by exact path, commits, pushes to `origin`, opens the PR (`## Assimilated signatures` → `## Regression check` → `## Review-only assessment`), and then deletes shipped pending changesets (post-PR deletion is non-fatal).

- **Exit 0:** show `PR_URL`, tell the user the addition(s) await a **human** merge decision, and note `/learn-sdlc --reject <pr>` declines them and updates the negative cache. Continue to Step 9.
- **Exit 1:** usage or wrong-branch error (nothing committed/pushed). Surface stderr, clean up (**Step 10**), and stop.
- **Exit 2:** surface the report **verbatim** (names `pre-stage`, `staged-not-committed`, `committed-not-pushed`, or `pushed-no-pr` and exact manual recovery). **Do not run `--abort`**, do not invent recovery, and do not re-run `--ship`. Clean up (**Step 10**) and stop. See [`./resources/subcommands-and-recovery.md`](./resources/subcommands-and-recovery.md).

---

## Step 9 — Return to the Initial Branch

Reached **only** after `--ship` exited 0 (`--ship` deliberately ends on the assimilation branch). Run via `run_command` / `Bash`:

```shell
git checkout "<initialBranch>"
```

Substitute `<initialBranch>` with `manifest.initialBranch`. If checkout fails, report the failure and actual branch (the PR is unaffected), never force checkout, and continue to Step 10.

---

## Step 10 — Clean Up

Delete all three temp files on **every** exit path (success, cancel, and every failure branch) after the last step that reads them:

```shell
rm -f "$MANIFEST_FILE" "$REGRESSION_FILE" "$ASSESSMENT_FILE"
```

Skip unset variables. Never delete `.sdlc/learnings/pending/` here (`--ship` and `learn-reject.js` own that disposal).

---

## Tool Access (Dual-Host)

| Purpose | Antigravity | Claude Code |
|---|---|---|
| Step 4 config mutation, Step 7 assessment write | `write_to_file` / `replace_file_content` | `Write` / `Edit` |
| Reading `MANIFEST_FILE`, `REGRESSION_FILE`, `.sdlc/config.json` | `view_file` | `Read` |
| Every `node …` / `git` / `rm -f` command | `run_command` | `Bash` |
| Steps 3 and 6 | `invoke_subagent` | `Agent` / `subagent_type` |

Both subagents declare `tools: view_file` with no write tool and no `run_command`/`Bash` under either host.

---

## DO NOT

- Do not read `manifest.preImage`, or the bodies of `manifest.eligible[].files`, into the main context. The thin slice in Step 2 is the whole main-context budget; the heavy fields exist for the two subagents.
- Do not let a subagent write `.sdlc/config.json`. Step 4 is this body's job, and neither agent holds a write tool to do it with.
- Do not dispatch `learn-review-only`, or invoke `--ship`, when `--validate` exited non-zero. That ordering is the whole reason `learn-apply.js` is split in two.
- Do not run `learn-apply.js --abort` after Step 8 has invoked `--ship`, and do not run it after `--validate` exited 1 (the script already rolled back) or 2 (manual recovery is required).
- Do not skip Step 9's `git checkout "<initialBranch>"` after a successful `--ship`.
- Do not modify, reword, reorder, re-severity, or remove an existing guardrail. This loop is strengthen-only: additions, and nothing else.
- Do not write `rejected_guardrails` from this skill. `learn-reject.js` owns that list.
- Do not add an assimilated guardrail to `.sdlc/review-dimensions/` or otherwise route it at `review-sdlc`. Guardrails reach `plan-sdlc` and `execute-plan-sdlc` only.
- Do not stage, commit, or delete anything under `.sdlc/learnings/pending/` yourself.
- Do not use `git add -A`, `git add .`, `git push --force`, or `git reset --hard` anywhere on any path in this flow.
- Do not leave the manifest, regression-result, or assessment temp file behind on any exit path — Step 10 runs on success and on failure alike.
- Do not retry a failed subagent dispatch, hand-repair a malformed `additions` payload, or re-run `--ship`.

---

## See Also

- [`./resources/subcommands-and-recovery.md`](./resources/subcommands-and-recovery.md) — `--reject <pr>`, `--stale`, and detailed rollback-window / failure-branch rules
- `scripts/skill/learn-prepare.js` — manifest, eligibility, pre-image, assimilation branch
- `scripts/skill/learn-apply.js` — the `--validate` / `--abort` / `--ship` three-mode CLI
- `scripts/skill/learn-reject.js` — the negative-cache writer behind `--reject <pr>`
- `scripts/util/learn-stale.js` — the advisory staleness report behind `--stale`
- `scripts/ci/validate-guardrail-regression.js` — the strengthen-only diff `--validate` runs
- `agents/learn-synthesis-orchestrator.md` — Step 3's proposal agent
- `agents/learn-review-only.md` — Step 6's pre-screen agent
- `docs/self-learning/self-learning-adr.md` — architecture decisions for this loop
- [`/harden-sdlc`](../harden-sdlc/SKILL.md) — the single-failure, user-approved sibling of this loop
- [`/setup-sdlc`](../setup-sdlc/SKILL.md) — initial guardrail authoring and `learn.*` configuration
