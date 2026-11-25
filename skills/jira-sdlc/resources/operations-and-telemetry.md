# Jira SDLC — Operations, Multi-Site, and Telemetry Details

Extended walkthroughs, edge-case procedures, bulk execution patterns, and MCP failure telemetry details extracted from [SKILL.md](../SKILL.md).

---

## Multi-Site Cache Disambiguation & Legacy Migration

### Multi-Candidate Cache Disambiguation

Caches live outside the working tree at `~/.sdlc-cache/jira/<sanitizedSiteHost>/<PROJECT_KEY>.json` (host lowercased, `.` → `_`, e.g., `acme.atlassian.net` → `acme_atlassian_net`).

When `scripts/skill/jira.js --check` runs without `--site` and `~/.sdlc-cache/jira/` holds entries for the same project key under two or more site subdirectories, the script returns:

```json
{
  "exists": false,
  "candidateSites": ["acme_atlassian_net", "sandbox_atlassian_net"]
}
```

Present `candidateSites` to the user via `ask_question`, then either:
- Re-run `--check` / `--load` with `--site <host>` (e.g., `--site acme_atlassian_net`), or
- Run `--force-refresh` to rebuild the cache against the currently active Jira site.

### Legacy Cache Migration

Legacy per-repo caches at `.sdlc/jira-cache/<KEY>.json` migrate automatically to `~/.sdlc-cache/jira/<sanitizedSiteHost>/<KEY>.json` on the next `--check`. The legacy file is left in place on disk.

---

## `--init-templates` Walkthrough & Custom Type Mapping

When `--init-templates` is passed:

1. Run the template initializer and extend the cleanup `trap`:

```shell
INIT_RESULT=$(node "<PLUGIN_ROOT>/scripts/skill/jira.js" --project "$PROJECT_KEY" --init-templates)
trap 'rm -f "$JIRA_CONTEXT_FILE" "$INIT_RESULT"' EXIT INT TERM
```

2. Read and parse `$INIT_RESULT`. Report: `"N templates initialized (exact match), N skipped (already exist)."`

3. If `unavailable` is non-empty AND the cache is loaded:
   - Announce: `"Found N issue types with no matching default template. I'll suggest a template for each based on its Jira hierarchy level."`
   - For each unavailable type, look up `cache.issueTypes[typeName]` and suggest based on `hierarchyLevel`:
     - `hierarchyLevel === 1` → suggest `"Epic"`
     - `hierarchyLevel === 0` and `subtask === false` → suggest `"Task"`
     - `subtask === true` → suggest `"Skip (subtask)"`
     - No `hierarchyLevel` available → no suggestion; present all options equally
   - Use `ask_question`:
     > Issue type "[typeName]" (hierarchy level: [N]) has no matching template.
     > Which default template should I use?
     >
     > Options: `[Suggested template (Recommended)]`, `[other available default templates]`, `Skip — no template for this type`
   - For each user selection other than Skip, copy the template (`--copy-template` prints a temp manifest path `{ copied, reason, type, destination }` — capture it):

```shell
COPY_RESULT=$(node "<PLUGIN_ROOT>/scripts/skill/jira.js" --project "$PROJECT_KEY" --copy-template --type "<typeName>" --from "<selectedTemplate>")
```

   - Report: `"N additional templates created from user selections."`

4. Cleanup of `$INIT_RESULT` and `$JIRA_CONTEXT_FILE` runs automatically via the `trap`. Stop — do not proceed with any Jira operation.

---

## Bulk Operations & Batching Patterns

See `./operations-reference.md` (`Bulk Operation`) and `./EXAMPLES.md` (Section 11) for payload examples. When executing `bulk` requests:

1. **Decompose into discrete operations:** Parse every item into an explicit create/edit/transition/link spec and resolve templates + C13 placeholders for each item before critique.
2. **Order by dependency:**
   - Epics before Stories/Tasks that reference them via `parent` / Epic Link.
   - Parent issues before Sub-tasks (`parent: "<KEY>"` requires the parent key to exist).
   - Issues before `createIssueLink` calls connecting them.
3. **Preserve write-guard gates (Steps 2.5–2.7):**
   - Compute `payloadHash(toolInput)` and write critique + approval artifacts (`writeCritique`, `writeApprovalToken`) per write payload.
   - Present the full payloads to the user for one `approve` decision in Step 2.6, and run `scripts/skill/jira.js --validate-body` (Step 2.7) on every description/comment body before dispatching any MCP write call.
