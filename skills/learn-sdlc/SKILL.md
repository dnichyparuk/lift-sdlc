---
name: learn-sdlc
description: "Use this skill to assimilate recurring learning changesets into new plan/execute guardrails — a human-gated loop that reads the pending changesets under .sdlc/learnings/pending/, proposes guardrail additions only for signatures that met the recurrence threshold, applies them to .sdlc/config.json on a throwaway assimilation branch behind a strengthen-only regression gate, attaches a read-only pre-screen assessment, and opens a PR for a human to merge or reject. Strengthen-only: never relaxes, rewrites, or removes an existing guardrail. Arguments: [--reject <pr>] [--stale]. Triggers on: assimilate learnings, learn from learnings, promote learnings to guardrails, run the self-learning loop, reject an assimilation PR, stale guardrail report, learn-sdlc."
user-invocable: true
argument-hint: "[--reject <pr>] [--stale]"
model: gemini-3.8-flash-medium
---

# Assimilating Learnings Into Guardrails

This skill closes the self-learning loop: recurring learning changesets accumulate
under `.sdlc/learnings/pending/`, and once the same `signature` recurs enough times
this skill turns it into a brand-new **plan** or **execute** guardrail in
`.sdlc/config.json` — proposed by a read-only subagent, applied by this skill body,
gated mechanically by a strengthen-only regression check, pre-screened by a second
read-only subagent, and finally merged or rejected by a **human** on a PR.

**Announce at start:** "I'm using learn-sdlc (sdlc v{sdlc_version})." — extract the version from the `sdlc:` line in the session-start system-reminder. If no version is in context, omit the parenthetical.

**Where the guardrails land:** every addition this skill ships goes into
`.sdlc/config.json`'s `plan.guardrails` or `execute.guardrails` array, and therefore
reaches **`plan-sdlc` and `execute-plan-sdlc` only**. It never reaches `review-sdlc` —
that skill consumes `.sdlc/review-dimensions/` instead, which this skill never touches.
An assimilated guardrail is a planning or execution rule, never a review dimension.

**Write ownership:** this SKILL.md is the *only* writer of `.sdlc/config.json` in the
assimilation path (Step 4). Neither subagent can write — both declare `tools: view_file`
and hold no write-capable tool — and no script in this flow synthesizes the mutation.
The scripts only prepare, validate, roll back, commit, and push what this body wrote.

---

## Step 0 — Parse Arguments and Route

| Invocation | Route |
|---|---|
| `/learn-sdlc` (no arguments) | The assimilation run — Steps 1 through 10 below |
| `/learn-sdlc --reject <pr>` | Skip to **Subcommand: `--reject <pr>`** |
| `/learn-sdlc --stale` | Skip to **Subcommand: `--stale`** |

`--reject` and `--stale` are mutually exclusive with each other and with the
assimilation run. If both are present, stop with an error message and run nothing.

---

## Step 1 — CONSUME: Run the Prepare Script

> **VERBATIM** — Execute this command directly with `node` and the absolute plugin path (replace `<PLUGIN_ROOT>` with the absolute path to this plugin. Note the strict CLI location pattern: `<PLUGIN_ROOT>/scripts/<skill|util|lib>/<script-name>.js`). Do not modify, rephrase, or simplify the flags.

```shell
MANIFEST_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/learn-prepare.js" --output-file)
EXIT_CODE_PREPARE=$?
```
> **Contract (Input/Output):**
> - **Input**: none — the script discovers the pending changesets, the recurrence threshold (`learn.recurrenceThreshold`, default 3), the default branch, and the current branch itself.
> - **Output**: prints the temp-file location of the JSON assimilation manifest on stdout; captured here as `MANIFEST_FILE`, with the command's exit status as `EXIT_CODE_PREPARE`.

The script fetches `origin/<defaultBranch>`, enforces the clean-tree precondition,
snapshots the `.sdlc/config.json` pre-image, filters the pending changesets against the
negative cache (`rejected_guardrails` on the default branch) and the recurrence
threshold, and — **only when at least one signature is eligible** — creates the
assimilation branch `sdlc/assimilation-<timestamp>` off `origin/<defaultBranch>`.

