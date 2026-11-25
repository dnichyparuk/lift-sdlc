# `learn-sdlc` Subcommands & Recovery Details

Reference for `/learn-sdlc --reject <pr>`, `/learn-sdlc --stale`, and detailed rollback-window / failure-branch rules for Steps 1–9 of [`SKILL.md`](../SKILL.md).

---

## Subcommand: `--reject <pr>`

The human declined an assimilation PR. Record its signature(s) in the negative cache so no future run re-proposes them.

> **VERBATIM** — Execute this command directly with `node` and the absolute plugin path. Do not modify, rephrase, or simplify the flags.

```shell
node "<PLUGIN_ROOT>/scripts/skill/learn-reject.js" --pr "<PR_NUMBER>"
EXIT_CODE_REJECT=$?
```
> **Contract (Input/Output):**
> - **Input**: `--pr <number>` — the PR number the user passed to `--reject`, a positive integer.
> - **Output**: progress and outcome on stderr; the exit status as `EXIT_CODE_REJECT`.

The script reads the PR body via `gh pr view`, extracts the signatures from its **first** `## Assimilated signatures` block, appends them to `rejected_guardrails` on `origin/<defaultBranch>` through a throwaway branch (never the developer's local default branch), deletes any matching pending changeset files **after** the push succeeds, closes the PR, and always returns to the branch it started on.

**On non-zero `EXIT_CODE_REJECT`:**

- **Exit 1**: invalid `--pr`, a `gh` failure, no valid signature in the PR body, or a non-fast-forward push race. Surface stderr. On the race, tell the user to simply re-run `/learn-sdlc --reject <pr>` — nothing was changed on the default branch and no pending changeset was deleted.
- **Exit 2**: surface the `MANUAL RECOVERY REQUIRED` report verbatim. Do not attempt any automatic recovery.

Do **not** run any part of the assimilation flow (Steps 1–10) on this route, and do not run `learn-apply.js` in any mode.

---

## Subcommand: `--stale`

An advisory, read-only report on guardrails that look stale under the D9 proxy signal (age in `.sdlc/config.json`'s git history, combined with whether the guardrail id is mentioned anywhere in `.sdlc/learnings/log.md`).

> **VERBATIM** — Execute this command directly with `node` and the absolute plugin path. Do not modify, rephrase, or simplify the flags.

```shell
node "<PLUGIN_ROOT>/scripts/util/learn-stale.js"
EXIT_CODE_STALE=$?
```
> **Contract (Input/Output):**
> - **Input**: none — the script reads `learn.staleAfterCycles`, the `plan`/`execute` guardrail arrays, and the learnings log itself. It takes no flags.
> - **Output**: one JSON line of report data on stdout — `{off, flagged:[{id, ageDays, mentionedInLog}], checked}` — with the exit status as `EXIT_CODE_STALE`.

Present the result as a table of `id` / `ageDays` / `mentionedInLog`, plus the `checked` total. When `off` is `true`, `learn.staleAfterCycles` is unset or `null`: report that the staleness check is disabled and stop.

**Flag-only, always.** This report never edits `.sdlc/config.json`, never deletes a guardrail, and never downgrades a severity — the signal is a deliberately weak proxy, and informing a human is the only safe use of it. If the user wants a flagged guardrail changed, that is a separate, explicit edit they make themselves.

---

## Recovery Window & Edge Branches (Steps 1–9)

### Step 1 (`learn-prepare.js`) Non-Zero Exits

- **Exit 1**: read `errors[]` from `MANIFEST_FILE`, surface them verbatim, then clean up (**Step 10**) and stop. No assimilation branch exists on this path (`branchName` is `null`), so there is nothing to abort — do **not** run `learn-apply.js --abort`.
- **Exit 2**: the prepare script crashed. Surface stderr, clean up (**Step 10**), and stop. Do not re-dispatch this skill on its own crash.

### Recovery Window — Steps 2 Through 7

Once Step 2 confirms `eligible` is non-empty, `manifest.branchName` exists on disk. **Any** non-success outcome in Steps 3, 4, 6, or 7 — a failed or unparseable synthesis dispatch, an empty `PROPOSAL.additions`, a failed write of `.sdlc/config.json`, a failed review-only dispatch, or a failed write of the assessment file — is recovered by running:

```shell
ABORT_OUTPUT=$(node "<PLUGIN_ROOT>/scripts/skill/learn-apply.js" \
  --abort \
  --manifest "$MANIFEST_FILE")
EXIT_CODE_ABORT=$?
```
> **Contract (Input/Output):**
> - **Input**: `--abort --manifest <path>` — the manifest captured in Step 1.
> - **Output**: nothing on stdout (progress and outcome go to stderr); exit 0 when the rollback completed or there was nothing to roll back (it is idempotent), exit 2 when the rollback itself could not be verified.

- **Step 5 is excluded from this box**: `--validate`'s non-zero exit has its own exit-code-specific recovery rules below; do not apply `--abort` to a Step 5 failure.
- `--abort` restores `.sdlc/config.json` (`preImageStatus`-aware: unlink when `'absent'`, `git checkout -- .sdlc/config.json` when `'resolved'`), returns to `manifest.initialBranch`, and leaves pending changesets untouched.
- On exit 2, `--abort` prints a `MANUAL RECOVERY REQUIRED` report — surface that **verbatim**; do not paraphrase it and do not retry.
- After the abort, clean up (**Step 10**) and stop.
- **The window closes at the end of Step 7.** Once Step 8 has invoked `learn-apply.js --ship`, `--abort` is no longer the recovery path: by then a commit and possibly a push and a PR exist, which `--abort`'s file-and-branch rollback cannot safely undo.

### Step 5 (`learn-apply.js --validate`) Edge Exits

- **Exit 1**: the check failed and the script has **already** rolled back `.sdlc/config.json` and returned to `manifest.initialBranch`. Surface stderr (each violation is named), clean up (**Step 10**), and **stop**:
  - Do **not** dispatch `learn-review-only`.
  - Do **not** invoke `learn-apply.js --ship`.
  - Do **not** run `learn-apply.js --abort` — rollback already happened and a second attempt is noise.
- **Exit 2**: automatic rollback did **not** succeed. Surface the `MANUAL RECOVERY REQUIRED` stderr message **verbatim**, tell the user the repository is still on the assimilation branch and/or still carries the modified `.sdlc/config.json`, then clean up (**Step 10**) and stop. Do not attempt any automatic recovery of your own, `--abort` included.

### Step 8 (`learn-apply.js --ship`) Edge Exits & Post-PR Cleanup

`--ship` deletes shipped pending changeset files from disk **only after** the PR opens. That deletion is non-fatal by design: a leftover file is reported as a warning to remove by hand, never as a shipping failure.

- **Exit 1**: a usage error — a missing flag, or the working tree is not on `manifest.branchName`. Surface stderr, treat it as an unrecoverable stop, clean up (**Step 10**), and report. Nothing was committed or pushed.
- **Exit 2**: surface the script's report **verbatim**. It names which failure point it reached (`pre-stage`, `staged-not-committed`, `committed-not-pushed`, or `pushed-no-pr`) and the exact manual recovery command for that state. **Do not run `--abort`** — the recovery window closed at the end of Step 7. Do not invent a recovery of your own and do not re-run `--ship`. Clean up (**Step 10**) and stop.

### Step 9 (`git checkout`) Edge Failure

`--ship` deliberately ends on the assimilation branch so its orphan-branch report on exit 2 stays accurate, so `git checkout "<initialBranch>"` runs in Step 9 after exit 0. Without it, the developer is left on a branch about to be merged or abandoned, and a later `/learn-sdlc --reject <pr>` would start from the wrong place.

If `git checkout "<initialBranch>"` fails (for example, an unexpected dirty tree), report the failure and the branch the repository is actually on — the PR is already open and is unaffected — then continue to **Step 10**. Never force the checkout (`git checkout -f` / `git reset --hard`).
