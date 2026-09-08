# Execute-Plan State File Format

The `execute-plan-sdlc` skill writes a JSON state file to `.sdlc/execution/` at execution start and updates it after each wave and task. This file enables crash recovery via `--resume` and provides a transparent record of every wave and task executed during the run.

JSON Schemas are available at `schemas/execute-state.schema.json` and `schemas/ship-state.schema.json` for validation and IDE autocompletion.

---

## File Location

```
<main-worktree>/.sdlc/execution/execute-<branch>-<timestamp>.json
```

- `<main-worktree>` — absolute path to the main git working tree (see [Worktree Safety](#worktree-safety) below)
- `<branch>` — current git branch name with `/` replaced by `-`
- `<timestamp>` — ISO 8601 UTC timestamp at execution start, compacted to `YYYYMMDDTHHmmssZ`

Example: `.sdlc/execution/execute-feat-my-feature-20260328T143000Z.json`

---

## Worktree Safety

State files are always written to the **main working tree's** `.sdlc/execution/`, not the current working directory. This ensures state survives worktree cleanup — if `execute-plan-sdlc` runs inside a linked worktree, the state file is still accessible after that worktree is removed.

**Main working tree resolution:**

Run the worktree lifecycle helper for the current branch and read `mainWorktree` from its single-line JSON output:

```bash
node "<PLUGIN_ROOT>/scripts/util/worktree-lifecycle.js" resolve --branch <branch>
```

Example output when the branch has a linked worktree:

```json
{"found":true,"path":"/Users/dev/myrepo/.worktrees/feat-my-feature","mainWorktree":"/Users/dev/myrepo","branch":"feat/my-feature","exists":true,"matchedBy":"branch"}
```

Example output when it does not:

```json
{"found":false,"mainWorktree":"/Users/dev/myrepo"}
```

`mainWorktree` is present in every shape the script emits — including the error shape, where it is `null` when the main worktree itself couldn't be resolved — so read it regardless of `found`. Here the main working tree is `/Users/dev/myrepo`, so the state file is written to `/Users/dev/myrepo/.sdlc/execution/`.

If there are no linked worktrees, `mainWorktree` is the current repo root. Never hand-parse the porcelain worktree listing to derive this — the script does that parsing and main-worktree detection for you.

---

## Top-Level Schema

```json
{
  "version": 1,
  "skill": "execute-plan-sdlc",
  "startedAt": "2026-03-28T14:30:00Z",
  "branch": "feat/my-feature",
  "planPath": "tasks/plan.md",
  "planHash": "sha256:a1b2c3d4e5f6...",
  "preset": "balanced",
  "totalTasks": 8,
  "waves": [ ... ],
  "context": { ... }
}
```

| Field        | Type          | Description                                                                          |
|--------------|---------------|--------------------------------------------------------------------------------------|
| `version`    | number        | Schema version. Always `1` for the current format.                                   |
| `skill`      | string        | Always `"execute-plan-sdlc"`. Disambiguates from `ship-sdlc` state files in the same directory. |
| `startedAt`  | string        | ISO 8601 UTC timestamp when execution was invoked.                                   |
| `branch`     | string        | Git branch name at execution start.                                                  |
| `planPath`   | string \| null | Repository-relative path to the plan file, or `null` if the plan was provided via context rather than a file. |
| `planHash`   | string        | SHA-256 hash of the plan content at execution start. Detects if the plan changed between a failure and a resume attempt. |
| `preset`     | string \| null | Execution preset (`"full"`, `"balanced"`, or `"minimal"`), or `null` if none was applied. Legacy `"A"`/`"B"`/`"C"` values may appear in older state files. |
| `totalTasks` | number        | Total number of tasks across all waves.                                              |
| `waves`      | array         | Ordered list of wave records (see below).                                            |
| `context`    | object        | Accumulated cross-wave context enabling fresh-session resume (see below).            |

---

## `waves` Array

Each element represents one execution wave in order. Wave `0` is the pre-wave (sequential setup tasks); subsequent waves are parallel execution groups.

```json
[
  {
    "number": 0,
    "status": "completed",
    "startedAt": "2026-03-28T14:30:05Z",
    "completedAt": "2026-03-28T14:31:00Z",
    "tasks": [ ... ]
  },
  {
    "number": 1,
    "status": "in_progress",
    "startedAt": "2026-03-28T14:31:05Z",
    "tasks": [ ... ]
  },
  {
    "number": 2,
    "status": "pending",
    "tasks": [ ... ]
  }
]
```

| Field         | Type   | Present when                             | Description                                                          |
|---------------|--------|------------------------------------------|----------------------------------------------------------------------|
| `number`      | number | always                                   | Wave number. `0` for the pre-wave; `1`, `2`, ... for execution waves.|
| `status`      | string | always                                   | Current wave status (see [Status Values](#status-values) below).     |
| `startedAt`   | string | status is `in_progress` or later         | ISO 8601 UTC timestamp when the wave began.                          |
| `completedAt` | string | status is `completed` or `failed`        | ISO 8601 UTC timestamp when the wave finished.                       |
| `tasks`       | array  | always                                   | Per-task records for this wave (see below).                          |

---

## `waves[].tasks` Array

Each element represents one task within its wave.

```json
[
  {
    "id": 1,
    "name": "Set up database schema",
    "complexity": "Standard",
    "risk": "Low",
    "status": "completed",
    "filesChanged": ["db/schema.sql", "db/migrations/001_init.sql"]
  },
  {
    "id": 2,
    "name": "Implement auth middleware",
    "complexity": "Complex",
    "risk": "Medium",
    "status": "failed",
    "filesChanged": []
  }
]
```

| Field          | Type     | Description                                                                          |
|----------------|----------|--------------------------------------------------------------------------------------|
| `id`           | number   | Task number from the plan. Stable across resume attempts.                            |
| `name`         | string   | Task title as written in the plan.                                                   |
| `complexity`   | string   | Task complexity classification: `"Trivial"`, `"Standard"`, or `"Complex"`.          |
| `risk`         | string   | Task risk classification: `"Low"`, `"Medium"`, or `"High"`.                         |
| `status`       | string   | Task outcome: `"completed"`, `"failed"`, or `"skipped"`.                            |
| `filesChanged` | string[] | Repository-relative paths of files this task modified, derived from `git diff` after task completion. Empty array if the task produced no file changes. |

---

## `context` Object

Accumulates cross-wave state so that a resumed execution in a fresh Antigravity session has sufficient context to continue without re-reading completed work. Updated after each wave completes.

```json
{
  "planSummary": "Add OAuth2 login flow with JWT token issuance",
  "completedTaskIds": [1, 3, 4],
  "filesAdded": ["src/auth/oauth.ts", "src/auth/jwt.ts"],
  "filesModified": ["src/routes/index.ts", "src/middleware/session.ts"],
  "interfacesCreated": ["OAuthProvider", "JWTClaims", "TokenIssuer"],
  "decisionsFromPriorWaves": [
    "Used HS256 for JWT signing; RS256 deferred to follow-up",
    "OAuth state parameter stored in Redis, not session cookie"
  ]
}
```

| Field                    | Type     | Description                                                                                                   |
|--------------------------|----------|---------------------------------------------------------------------------------------------------------------|
| `planSummary`            | string   | One-line description of the overall plan goal. Injected into agent prompts at resume to orient the session.  |
| `completedTaskIds`       | number[] | Task IDs that completed successfully across all waves so far. Used to skip already-done work on resume.      |
| `filesAdded`             | string[] | All files created by completed waves. Helps resuming agents understand what already exists.                  |
| `filesModified`          | string[] | All pre-existing files modified by completed waves. Alerts resuming agents to changed interfaces.            |
| `interfacesCreated`      | string[] | Key interfaces, types, and exports introduced in completed waves. Enables resuming agents to use them correctly without re-reading source files. |
| `decisionsFromPriorWaves`| string[] | Implementation decisions made in earlier waves that affect how remaining waves should be implemented. Prevents contradictory choices in resumed sessions. |

---

## Status Values

| Status        | Meaning                                                                          |
|---------------|----------------------------------------------------------------------------------|
| `pending`     | Not yet started; waiting for preceding waves to complete.                        |
| `in_progress` | Currently executing. If the process crashes, this wave or task will be retried.  |
| `completed`   | Finished successfully.                                                           |
| `failed`      | Terminated with an error; execution halted.                                      |
| `skipped`     | Intentionally bypassed (e.g. task already completed in a prior attempt).         |

---

## Lifecycle Rules

### Cleanup

The state file is deleted automatically when execution completes successfully (all waves and tasks reach `completed` or `skipped`). This keeps `.sdlc/execution/` clean in the normal case.

If execution fails or is interrupted, the state file is retained so the run can be resumed.

### Resume

Passing `--resume` to `execute-plan-sdlc` causes it to locate the most recent state file for the current branch (matched by branch name in the filename). The skill then:

1. Skips any wave with status `completed`.
2. Retries any wave with status `in_progress` from its beginning (individual task results within that wave are not trusted).
3. Executes remaining waves with status `pending` normally.

The `context` object is loaded into the agent prompt so the resuming session understands what was built in prior waves.

If multiple state files exist for the same branch (from multiple failed attempts), the one with the most recent timestamp is used.

---

## Full Example

Mid-execution state: wave 0 completed, wave 1 in progress, wave 2 pending.

```json
{
  "version": 1,
  "skill": "execute-plan-sdlc",
  "startedAt": "2026-03-28T14:30:00Z",
  "branch": "feat/my-feature",
  "planPath": "tasks/plan.md",
  "planHash": "sha256:3f2a1b9c7e4d8a5f6b0c2d9e1a4f7b3c8d2e5f0a1b6c9d4e7f2a5b8c3d6e9f0",
  "preset": "balanced",
  "totalTasks": 8,
  "waves": [
    {
      "number": 0,
      "status": "completed",
      "startedAt": "2026-03-28T14:30:05Z",
      "completedAt": "2026-03-28T14:31:00Z",
      "tasks": [
        {
          "id": 1,
          "name": "Create database schema",
          "complexity": "Standard",
          "risk": "Low",
          "status": "completed",
          "filesChanged": ["db/schema.sql", "db/migrations/001_init.sql"]
        },
        {
          "id": 2,
          "name": "Configure environment variables",
          "complexity": "Trivial",
          "risk": "Low",
          "status": "completed",
          "filesChanged": [".env.example", "src/config.ts"]
        }
      ]
    },
    {
      "number": 1,
      "status": "in_progress",
      "startedAt": "2026-03-28T14:31:05Z",
      "tasks": [
        {
          "id": 3,
          "name": "Implement OAuth2 provider integration",
          "complexity": "Complex",
          "risk": "Medium",
          "status": "completed",
          "filesChanged": ["src/auth/oauth.ts", "src/auth/providers/github.ts"]
        },
        {
          "id": 4,
          "name": "Implement JWT token issuance",
          "complexity": "Standard",
          "risk": "Medium",
          "status": "in_progress",
          "filesChanged": []
        },
        {
          "id": 5,
          "name": "Add user session storage",
          "complexity": "Standard",
          "risk": "Low",
          "status": "pending",
          "filesChanged": []
        }
      ]
    },
    {
      "number": 2,
      "status": "pending",
      "tasks": [
        {
          "id": 6,
          "name": "Wire auth middleware into route handlers",
          "complexity": "Standard",
          "risk": "Low",
          "status": "pending",
          "filesChanged": []
        },
        {
          "id": 7,
          "name": "Add integration tests for login flow",
          "complexity": "Standard",
          "risk": "Low",
          "status": "pending",
          "filesChanged": []
        },
        {
          "id": 8,
          "name": "Update API documentation",
          "complexity": "Trivial",
          "risk": "Low",
          "status": "pending",
          "filesChanged": []
        }
      ]
    }
  ],
  "context": {
    "planSummary": "Add OAuth2 login flow with JWT token issuance and session management",
    "completedTaskIds": [1, 2, 3],
    "filesAdded": [
      "db/schema.sql",
      "db/migrations/001_init.sql",
      "src/auth/oauth.ts",
      "src/auth/providers/github.ts"
    ],
    "filesModified": [
      ".env.example",
      "src/config.ts"
    ],
    "interfacesCreated": [
      "OAuthProvider",
      "OAuthCallbackParams",
      "GitHubOAuthProvider"
    ],
    "decisionsFromPriorWaves": [
      "OAuth state parameter stored in Redis with 10-minute TTL, not in session cookie",
      "GitHub provider implemented first; Google provider deferred to follow-up task"
    ]
  }
}
```