Pending changeset files stay **untracked** throughout: this script never stages,
commits, or deletes them. Their disposition happens in Step 8, after the PR opens.

**On non-zero `EXIT_CODE_PREPARE`:**

- Exit code 1: read `errors[]` from `MANIFEST_FILE`, surface them verbatim, then
  clean up (**Step 10**) and stop. No assimilation branch exists on this path
  (`branchName` is `null`), so there is nothing to abort — do **not** run
  `learn-apply.js --abort`.
- Exit code 2: the prepare script crashed. Surface stderr, clean up (**Step 10**),
  and stop. Do not re-dispatch this skill on its own crash.

---

## Step 2 — Read the Thin Manifest Slice and Gate

Read **only** these fields from `MANIFEST_FILE`:

- `eligible[].signature`, `eligible[].impact` and the `eligible`/`waiting`/`skipped`
  **counts** — never the entries' full bodies
- `branchName`, `initialBranch`, `defaultBranch`, `preImageStatus`
- `errors[]`

**Do not read `preImage` into the main context, ever.** It is the whole
`.sdlc/config.json` object and it exists in the manifest for the two subagents, which
read the manifest file themselves. Do not read the full `eligible[].files` contents
either — the synthesis agent reads those.

Display the counts:

```
learn-sdlc: assimilation manifest loaded
  Eligible signatures: {eligible.length}
  Waiting (below threshold): {waiting.length}
  Skipped (malformed or rejected): {skipped.length}
  Assimilation branch: {branchName or "—"}
```

**If `eligible` is empty:** report the `waiting` and `skipped` counts (and, for each
`skipped` entry, its `filePath` and `reason`), state that nothing met the recurrence
threshold, clean up (**Step 10**) and stop. `learn-prepare.js` created no branch in
that case (`branchName` is `null`), so there is nothing to roll back.

**From here on, the assimilation branch exists.** That opens the recovery window:

