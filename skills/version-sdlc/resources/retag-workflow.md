### Branch D: Retag Workflow (`mode === "retag"`)

**Entry condition:** `VERSION_CONTEXT_JSON.mode === "retag"`. This flow ONLY activates when `mode` from prepare output equals `"retag"` — never re-derive this from raw `$ARGUMENTS` (flag-coherence-cross-skill).

### Step 1 (CHECK): Validate Prepare Output

Read `VERSION_CONTEXT_JSON` for the retag flow:

| Field | Description |
|---|---|
| `mode` | Must be `"retag"` — gate for this branch |
| `currentTag` | The tag to be retagged (e.g., `v1.2.3`) |
| `oldSha` | The SHA the tag currently points to |
| `head` | The SHA of HEAD (the new target) |
| `errors` | Any validation errors from prepare script (exclusivity, tag-not-found) |
| `flags.auto` | Whether `--auto` was passed (suppresses confirmation prompt) |

If `errors.length > 0`, display each error and stop. Example error: `--retag cannot be combined with 'patch'`.

### Step 2 (CONFIRM): Show Retag Plan and Get Approval

Print the retag plan:

```
Retag Plan
────────────────────────────────
Tag:     <currentTag>
From:    <oldSha[:7]> (current remote tag)
To:      <head[:7]> (HEAD)
────────────────────────────────
```

**Interactive mode** (when `flags.auto` is false): Use AskUserQuestion:
> About to retag `<currentTag>` from `<oldSha[:7]>` to `<head[:7]>` (HEAD). Continue?

Options: **yes** — proceed | **no** — cancel

On **no**: stop. Print "Retag cancelled."

**Auto mode** (when `flags.auto` is true): Skip the confirmation prompt. Print the retag plan and proceed immediately.

### Step 3 (EXECUTE): Perform the Retag

Run the retag transaction script — it deletes the local and the remote tag, recreates the annotated tag at HEAD, pushes it, and verifies that the tag now resolves to HEAD:

```shell
node "<PLUGIN_ROOT>/scripts/util/version-execute.js" retag --tag <currentTag> --expected-head "<head>"
```

> **Contract (Input/Output):**
> - **Input**: `--tag <currentTag>` (required). `--expected-head "<head>"` — the `head` SHA from Step 1's prepare output, i.e. the exact commit the user approved in Step 2. Passing it makes verification (step 5 of the transaction) compare the tag against that approved SHA instead of a freshly re-derived `HEAD`, which could have moved between approval and execution.
> - **Output**: one JSON line — `{"status":"ok","tag":"<currentTag>"}` on success, with additive `verified: false` and a `warning` string when `--expected-head` was omitted and the tag does not resolve to HEAD; `{"status":"failed","recovered":<bool>,"failedStep":"...","reason":"..."}` on a git-command failure; `{"status":"failed","failedStep":"verify","reason":"tag points at <a>, approved head was <b>"}` when `--expected-head` was given and the tag landed on a different commit than the one approved.

Branch on the result:
- `{"status":"ok","tag":"<currentTag>"}` — the retag landed and matches the approved head. Continue to Step 4.
- `{"status":"ok", ..., "verified":false, "warning":"..."}` — (only possible without `--expected-head`) the retag itself succeeded but the tag does not resolve to HEAD. Show `warning`, then continue to Step 4 so the user can verify manually.
- `{"status":"failed","failedStep":"verify", ...}` — the tag was moved successfully but landed on a commit other than the approved `head`. Show `reason` (it names both SHAs) and stop; do not treat this as complete.
- `{"status":"failed", ...}` with any other `failedStep` — show `failedStep` and `reason`, then stop. Do not retry. `recovered: true` means the local tag was recreated at the SHA it pointed to before the retag, so a plain `git push origin <currentTag>` restores the previous remote state; `recovered: false` means the local tag could not be restored and the user must recreate it manually.

### Step 4 (REPORT): Summary

```
Retag complete
────────────────────────────────
Tag:     <currentTag>
Old SHA: <oldSha[:7]>
New SHA: <head[:7]>
────────────────────────────────
```
