---
name: verify-pipeline-sdlc
description: "Use this skill to analyze a failed CI run on a PR and either apply a minimal fix or emit a proposal. Dispatched automatically by ship-sdlc's verify-pipeline step under --auto, or invoked standalone via /verify-pipeline-sdlc --pr <N>. Triggers on: analyze CI failure, fix failing checks, post-PR CI verification, verify-pipeline."
user-invocable: true
argument-hint: "[--pr <number>] [--logs <path-or-string>] [--auto]"
model: gemini-3.8-flash-medium
---

# Verify Pipeline (SDLC)

Analyze failed CI logs, classify the root cause via a deterministic Node helper, and either apply a minimal in-place fix or emit a proposal as a single JSON line on stdout. Used by ship-sdlc's `verify-pipeline` step under `flags.auto`; also user-invocable for standalone CI failure analysis on any PR.

**Announce at start:** "I'm using verify-pipeline-sdlc (sdlc v{sdlc_version})." — extract the version from the `sdlc:` line in the session-start system-reminder. If no version is in context, omit the parenthetical.

---

## Step 1: CONSUME — parse args, load logs

Parse `--pr <N>`, `--logs <path-or-string>`, `--auto` from `$ARGUMENTS`. If both `--pr` and `--logs` are missing, emit `{"status":"abort","reason":"--pr or --logs required"}` and stop.

Call fetch-logs.js with `--pr-number <N>` when `--logs` is absent (fetches the PR's latest failed CI run), or with `--logs <path-or-text>` when it's provided — the script's `resolveLogsFlag` accepts either a filesystem path or inline text.

> **VERBATIM** — Run this command exactly as written, replacing `<PLUGIN_ROOT>` with the absolute path to this plugin. Note the strict script location pattern: `node "<PLUGIN_ROOT>/scripts/<group>/<script-name>.js"` — the scripts are Node CLI files invoked with `node`. Do not modify, rephrase, or simplify the commands or their flags.

```shell
node "<PLUGIN_ROOT>/scripts/util/fetch-logs.js" --pr-number <N>
```

Or when `--logs` is provided:

```shell
node "<PLUGIN_ROOT>/scripts/util/fetch-logs.js" --logs <path-or-text>
```

> **Contract (Input/Output):**
> - **Input**: `--pr-number <N>` or `--logs <path-or-text>` — mutually exclusive. The `--pr-number` value is the PR number parsed from `$ARGUMENTS` and must be numeric. The `--logs` value is passed as-is.
> - **Output**: Prints the CI failure log excerpt to stdout. Exit 0 on success — and also when no failed check is found or the run link carries no run id, in which case stdout is empty and a one-line diagnostic goes to stderr. Exit 1 on a missing/non-numeric `--pr-number`, mutually-exclusive flag violation, an unknown flag, **or `gh` not authenticated / PR lookup failed — do not treat as passing**; exit 2 on an unexpected crash.
> - **Authentication**: If `gh` is unauthenticated when using `--pr-number`, `fetchPrChecks` returns `ghAuthenticated: false`; fetch-logs.js exits 1 with the `errorMessage` on stderr (not exit 0 — an empty stdout there would be indistinguishable from "no failed checks").

If logs cannot be resolved, emit `{"status":"abort","reason":"<error message from fetch-logs.js>"}` and stop.

## Step 2: CLASSIFY — invoke the deterministic classifier

Write the resolved log text to a temp file and pass that path to the classifier helper via `--logs-file` (there is no ambient `$LOGS` env var — the classifier only reads a file or stdin).

```shell
LOGS_FILE=<path-to-temp-file-holding-the-resolved-log-text>
node "<PLUGIN_ROOT>/scripts/skill/verify-pipeline-sdlc-classify.js" --logs-file "$LOGS_FILE"
```

When the log text is already on a pipe, drop the flag and let the classifier read stdin instead:

```shell
<producer-of-log-text> | node "<PLUGIN_ROOT>/scripts/skill/verify-pipeline-sdlc-classify.js"
```

Prefer the `--logs-file` form for real CI logs: it avoids the shell quoting and here-string byte limits that can silently truncate a large excerpt.

> **Contract (Input/Output):**
> - **Input**: Log text, via `--logs-file <path>` or — when the flag is omitted — via stdin.
> - **Output**: Prints the JSON verdict on stdout. Always exits 0: an unreadable `--logs-file` or an internal error still prints `{"category":"unknown","signals":[],"routingBucket":"always-proposal"}` with a diagnostic on stderr, so classification is never a hard gate.

Read the JSON verdict on stdout: `{"category": "<lint|test-failure|type-error|build-error|dependency|infra|unknown>", "signals": [...], "routingBucket": "<actionable|always-proposal>"}`.

## Step 3: PROPOSE OR APPLY

Route by the `routingBucket` field:

- **`actionable`** (`lint`, `test-failure`, `type-error`) with `--auto` set: use the `Edit` tool to apply the minimal fix — correct the lint violation, fix the failing assertion, add the missing import, or correct the type annotation. Do NOT scaffold abstractions or refactor.
- **Everything else** — `always-proposal` categories (`build-error`, `dependency`, `infra`), or `actionable` without `--auto`: emit a proposal, no edits.
- **`unknown`** — falls through to `proposal` verdict **with the raw log excerpt as `summary`**: the classifier could not identify a category, so there is no diagnosis to summarize beyond the excerpt itself.

Constraints: never run `git commit`, `git push`, or any state-changing git command; never modify files outside the project root.

## Step 4: VERDICT — single JSON line on stdout

Emit exactly one of:

```json
{"status":"fix-applied","filesChanged":["path/a","path/b"],"summary":"<one-line summary>"}
{"status":"proposal","summary":"<diagnosis>","suggestedPatch":"<diff-or-prose>"}
{"status":"abort","reason":"<reason>"}
```

The single JSON line is the contract with the parent dispatcher (ship-sdlc) — anything else on stdout breaks the verdict parser. Logs and progress go to stderr.

## What's Next

When `fix-applied`: ship-sdlc's verify-pipeline branch dispatches `commit-sdlc` to commit and push the fix, then re-polls CI. This skill MUST NOT commit itself.

When `proposal`: the user (interactive) or ship-sdlc (logging) reads the proposal and decides whether to apply.

When `abort`: ship-sdlc treats this as a skip-with-warning and proceeds to `await-remote-review`.

## See Also

- [`/ship-sdlc`](../ship-sdlc/SKILL.md) — invokes this skill from the verify-pipeline step under `--auto`
- [`/commit-sdlc`](../commit-sdlc/SKILL.md) — invoked by ship-sdlc after this skill returns `fix-applied`