> ### Recovery window — Steps 2 through 7
>
> **Any** non-success outcome in Steps 3, 4, 6 or 7 — a failed or unparseable
> synthesis dispatch, a failed write of `.sdlc/config.json`, a failed review-only
> dispatch, or a failed write of the assessment file — is recovered by running:
>
> **Step 5 is excluded from this box** — `--validate`'s own non-zero exit has its
> own exit-code-specific recovery rules (see Step 5 below); do not apply the
> general `--abort` instruction below to a Step 5 failure.
>
> ```shell
> ABORT_OUTPUT=$(node "<PLUGIN_ROOT>/scripts/skill/learn-apply.js" \
>   --abort \
>   --manifest "$MANIFEST_FILE")
> EXIT_CODE_ABORT=$?
> ```
> > **Contract (Input/Output):**
> > - **Input**: `--abort --manifest <path>` — the manifest captured in Step 1.
> > - **Output**: nothing on stdout (progress and outcome go to stderr); exit 0 when the rollback completed or there was nothing to roll back (it is idempotent), exit 2 when the rollback itself could not be verified.
>
> `--abort` restores `.sdlc/config.json` (`preImageStatus`-aware: unlink when
> `'absent'`, `git checkout -- .sdlc/config.json` when `'resolved'`), returns to
> `manifest.initialBranch`, and leaves the pending changesets untouched. On its
> exit 2 it prints a `MANUAL RECOVERY REQUIRED` report — surface that **verbatim**;
> do not paraphrase it and do not retry.
>
> After the abort, clean up (**Step 10**) and stop.
>
> **The window closes at the end of Step 7.** Once Step 8 has invoked
> `learn-apply.js --ship`, `--abort` is no longer the recovery path: by then a commit
> and possibly a push and a PR exist, which `--abort`'s file-and-branch rollback
> cannot safely undo. Failures from Step 8 onward are reported by `--ship`'s own
> exit-2 output instead.

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
      "Model": "flash_lite",
      "Prompt": "MANIFEST_FILE: <FILE>\nPROJECT_ROOT: <cwd>"
    }
  ]
}
```

Substitute `<FILE>` with the absolute path captured in Step 1 (`MANIFEST_FILE`) and
`<cwd>` with the current working directory.

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

Capture it as `PROPOSAL`. **No file has been written at this point.**

- If JSON parsing fails, or the object does not carry an `additions` array: this is a
  Step 3 failure — run `--abort` per the recovery window, then stop. Do not retry the
  dispatch, and do not repair the JSON by hand.
- If `PROPOSAL.additions` is empty: nothing warranted a guardrail this run. Report
  that, run `--abort` per the recovery window (the branch exists and must not be left
  behind), clean up (**Step 10**), and stop.

---

## Step 4 — APPLY: Write the Proposal Into `.sdlc/config.json`

**This step is owned by this skill body and by nothing else in the flow.** Apply
`PROPOSAL.additions` to `<cwd>/.sdlc/config.json` on the currently checked-out
assimilation branch (`manifest.branchName`).

Choose the tool by `manifest.preImageStatus`:

| `preImageStatus` | Tool | Why |
|---|---|---|
| `absent` | `Write` / `write_to_file` | The file does not exist yet on the assimilation branch — `Edit`/`replace_file_content` has nothing to target |
| `resolved` | `Edit` / `replace_file_content` | The file exists and is being appended to; an in-place edit keeps every untouched byte byte-identical |

(`preImageStatus === 'error'` never reaches here — `learn-prepare.js` fails closed on
it in Step 1 and creates no branch.)

**How to apply each addition:**

1. For each entry in `PROPOSAL.additions`, append `entry.guardrail` (the
   `{id, description, severity}` object, verbatim — no added, renamed, or dropped
   fields) to the end of `<entry.section>.guardrails[]`.
2. When `preImageStatus === 'absent'`, write a complete new JSON document containing
   only the sections the additions require, e.g.
   `{"plan": {"guardrails": [...]}, "execute": {"guardrails": [...]}}`, omitting a
   section that received no addition.
3. When `preImageStatus === 'resolved'`, **append only**. Never reorder, reword,
   re-key, re-severity, or remove an existing guardrail, and never touch any other
   section. The mechanical gate in Step 5 diffs every pre-existing guardrail id
   against the pre-image and fails the run on anything that is not a pure addition.
4. Never write a `rejected_guardrails` entry here. That list belongs to
   `learn-reject.js` alone.
5. Keep the file valid JSON, 2-space indented, with a trailing newline.

If the write fails, or the resulting file is not valid JSON: this is a Step 4 failure —
run `--abort` per the recovery window, then stop.

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
> - **Input**: `--validate --manifest <path>` — the manifest captured in Step 1. The post-synthesis `.sdlc/config.json` is read from disk, never passed as an argument.
> - **Output**: on exit 0, prints the temp-file location of the JSON regression result and nothing else; captured here as `REGRESSION_FILE`, with the exit status as `EXIT_CODE_VALIDATE`.

`--validate` runs guardrail schema validation for both the `plan` and `execute`
sections first, then the strengthen-only regression diff against
`manifest.preImage`. It deliberately leaves the working tree in place for Step 8.

**On `EXIT_CODE_VALIDATE == 1`:** the check failed and the script has **already**
rolled back `.sdlc/config.json` and returned to `manifest.initialBranch`. Surface the
script's stderr (it names each violation), clean up (**Step 10**) and **stop**:

- Do **not** dispatch `learn-review-only`.
- Do **not** invoke `learn-apply.js --ship`.
- Do **not** run `learn-apply.js --abort` — the rollback already happened and the
  script reported it; a second rollback attempt is noise.

**On `EXIT_CODE_VALIDATE == 2`:** the automatic rollback did **not** succeed. The
stderr carries a `MANUAL RECOVERY REQUIRED` message — surface that message **verbatim**
to the user rather than treating it as a normal failure, tell them the repository is
still on the assimilation branch and/or still carries the modified
`.sdlc/config.json`, then clean up (**Step 10**) and stop. Do not attempt any
automatic recovery of your own, `--abort` included.

**Only on exit 0** does the flow continue to Step 6, with `REGRESSION_FILE` in hand.

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
      "Model": "flash_lite",
      "Prompt": "MANIFEST_FILE: <FILE>\nPROJECT_ROOT: <cwd>"
    }
  ]
}
```