4. **Execute and handle partial failure:**
   - Dispatch independent operations in parallel batches; run dependent waves sequentially after parent keys return.
   - Report progress after each batch (e.g., `"Created 3 of 5 issues…"`).
   - On partial failure, finish remaining independent operations and report every failed item with its error message so the user can retry only the failed subset.

---

## MCP Failure Telemetry & Recovery Procedures

### Shared Telemetry Protocol & Conventions

Every exhausted-recovery path records telemetry and offers a gated issue dispatch via `scripts/lib/mcp-failure.js`:

```shell
node "<PLUGIN_ROOT>/scripts/lib/mcp-failure.js" --telemetry --class <CLASS> --tool "<TOOL>" --site "$JIRA_SITE" --project "$PROJECT_KEY" --error "<ERROR>" --recovered no
ANALYZE_JSON=$(node "<PLUGIN_ROOT>/scripts/lib/mcp-failure.js" --analyze --class <CLASS> --tool "<TOOL>" --site "$JIRA_SITE" --project "$PROJECT_KEY" --error "<ERROR>" --recovered no --r-path <R-PATH>)
PROPOSAL_TITLE=$(printf '%s' "$ANALYZE_JSON" | node "<PLUGIN_ROOT>/scripts/util/parse-proposal.js" title)
PROPOSAL_BODY=$(printf  '%s' "$ANALYZE_JSON" | node "<PLUGIN_ROOT>/scripts/util/parse-proposal.js" body)
```

Present `$PROPOSAL_TITLE` and `$PROPOSAL_BODY` to the user verbatim with prompt `"Y (file issue) / edit / skip"`. On `Y`, dispatch `error-report-sdlc` with `--error-type mcp-<CLASS>`, `--skill jira-sdlc`, `--step "<STEP>"`, `--operation "<TOOL>"`, `--error-text "$PROPOSAL_BODY"`, and labels `mcp-failure,class:<CLASS>`.

**Conventions for every `mcp-failure.js` callsite:**
- Spell out `<PLUGIN_ROOT>/scripts/lib/mcp-failure.js` in full at every callsite (do not rely on a pre-set shell variable across independent steps).
- Never redirect stdout to `/dev/null`: `--telemetry` echoes the block appended to `.sdlc/learnings/log.md` and `--analyze` emits JSON.
- Cross-step session counting is keyed by `SDLC_SESSION_ID` when set, otherwise by `.sdlc/state/mcp-session.id` written on first call.
- If the command cannot run (plugin path absent) or exits non-zero, emit a single stderr `WARNING` and proceed non-fatally.
- Always pass `$PROPOSAL_BODY` (parsed via `scripts/util/parse-proposal.js`), never raw `$ANALYZE_JSON`, to `error-report-sdlc --error-text`.

### Path R21 — Hook Block Telemetry (Future `pre-tool-jira-write-guard.js`)

No `hooks/pre-tool-jira-write-guard.js` hook exists today. If one is implemented in the future and returns a deny decision, surface its `permissionDecisionReason` verbatim (do not retry by guessing what changed) and record telemetry:

```shell
node "<PLUGIN_ROOT>/scripts/lib/mcp-failure.js" --telemetry --class hook-block --tool "$MCP_TOOL_NAME" --site "$JIRA_SITE" --project "$PROJECT_KEY" --error "$permissionDecisionReason" --recovered no
HOOK_HASH=$(node "<PLUGIN_ROOT>/scripts/lib/mcp-failure.js" --hash "$permissionDecisionReason")
HOOK_COUNT=$(node "<PLUGIN_ROOT>/scripts/lib/mcp-failure.js" --record-occurrence --class hook-block --key "$HOOK_HASH")
```

Only when `HOOK_COUNT` equals `2` (same deny reason seen twice in this session), run the `--analyze` half of shared telemetry with `--class hook-block --tool "$MCP_TOOL_NAME" --error "$permissionDecisionReason" --recovered no --r-path R21` and step `"Step 3"`.

### Path R22 — Link Verification Abort (Step 2.7)

When `scripts/skill/jira.js --validate-body` exits non-zero, abort without dispatching and run shared telemetry with:
- `class`: `link-verification`
- `tool`: `jira.js --validate-body`
- `error`: `"link verification abort: $LINK_EXIT"`
- `r-path`: `R22`
- `step`: `"Step 2.7"`

### Path R23 — `cloudId` Authorization & Dual-Namespace Recovery (Step 3)

Triggered when an MCP response matches `isn't explicitly granted` or auth/403 with a `cloudId` substring:

1. Call `getAccessibleAtlassianResources` **once**.
2. Compare returned `cloudId`(s) against `~/.sdlc-cache/jira/<site>/<KEY>.json`.
3. If different, run `/jira-sdlc --force-refresh` and reload the cache.
4. Retry the original MCP call **once** under the primary namespace. If it still fails with the same error, log the primary failure and retry **once** under the sibling namespace (`mcp__antigravity_ai_Atlassian__`) if registered in the deferred-tools list. Persist the working namespace for the rest of the session.
5. Before trying the sibling namespace, record primary failure:

```shell
node "<PLUGIN_ROOT>/scripts/lib/mcp-failure.js" --telemetry --class auth --tool "$MCP_TOOL_NAME" --site "$JIRA_SITE" --project "$PROJECT_KEY" --error "$AUTH_ERROR" --recovered no
```

6. If the sibling namespace also fails (dual-namespace exhausted), record the sibling failure and then run shared telemetry (`--telemetry` + `--analyze`) with `class: auth`, `tool: "$MCP_TOOL_NAME"`, `error: "$AUTH_ERROR"`, `r-path: R23`, `step: "Step 3"`:

```bash
node "<PLUGIN_ROOT>/scripts/lib/mcp-failure.js" --telemetry --class auth --tool "mcp__antigravity_ai_Atlassian__${MCP_TOOL_SUFFIX}" --site "$JIRA_SITE" --project "$PROJECT_KEY" --error "$AUTH_ERROR_SIBLING" --recovered no
```

### Path R9 — Exhausted Schema / Workflow Recovery (Step 3)

Record `--telemetry` on every retry (including successful auto-refresh retries) to keep a per-session log:

```bash
node "<PLUGIN_ROOT>/scripts/lib/mcp-failure.js" --telemetry --class "$FAILURE_CLASS" --tool "$MCP_TOOL_NAME" --site "$JIRA_SITE" --project "$PROJECT_KEY" --error "$ERROR_MSG" --recovered "yes:R9"
```

When a `400` on `create` or a repeated `400` (2+ attempts) still fails after `--force-refresh` retry:
- Set `FAILURE_CLASS=schema` (field/schema errors) or `FAILURE_CLASS=workflow` (transition errors).
- Run shared telemetry (`--telemetry` + `--analyze`) with `class: "$FAILURE_CLASS"`, `tool: "$MCP_TOOL_NAME"`, `error: "$ERROR_MSG"`, `r-path: R9`, `step: "Step 3 — Error Recovery"`.

### Path R14 — Unsampled Workflow Live Transition Failure

When `workflows[type]` is `{ "unsampled": true }` (Phase 5 found no issues for that type or `--skip-workflow-discovery` was used) and the runtime fallback `getTransitionsForJiraIssue` call itself fails, run shared telemetry with `class: workflow`, `tool: getTransitionsForJiraIssue`, `error: "$TRANSITION_ERROR"`, `r-path: R14`, `step: "Step 3 — unsampled fallback"`.

---

## Gotchas & Learning Capture

### Gotchas

- **Sub-task creation:** Requires `parent: "PROJ-123"` as a top-level string parameter AND the exact subtask type name from `cache.issueTypes` (e.g., `"Sub-task"`, `"Subtask"`, or a custom name).
- **Missing transitions:** If a transition is absent from `getTransitionsForJiraIssue`, transition conditions are unmet (e.g., open subtasks remain) — this is intentional, not a bug.
- **Screen-only `requiredFields`:** Transition `requiredFields` may include screen-only fields absent from `fieldSchemas`. Try the transition without them first; some screen fields only block the Jira UI, not the API.
- **Unsampled workflows:** When Phase 5 finds zero issues for an issue type (or `--skip-workflow-discovery` is passed), cache stores `"workflows": { "<Type>": { "unsampled": true } }` (see `./REFERENCE.md` Section 0). Runtime transitions fall back to `getTransitionsForJiraIssue`.
- **MCP tool prefix:** `mcp__atlassian__` is the default; if registered under another prefix (e.g., `mcp__antigravity_ai_Atlassian__`), use the active prefix consistently across the session.

### Learning Capture

Capture project-specific discoveries in `.sdlc/learnings/log.md`:
- **Non-MCP discoveries** (non-default field formats, workflow quirks, custom subtask names, user lookup patterns, screen-only required fields): append free-form prose entries.
- **MCP failures:** always use `scripts/lib/mcp-failure.js --telemetry`, which writes a structured 5-line block under `## YYYY-MM-DD — jira-sdlc mcp-failure[<class>]: <tool>`.
