# Pipeline State File Format

The `ship-sdlc` skill writes a JSON state file to `.sdlc/execution/` at pipeline start and updates it after each step. This file enables crash recovery via `--resume` and provides a transparent audit trail of every decision made during the run.

---

## File Location

```
.sdlc/execution/ship-<branch>-<timestamp>.json
```

- `<branch>` — current git branch name with `/` replaced by `-`
- `<timestamp>` — ISO 8601 UTC timestamp at pipeline start, compacted to `YYYYMMDDTHHmmssZ`

Example: `.sdlc/execution/ship-feat-my-feature-20260327T143000Z.json`

---

## Top-Level Schema

```json
{
  "version": 1,
  "startedAt": "2026-03-27T14:30:00Z",
  "branch": "feat/ship-sdlc",
  "flags": { ... },
  "steps": [ ... ],
  "decisions": [ ... ],
  "deferredFindings": [ ... ]
}
```

| Field             | Type   | Description                                                  |
|-------------------|--------|--------------------------------------------------------------|
| `version`         | number | Schema version. Always `1` for the current format.           |
| `startedAt`       | string | ISO 8601 UTC timestamp when the pipeline was invoked.        |
| `branch`          | string | Git branch name at pipeline start.                           |
| `flags`           | object | Resolved flags passed to `ship-sdlc` (see below).           |
| `steps`           | array  | Ordered list of pipeline step records (see below).           |
| `decisions`       | array  | Key decisions recorded for transparency (see below).         |
| `deferredFindings`| array  | Review findings deferred to a follow-up (see below).        |
| `nextPendingStep` | string \| null | Derived at read time by `lib/state.js::detectResumeState`. Name of the first step in `steps[]` whose `status` is neither `completed` nor `skipped`, or `null` when every step is resolved. Not written into the on-disk file; recomputed on every read so a resumed run picks the correct re-entry point. Example: `"review"`. |

---

## `flags` Object

Captures the effective flags after defaults and config are applied, so a resumed run uses the same configuration.

```json
{
  "auto": true,
  "skip": ["version"],
  "preset": "balanced",
  "bump": "patch",
  "draft": true
}
```

| Field    | Type            | Description                                                          |
|----------|-----------------|----------------------------------------------------------------------|
| `auto`   | boolean         | Whether `--auto` (non-interactive) mode was active.                  |
| `skip`   | string[]        | Step names explicitly skipped via `--skip`.                          |
| `preset` | string \| null  | Execution preset used (`"full"`, `"balanced"`, or `"minimal"`), or `null` if none. Legacy `"A"`/`"B"`/`"C"` may appear in older state files. |
| `bump`   | string \| null  | Version bump type (`"major"`, `"minor"`, `"patch"`), or `null`.      |
| `draft`  | boolean         | Whether the PR was opened as a draft.                                |

---

## `steps` Array

Each element represents one pipeline step in execution order.

```json
[
  { "name": "execute",         "status": "completed",   "result": "8 tasks, 3 waves", "completedAt": "2026-03-27T14:35:00Z" },
  { "name": "commit",          "status": "completed",   "result": "a1b2c3d", "commitSha": "a1b2c3d", "completedAt": "2026-03-27T14:36:00Z" },
  { "name": "review",          "status": "completed",   "result": "APPROVED_WITH_NOTES", "reviewVerdict": "APPROVED_WITH_NOTES", "completedAt": "2026-03-27T14:38:00Z" },
  { "name": "received-review", "status": "pending",     "condition": "if critical/high findings" },
  { "name": "commit-fixes",    "status": "pending",     "condition": "if received-review made changes" },
  { "name": "version",         "status": "completed",   "result": "v1.2.3", "versionTag": "v1.2.3", "completedAt": "2026-03-27T14:39:00Z" },
  { "name": "pr",              "status": "in_progress", "prUrl": "https://github.com/owner/repo/pull/42", "startedAt": "2026-03-27T14:40:00Z" }
]
```

### Step Fields

| Field            | Type   | Present when                                | Description                                                   |
|------------------|--------|---------------------------------------------|---------------------------------------------------------------|
| `name`           | string | always                                      | Step identifier (see step names below).                       |
| `status`         | string | always                                      | Current execution status (see status values below).           |
| `startedAt`      | string | status is `in_progress`                     | ISO 8601 UTC timestamp when the step began.                   |
| `completedAt`    | string | status is `completed` or `skipped`          | ISO 8601 UTC timestamp when the step finished.                |
| `result`         | string | status is `completed`                       | Human-readable summary of what the step produced.             |
| `condition`      | string | step is conditional                         | Natural-language condition that gates this step's execution.  |
| `reason`         | string | status is `skipped`                         | Why the step was skipped.                                     |
| `error`          | string | status is `failed`                          | Error message or description of the failure.                  |
| `reviewVerdict`  | string | optional — set by the `review` step         | Review outcome label (e.g. `"APPROVED"`, `"APPROVED_WITH_NOTES"`, `"CHANGES_REQUESTED"`). Used by post-compact reminders. |
| `prUrl`          | string | optional — set by the `pr` step             | Absolute URL of the created or updated pull request.          |
| `commitSha`      | string | optional — set by the `commit` / `commit-fixes` step | Short SHA (e.g. `"a1b2c3d"`) of the commit produced by the step. |
| `versionTag`     | string | optional — set by the `version` step        | Git tag produced by the version step (e.g. `"v1.2.3"`).      |