Substitute `<FILE>` with `MANIFEST_FILE` and `<cwd>` with the current working
directory. Pass nothing else: the agent derives its own diff by comparing
`manifest.preImage` against the current on-disk `.sdlc/config.json`, which Step 4
already wrote and Step 5 already cleared.

The agent returns bare assessment text — no JSON, no code fence. Capture it as
`ASSESSMENT`. **No file has been written at this point.**

The assessment is advisory. It cannot approve, block, or modify anything; the merge
gate is the human on the PR. If the dispatch fails or returns nothing usable, this is a
Step 6 failure — run `--abort` per the recovery window, then stop.

---

## Step 7 — Write the Assessment to the Pinned Path

Steps 7, 8 and 10 must all name the **same** file, so pin the path before writing it:

```shell
ASSESSMENT_FILE=$(node -e "process.stdout.write(require('<PLUGIN_ROOT>/scripts/lib/output.js').createOutputFile('sdlc-learn-assessment'))")
```

That is `createOutputFile('sdlc-learn-assessment')` from `scripts/lib/output.js` — the
`sdlc-learn-assessment-<hash>` naming under the OS temp directory that the rest of the
plugin's manifests use. An explicit equivalent under `os.tmpdir()` is acceptable as
long as Steps 8 and 10 use that exact same value.

Write `ASSESSMENT` to `ASSESSMENT_FILE` with this skill's own write tool
(`Write` / `write_to_file`) — verbatim, exactly the text the agent returned, with no
added heading, fence, or commentary. `learn-apply.js --ship` fences it safely when it
renders the PR body.

If the write fails, this is a Step 7 failure — run `--abort` per the recovery window,
then stop. **Step 7 is the last step the recovery window covers.**

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
> - **Input**: `--ship --manifest <path> --assessment-file <path> --regression-file <path>` — the manifest from Step 1, the assessment file from Step 7, and the regression-result file printed by `--validate` in Step 5. All three are required.
> - **Output**: `gh`'s own PR URL on stdout, captured here as `PR_URL`; the exit status as `EXIT_CODE_SHIP`.

`--ship` stages **only** `.sdlc/config.json` by exact path, commits it, pushes the
assimilation branch to `origin`, opens the PR with a body ordered
`## Assimilated signatures` → `## Regression check` → `## Review-only assessment`
(fenced), and **then** deletes the shipped pending changeset files from disk. The
deletion is post-PR and non-fatal by design: the run has already succeeded, so a
leftover file is reported as a warning to remove by hand, never as a shipping failure.

**On non-zero `EXIT_CODE_SHIP`:**

- Exit 1: a usage error — a missing flag, or the working tree is not on
  `manifest.branchName`. Surface stderr, then treat it as an unrecoverable stop:
  clean up (**Step 10**) and report. Nothing was committed or pushed.
- Exit 2: surface the script's report **verbatim**. It names which of its three
  failure points it reached (`pre-stage`, `staged-not-committed`,
  `committed-not-pushed`, or `pushed-no-pr`) and the exact manual recovery command for
  that state. **Do not run `--abort`** — the recovery window closed at the end of
  Step 7, and `--abort` cannot safely undo a commit, a push, or an opened PR. Do not
  invent a recovery of your own; do not re-run `--ship`. Clean up (**Step 10**) and
  stop.

**On exit 0:** show `PR_URL` and tell the user the addition(s) now await a **human**
merge decision on that PR — and that `/learn-sdlc --reject <pr>` is how to decline
them, which also records the signature in the negative cache so it is never proposed
again.

---

## Step 9 — Return to the Initial Branch

Reached **only** after `--ship` exited 0. Run, via `run_command` / `Bash`:

```shell
git checkout "<initialBranch>"
```

