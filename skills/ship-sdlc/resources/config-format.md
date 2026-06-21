# ship-sdlc Configuration Reference

This document describes the `.sdlc/local.json → ship section`, the persistent configuration for ship-sdlc. Settings here apply to every `ship-sdlc` invocation in the repository unless overridden by a CLI flag.

---

## File Location

```
<repo-root>/.sdlc/local.json
```

The ship configuration lives in the `ship` section of the user-local (gitignored) `.sdlc/local.json` config file. Create it manually or run `/setup-sdlc` to walk through an interactive setup.

A JSON Schema is available at `schemas/sdlc-local.schema.json` for IDE autocompletion. Set the `$schema` field in your config to enable it.

---

## Schema Versioning

The local config carries a top-level integer `schemaVersion` field. The current schema version is **`4`**. Files lacking a `schemaVersion` field (or with an older schema version) are auto-migrated on read by `lib/config.js`:

- Legacy `ship.preset` → expanded to `ship.steps[]`
- Legacy `ship.skip[]` → subtracted from the expanded `steps[]`
- Both legacy fields are dropped; top-level `schemaVersion: 4` is written
- Migration is idempotent and emits a single stderr deprecation notice on first read

To migrate explicitly without waiting for the next ship run, run `/setup-sdlc --migrate`.

---

## Full Example

```json
{
  "$schema": "https://raw.githubusercontent.com/dnichyparuk/lift-sdlc/main/schemas/sdlc-local.schema.json",
  "schemaVersion": 4,
  "ship": {
    "steps": ["execute", "commit", "review", "version", "archive-openspec", "pr", "verify-pipeline", "await-remote-review", "learnings-commit"],
    "quick": ["execute", "commit", "pr"],
    "bump": "patch",
    "draft": false,
    "auto": false,
    "reviewThreshold": "high",
    "workspace": "prompt",
    "rebase": true,
    "verifyPipelineTimeout": 1200,
    "verifyPipelineInterval": 60,
    "verifyPipelineMaxIterations": 3,
    "awaitRemoteReviewTimeout": 600,
    "awaitRemoteReviewInterval": 60,
    "awaitRemoteReviewers": ["copilot"]
  }
}
```

`verify-pipeline` and `await-remote-review` are opt-in members of `ship.steps[]`. Add them only when you want post-PR CI verification or to await an automated reviewer's verdict.

---

## Field Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `schemaVersion` (top-level) | `4` | `4` | Schema version literal. Required for new configs; legacy files are auto-migrated. |
| `steps` | `string[]` | `["execute","commit","review","version","archive-openspec","pr","learnings-commit"]` | Pipeline steps to run. Allowed values: `execute`, `commit`, `review`, `version`, `archive-openspec`, `pr`, `verify-pipeline` (opt-in, R41), `await-remote-review` (opt-in, R50), `learnings-commit`. Replaces the legacy `preset` and `skip` fields. |
| `quick` | `string[]` | unset | Optional shortened step list activated by `--quick`. When set, `/ship-sdlc --quick` uses this list instead of `steps[]`. Unset means `--quick` is unavailable for this project. Same allowed values as `steps`. See R-quick-1. |
| `bump` | `"patch"` \| `"minor"` \| `"major"` | `"patch"` | Default version bump type applied when the `version` step runs. Overridden by `--bump` on the CLI. |
| `draft` | `boolean` | `false` | When `true`, PRs are created as drafts. Equivalent to `--draft`. |
| `auto` | `boolean` | `false` | When `true`, run in non-interactive auto mode (no confirmation prompts). Equivalent to `--auto`. |
| `reviewThreshold` | `"critical"` \| `"high"` \| `"medium"` | `"high"` | Minimum review-finding severity that triggers the received-review fix loop. See table below. |
| `workspace` | `"branch"` \| `"worktree"` \| `"prompt"` | `"prompt"` | Workspace isolation strategy for execute-plan-sdlc. `"branch"` = use a feature branch, `"worktree"` = use a git worktree, `"prompt"` = ask each time. Forwarded to execute-plan-sdlc as a hint. |
| `rebase` | `true` \| `false` \| `"prompt"` | `true` | When `true`, auto-rebase onto the default branch before execution (execute-plan-sdlc) and before versioning (ship-sdlc). When `false`, skip rebase. When `"prompt"`, ask each time. |
| `verifyPipelineTimeout` | `integer` (≥30) | `1200` | Maximum seconds `verify-pipeline` polls CI checks before giving up and proceeding (R57). Only prompted in `setup-sdlc` when `verify-pipeline` is in `ship.steps[]`. |
| `verifyPipelineInterval` | `integer` (≥10) | `60` | Seconds between `verify-pipeline` poll attempts (R57). Only prompted in `setup-sdlc` when `verify-pipeline` is in `ship.steps[]`. |
| `verifyPipelineMaxIterations` | `integer` (1–10) | `3` | Maximum analyze-fix-recheck iterations before `verify-pipeline` gives up (R47, R57). Only prompted in `setup-sdlc` when `verify-pipeline` is in `ship.steps[]`. |
| `awaitRemoteReviewTimeout` | `integer` (≥30) | `600` | Maximum seconds `await-remote-review` polls for a reviewer response (R57). Only prompted in `setup-sdlc` when `await-remote-review` is in `ship.steps[]`. |
| `awaitRemoteReviewInterval` | `integer` (≥10) | `60` | Seconds between `await-remote-review` poll attempts (R57). Only prompted in `setup-sdlc` when `await-remote-review` is in `ship.steps[]`. |
| `awaitRemoteReviewers` | `string[]` (minItems 1) | `["copilot"]` | Reviewer logins (case-insensitive) whose review satisfies the `await-remote-review` gate. Login `copilot` also requires `user.type === "Bot"` (R56, R57). Only prompted in `setup-sdlc` when `await-remote-review` is in `ship.steps[]`. |