### Step Names

The pipeline runs these 7 steps in order:

| Name              | Description                                                                 |
|-------------------|-----------------------------------------------------------------------------|
| `execute`         | Run the execution plan (tasks, waves).                                      |
| `commit`          | Commit all changes produced by `execute`.                                   |
| `review`          | Run automated code review via `review-sdlc`.                                |
| `received-review` | Conditional: process critical/high review findings and apply fixes.         |
| `commit-fixes`    | Conditional: commit changes made during `received-review`.                  |
| `version`         | Bump the version according to `--bump` or interactive selection.            |
| `pr`              | Open or update a pull request.                                              |

`received-review` only executes when `review` reports critical or high severity findings.
`commit-fixes` only executes when `received-review` applied code changes.

### Status Values

| Status        | Meaning                                                                 |
|---------------|-------------------------------------------------------------------------|
| `pending`     | Not yet started; waiting for preceding steps to complete.               |
| `in_progress` | Currently executing. If the process crashes, this step will be retried. |
| `completed`   | Finished successfully.                                                  |
| `skipped`     | Intentionally bypassed (via `--skip`, a condition not being met, or other logic). |
| `failed`      | Terminated with an error; pipeline halted.                              |

---

## `decisions` Array

Records key choices made during the run for post-run transparency and debugging.

```json
[
  { "step": "execute", "decision": "preset B selected from config default" },
  { "step": "review",  "decision": "verdict: APPROVED WITH NOTES — 2 medium deferred, no critical/high" }
]
```

| Field      | Type   | Description                                      |
|------------|--------|--------------------------------------------------|
| `step`     | string | The step name that produced this decision entry. |
| `decision` | string | Description of what was decided and why.         |

Decisions are appended as each step completes. They are never overwritten.

---

## `deferredFindings` Array

Review findings that were not acted on during the pipeline run. These are captured so they can be turned into follow-up issues.

```json
[
  {
    "severity": "medium",
    "file": "src/auth.ts",
    "line": 42,
    "title": "Extract token validation"
  }
]
```

| Field      | Type           | Description                                                   |
|------------|----------------|---------------------------------------------------------------|
| `severity` | string         | Severity level: `"critical"`, `"high"`, `"medium"`, `"low"`. |
| `file`     | string         | Repository-relative path of the file with the finding.        |
| `line`     | number \| null | Line number, or `null` if the finding is file-level.          |
| `title`    | string         | Short description of the finding.                             |

Only `medium` and `low` findings are deferred. Critical and high findings trigger `received-review` and must be resolved before the pipeline proceeds.

---

## Lifecycle Rules

### Cleanup

The state file is deleted automatically when the pipeline completes successfully (all steps reach `completed` or `skipped` and the PR is opened or updated). This keeps `.sdlc/execution/` clean in the normal case.

If the pipeline fails or is interrupted, the state file is retained so the run can be resumed.

### Resume

Passing `--resume` to `ship-sdlc` causes it to read the most recent state file for the current branch (matched by branch name in the filename). The skill replays the step list and skips any step with status `completed` or `skipped`. Steps with status `in_progress` are retried from the beginning.

If multiple state files exist for the same branch (from multiple failed attempts), the one with the most recent timestamp is used.

---

## Full Example

```json
{
  "version": 1,
  "startedAt": "2026-03-27T14:30:00Z",
  "branch": "feat/ship-sdlc",
  "flags": {
    "auto": true,
    "skip": ["version"],
    "preset": "balanced",
    "bump": "patch",
    "draft": true
  },
  "steps": [
    { "name": "execute",         "status": "completed",   "result": "8 tasks, 3 waves",                             "completedAt": "2026-03-27T14:35:00Z" },
    { "name": "commit",          "status": "completed",   "result": "a1b2c3d",                                       "completedAt": "2026-03-27T14:36:00Z" },
    { "name": "review",          "status": "in_progress", "startedAt": "2026-03-27T14:36:05Z" },
    { "name": "received-review", "status": "pending",     "condition": "if critical/high findings" },
    { "name": "commit-fixes",    "status": "pending",     "condition": "if received-review made changes" },
    { "name": "version",         "status": "skipped",     "reason": "in skip set" },
    { "name": "pr",              "status": "pending" }
  ],
  "decisions": [
    { "step": "execute", "decision": "preset B selected from config default" },
    { "step": "review",  "decision": "verdict: APPROVED WITH NOTES — 2 medium deferred, no critical/high" }
  ],
  "deferredFindings": [
    { "severity": "medium", "file": "src/auth.ts", "line": 42, "title": "Extract token validation" }
  ]
}
```

---

## Plan-Mode-Blocked Init

When `/ship-sdlc` is invoked while plan mode is active, Step 0 calls `skill/ship.js --plan-mode-blocked` which invokes `state/ship.js init` to persist an init state file. The state file shape is **byte-identical** to a normal `cmdInit` write — all 7 steps with `status: "pending"`, plus `version`, `startedAt`, `branch`, `flags`, `decisions: []`, `deferredFindings: []`.

The `planModeBlocked` flag does NOT appear in the state file — it is an annotation in the prepare output only, telling SKILL.md what happened.

On the user's next `/ship-sdlc` invocation (after exiting plan mode), `detectResumeState` finds the state file by branch slug and sets `flags.implicitResume = true`. The pipeline resumes from the first pending step with the originally-resolved `flags` snapshot (including `bump`, `steps`, etc.).