Substitute `<initialBranch>` with `manifest.initialBranch` from the Step 2 slice.
This mirrors the semantic of `checkoutBranch` (`scripts/lib/git.js`) without calling it
— a SKILL.md cannot invoke a library export directly.

`--ship` deliberately ends on the assimilation branch (that is what makes its
orphan-branch report on the exit-2 path accurate), so this checkout belongs **here**,
after success is confirmed. Without it the developer is left on a branch that is about
to be merged or abandoned, and a later `/learn-sdlc --reject <pr>` would start from the
wrong place.

If the checkout fails (for example an unexpected dirty tree), report the failure and
the branch the repository is actually on — the PR is already open and is unaffected —
then continue to Step 10. Never force the checkout.

---

## Step 10 — Clean Up

Delete all three temp files. Run this on **every** exit path — success, cancel, and
every failure branch above — after the last step that reads them:

```shell
rm -f "$MANIFEST_FILE" "$REGRESSION_FILE" "$ASSESSMENT_FILE"
```

Skip whichever variables were never set on the path that led here (for example
`REGRESSION_FILE` and `ASSESSMENT_FILE` do not exist when Step 2 stopped on an empty
`eligible`). The skill body owns this cleanup — neither subagent nor any script deletes
the manifest.

Never delete anything under `.sdlc/learnings/pending/` here. Pending changesets are
disposed of by `learn-apply.js --ship` after its PR opens, or by `learn-reject.js`
after its push succeeds — nowhere else.

---

## Subcommand: `--reject <pr>`

The human declined an assimilation PR. Record its signature(s) in the negative cache
so no future run re-proposes them.

> **VERBATIM** — Execute this command directly with `node` and the absolute plugin path. Do not modify, rephrase, or simplify the flags.

```shell
node "<PLUGIN_ROOT>/scripts/skill/learn-reject.js" --pr "<PR_NUMBER>"
EXIT_CODE_REJECT=$?
```
> **Contract (Input/Output):**
> - **Input**: `--pr <number>` — the PR number the user passed to `--reject`, a positive integer.
> - **Output**: progress and outcome on stderr; the exit status as `EXIT_CODE_REJECT`.

The script reads the PR body via `gh pr view`, extracts the signatures from its
**first** `## Assimilated signatures` block, appends them to `rejected_guardrails` on
`origin/<defaultBranch>` through a throwaway branch (never the developer's local
default branch), deletes any matching pending changeset files **after** the push
succeeds, closes the PR, and always returns to the branch it started on.

**On non-zero `EXIT_CODE_REJECT`:**

- Exit 1: invalid `--pr`, a `gh` failure, no valid signature in the PR body, or a
  non-fast-forward push race. Surface stderr. On the race, tell the user to simply
  re-run `/learn-sdlc --reject <pr>` — nothing was changed on the default branch and no
  pending changeset was deleted.
- Exit 2: surface the `MANUAL RECOVERY REQUIRED` report verbatim. Do not attempt any
  automatic recovery.

Do **not** run any part of the assimilation flow (Steps 1-10) on this route, and do not
run `learn-apply.js` in any mode.

---

## Subcommand: `--stale`

An advisory, read-only report on guardrails that look stale under the D9 proxy signal
(age in `.sdlc/config.json`'s git history, combined with whether the guardrail id is
mentioned anywhere in `.sdlc/learnings/log.md`).

> **VERBATIM** — Execute this command directly with `node` and the absolute plugin path. Do not modify, rephrase, or simplify the flags.

```shell
node "<PLUGIN_ROOT>/scripts/util/learn-stale.js"
EXIT_CODE_STALE=$?
```
> **Contract (Input/Output):**
> - **Input**: none — the script reads `learn.staleAfterCycles`, the `plan`/`execute` guardrail arrays, and the learnings log itself. It takes no flags.
> - **Output**: one JSON line of report data on stdout — `{off, flagged:[{id, ageDays, mentionedInLog}], checked}` — with the exit status as `EXIT_CODE_STALE`.