### reviewThreshold Levels

| Value | Which severities trigger the fix loop |
|-------|---------------------------------------|
| `"critical"` | Critical only |
| `"high"` | Critical + High |
| `"medium"` | Critical + High + Medium |

At `"high"` (the default), findings rated Medium or lower are reported but do not block the ship pipeline.

### Legacy CLI Sugar (deprecated)

The CLI flags below are accepted for backward compatibility. They are NOT persisted as config fields — they expand to `steps[]` operations at parse time:

- `--preset full|balanced|minimal` — expands to a canonical `steps[]` set:
  - `full` → all six canonical steps
  - `balanced` → all except `version`
  - `minimal` → `[execute, commit, pr]`
  - Legacy `A`/`B`/`C` aliases are accepted and normalized to `full`/`balanced`/`minimal`.
- `--skip <step,…>` — subtracts named steps from the resolved `steps[]`.

Combination order: `--preset` expands first, then `--skip` subtracts. Both override the config-level `steps[]`.

---

## Merge Precedence

When the same setting is specified in multiple places, the order of precedence is:

```
--steps <csv>  >  --quick (resolves ship.quick)  >  .sdlc/local.json (ship.steps)  >  built-in defaults
```

A flag passed directly on the command line always wins. If no flag is given, the config file value is used. If the config file is absent or does not specify a field, the built-in default applies.

**`--quick` and `--steps` are mutually exclusive.** Passing both on the same invocation is a hard error (R-quick-5).

---

## --init-config Walkthrough

Running `ship-sdlc --init-config` launches an interactive sequence that writes the `ship` section to `.sdlc/local.json`. The steps are:

1. **Steps to run** — Select the pipeline steps to run by default (multi-select). Choices: `execute`, `commit`, `review`, `version`, `archive-openspec`, `pr`. Default: all six.

2. **Default bump type** — Choose the default version increment: `patch`, `minor`, or `major`.

3. **Draft PR preference** — Should PRs be opened as drafts by default? (`yes` / `no`)

4. **Auto mode** — Should the pipeline run without confirmation prompts where supported? (`yes` / `no`). Default: `no`.

5. **Workspace isolation** — How should the execute step isolate work? (`branch` / `worktree` / `prompt`). Default: `prompt`.
   - `branch` = create or use a feature branch (simpler, most common)
   - `worktree` = create a git worktree (parallel work, isolated filesystem)
   - `prompt` = ask each time (current default behavior)

6. **Rebase strategy** — Should the pipeline rebase onto the default branch before execution and versioning? (`yes` / `no` / `prompt`). Default: `yes` (maps to `true`).
   - `yes` = always rebase automatically (`true` in config)
   - `no` = never rebase (`false` in config)
   - `prompt` = ask each time (`"prompt"` in config)

7. **Review threshold** — Choose the minimum severity that triggers a fix loop:
   - `critical` = only blockers
   - `high` = blockers + high-severity findings (recommended)
   - `medium` = blockers + high + medium-severity findings

8. **Write and confirm** — The tool runs `util/ship-init.js` with the collected answers to write the `ship` section to `.sdlc/local.json` (with `schemaVersion: 4` at the top level) and create `.sdlc/.gitignore`. The resulting config JSON is displayed for confirmation. If the ship section already exists, you are asked whether to overwrite it.

---

## Team Configuration Examples

### Solo developer — move fast

Skips the version step (manual version bump) and runs auto.

```json
{
  "$schema": "https://raw.githubusercontent.com/dnichyparuk/lift-sdlc/main/schemas/sdlc-local.schema.json",
  "schemaVersion": 4,
  "ship": {
    "steps": ["execute", "commit", "review", "archive-openspec", "pr"],
    "bump": "patch",
    "draft": false,
    "auto": true,
    "reviewThreshold": "critical",
    "workspace": "branch"
  }
}
```

### Team with guardrails

All canonical steps run; review threshold catches high-severity findings; PRs default to draft.

```json
{
  "$schema": "https://raw.githubusercontent.com/dnichyparuk/lift-sdlc/main/schemas/sdlc-local.schema.json",
  "schemaVersion": 4,
  "ship": {
    "steps": ["execute", "commit", "review", "version", "archive-openspec", "pr"],
    "bump": "minor",
    "draft": true,
    "auto": false,
    "reviewThreshold": "high",
    "workspace": "prompt"
  }
}
```

### CI-adjacent — maximum confidence

Smallest step set with widest review threshold. Suitable for regulated environments or release branches where medium-severity findings must be resolved before merging.

```json
{
  "$schema": "https://raw.githubusercontent.com/dnichyparuk/lift-sdlc/main/schemas/sdlc-local.schema.json",
  "schemaVersion": 4,
  "ship": {
    "steps": ["execute", "commit", "pr"],
    "bump": "patch",
    "draft": false,
    "auto": false,
    "reviewThreshold": "medium",
    "workspace": "worktree"
  }
}
```