Present the result as a table of `id` / `ageDays` / `mentionedInLog`, plus the
`checked` total. When `off` is `true`, `learn.staleAfterCycles` is unset or `null`:
report that the staleness check is disabled and stop.

**Flag-only, always.** This report never edits `.sdlc/config.json`, never deletes a
guardrail, and never downgrades a severity — the signal is a deliberately weak proxy,
and informing a human is the only safe use of it. If the user wants a flagged
guardrail changed, that is a separate, explicit edit they make themselves.

---

## Tool Access (Dual-Host)

This skill body is the write-capable half of the flow, under either host. The
native-tool-name mapping is in `docs/plugin-api-specs.md` §2 (item 2):

| Purpose | Antigravity | Claude Code |
|---|---|---|
| Step 4's config mutation, Step 7's assessment write | `write_to_file` / `replace_file_content` | `Write` / `Edit` |
| Reading `MANIFEST_FILE`, `REGRESSION_FILE`, `.sdlc/config.json` | `view_file` | `Read` |
| Every `node …` / `git` / `rm -f` command above | `run_command` | `Bash` |
| Steps 3 and 6 | `invoke_subagent` | `Agent` / `subagent_type` |

Both subagents declare `tools: view_file` and are granted no write-capable tool and no
`run_command`/`Bash` under **either** host — the no-silent-write guarantee is a
property of the tool grant, not of anything written in their prompts.

---

## DO NOT

- Do not read `manifest.preImage`, or the bodies of `manifest.eligible[].files`, into
  the main context. The thin slice in Step 2 is the whole main-context budget; the
  heavy fields exist for the two subagents.
- Do not let a subagent write `.sdlc/config.json`. Step 4 is this body's job, and
  neither agent holds a write tool to do it with.
- Do not dispatch `learn-review-only`, or invoke `--ship`, when `--validate` exited
  non-zero. That ordering is the whole reason `learn-apply.js` is split in two.
- Do not run `learn-apply.js --abort` after Step 8 has invoked `--ship`, and do not run
  it after `--validate` exited 1 (the script already rolled back) or 2 (manual recovery
  is required).
- Do not skip Step 9's `git checkout "<initialBranch>"` after a successful `--ship`.
- Do not modify, reword, reorder, re-severity, or remove an existing guardrail. This
  loop is strengthen-only: additions, and nothing else.
- Do not write `rejected_guardrails` from this skill. `learn-reject.js` owns that list.
- Do not add an assimilated guardrail to `.sdlc/review-dimensions/` or otherwise route
  it at `review-sdlc`. Guardrails reach `plan-sdlc` and `execute-plan-sdlc` only.
- Do not stage, commit, or delete anything under `.sdlc/learnings/pending/` yourself.
- Do not use `git add -A`, `git add .`, `git push --force`, or `git reset --hard`
  anywhere on any path in this flow.
- Do not leave the manifest, regression-result, or assessment temp file behind on any
  exit path — Step 10 runs on success and on failure alike.
- Do not retry a failed subagent dispatch, hand-repair a malformed `additions` payload,
  or re-run `--ship`.

---

## See Also

- `scripts/skill/learn-prepare.js` — manifest, eligibility, pre-image, assimilation branch
- `scripts/skill/learn-apply.js` — the `--validate` / `--abort` / `--ship` three-mode CLI
- `scripts/skill/learn-reject.js` — the negative-cache writer behind `--reject <pr>`
- `scripts/util/learn-stale.js` — the advisory staleness report behind `--stale`
- `scripts/ci/validate-guardrail-regression.js` — the strengthen-only diff `--validate` runs
- `agents/learn-synthesis-orchestrator.md` — Step 3's proposal agent
- `agents/learn-review-only.md` — Step 6's pre-screen agent
- `docs/self-learning-adr.md` — architecture decisions for this loop
- [`/harden-sdlc`](../harden-sdlc/SKILL.md) — the single-failure, user-approved sibling of this loop
- [`/setup-sdlc`](../setup-sdlc/SKILL.md) — initial guardrail authoring and `learn.*` configuration
