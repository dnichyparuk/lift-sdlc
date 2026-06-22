---
name: jira-sdlc
description: "Use this skill when creating, editing, reading, viewing, searching, transitioning, commenting on, or linking Jira issues using Atlassian MCP tools. Caches project metadata (custom fields, workflows, transitions, user mappings) to eliminate redundant discovery calls. Supports multi-project repos via jira.projects, and skipping workflow discovery for CI. Arguments: [--project <KEY>] [--force-refresh] [--init-templates] [--site <host>] [--skip-workflow-discovery]. Triggers on: create jira issue, edit jira ticket, search jira, transition jira, jira comment, link jira, assign jira, log work jira, bulk jira operations, manage jira, jira template, read jira, view jira, show jira, get jira, fetch jira, jira details, add comment, comment on jira, reply to jira, jira ticket, jira issue."
user-invocable: true
argument-hint: "[--project <KEY>] [--force-refresh] [--init-templates] [--site <host>] [--skip-workflow-discovery]"
model: gemini-3.5-flash-medium
---

# Managing Jira Issues

Cache Jira project metadata on first use, then execute any Jira operation — create,
edit, search, transition, comment, link, assign, worklog — using only cached values.
Eliminate all redundant discovery calls after initialization.

**Announce at start:** "I'm using jira-sdlc (sdlc v{sdlc_version})." — extract the version from the `sdlc:` line in the session-start system-reminder. If no version is in context, omit the parenthetical.

## When to Use This Skill (implements R16)

- Creating, editing, or viewing Jira issues
- Transitioning issues through workflow statuses
- Adding comments to Jira issues
- Linking two issues (blocks, relates, duplicate)
- Assigning issues to team members
- Logging work on a Jira issue
- Searching for issues via JQL
- Initializing or refreshing the project cache
- When the user asks anything Jira-related

## How This Skill Works

On first use, this skill initializes a cache at `~/.sdlc-cache/jira/<sanitizedSiteHost>/<PROJECT_KEY>.json`
containing the site's `cloudId`, issue type definitions, field schemas, workflow graphs,
link types, and user mappings. `sanitizedSiteHost` is the site URL host lowercased with
`.` replaced by `_` (e.g., `acme.atlassian.net` → `acme_atlassian_net`). The cache lives
outside the working tree and is keyed by site to support repos that map to multiple Jira
tenants. The cache is permanent by default — it does not expire on a timer. After
initialization, every subsequent operation reads exclusively from the cache. The cache is
rebuilt only when `--force-refresh` is passed or when operations fail due to stale data
(invalid transition IDs, changed field schemas). Legacy caches found at
`.sdlc/jira-cache/<KEY>.json` or `.sdlc/jira-cache/<KEY>.json` are migrated to the home
layout automatically on the next `--check`; the legacy files are left in place.

Each issue type has a description template (shipped in the skill's `templates/` directory
and customizable per project at `.sdlc/jira-templates/<Type>.md`). Templates are filled
from user context before the MCP call, producing well-structured descriptions on the first
attempt. All `{placeholder}` markers must be replaced with real content or the section
removed entirely — the API call is never made with raw placeholder text.

---

## Step 0 — Parse Arguments and Check Cache

### Arguments

| Argument | Description | Default |
|----------|-------------|---------|
| `--project <KEY>` | Jira project key (e.g., PROJ). When `jira.projects` is set, values outside the list are rejected. | Auto-detected |
| `--force-refresh` | Rebuild cache even if fresh | false |
| `--init-templates` | Copy default templates to `.sdlc/jira-templates/` | false |
| `--site <host>` | Sanitized site host (e.g., `acme_atlassian_net`). Disambiguates `--check`/`--load` when the same project key is cached under multiple sites. | Unset |
| `--skip-workflow-discovery` | Bypass Phase 5; cache `workflows[type] = { unsampled: true }` per non-subtask type. Transitions fall back to live `getTransitionsForJiraIssue` per issue. Use in CI. | false |

**Project key resolution (ordered fallback):** (implements R13)

1. `--project <KEY>` argument. When `jira.projects` is set (≥2 entries), the prepare script rejects values not in the list (exit 1).
2. Parse current git branch for `[A-Z]{2,10}-\d+` pattern (e.g., `feat/PROJ-123-fix` → `PROJ`). When `jira.projects` is set, accept only keys in the list; otherwise fall through.
3. Read `.sdlc/config.json` → `jira.defaultProject`.
4. When `jira.projects` has ≥2 entries, use AskUserQuestion with a closed list matching `jira.projects` ("Which Jira project key should I use?").
5. Use AskUserQuestion to ask: "Which Jira project key should I use? (e.g., PROJ, TEAM)".

Backward compatible: repos without `jira.projects` retain the previous 4-step behavior (1/2/3/5).

**Multi-candidate cache disambiguation:** (implements R15)

When `--check` is run without `--site` and the home-cache contains entries for the project key under two or more site subdirectories, the script returns `exists: false` and `candidateSites: [<host>, …]`. Present the `candidateSites` list to the user via AskUserQuestion and re-run with `--site <host>`, or use `--force-refresh` to rebuild against a specific site.

### Script Resolution Block

> **VERBATIM** — Execute this script directly using its absolute path (replace `<PLUGIN_ROOT>` with the absolute path to this plugin. Note the strict script location pattern: `<PLUGIN_ROOT>/skills/<skill-name>/scripts/<script-name>.sh`). Do NOT prepend `bash` or `sh`. Do not modify, rephrase, or simplify the commands.

```shell
<PLUGIN_ROOT>/skills/jira-sdlc/scripts/prepare.sh
```

Read and parse `JIRA_CONTEXT_FILE`. The `trap` above guarantees cleanup on any exit path — do not add scattered `rm -f` calls.

**On non-zero `EXIT_CODE`:**

- Exit code 1: JSON contains `errors[]`. Show each error and stop.
- Exit code 2: Show `Script error — see output above` and stop.

### Cache Status Evaluation

**Hook context fast-path:** If the session-start system-reminder contains a `Jira cache:` line with `stale`, use it to skip the `skill/jira.js --check` cache status check and immediately prompt for `--force-refresh`. If the line shows the cache as current, proceed with `skill/jira.js` as normal — the prepare script validates more deeply than the hook's age check. The hook context is a session-start snapshot.

Read the check output:

- If `exists: false` → cache not initialized. Proceed to **Step 1**.
- If `missing` array contains required sections (`cloudId`, `project`, `issueTypes`, `fieldSchemas`) → cache incomplete. Proceed to **Step 1**.
- If `--force-refresh` passed → rebuild regardless of age. Proceed to **Step 1**.
- If `fresh: false` AND `maxAgeHours > 0` → TTL-based expiry exceeded. Proceed to **Step 1**.
- Otherwise (cache exists, complete, and either permanent or within TTL) → load cache via `--load`, skip to **Step 2**.

Load cache:

```bash
node "$SCRIPT" --project "$PROJECT_KEY" --load > "$JIRA_CONTEXT_FILE"
```

### Handle `--init-templates`

If `--init-templates` flag is present:

1. Run the init-templates script:
   ```bash
   INIT_RESULT=$(node "$SCRIPT" --output-file --project "$PROJECT_KEY" --init-templates)
   # Append cleanup to the existing trap. Note: the JIRA_CONTEXT_FILE trap from
   # the entry section is still in effect; we extend it here so both files are
   # removed on EXIT/INT/TERM.
   trap 'rm -f "$JIRA_CONTEXT_FILE" "$INIT_RESULT"' EXIT INT TERM
   ```

2. Read and parse the output. Report: "N templates initialized (exact match), N skipped (already exist)."

3. If `unavailable` array is non-empty AND the cache is loaded:
   - Announce: "Found N issue types with no matching default template. I'll suggest a template for each based on its Jira hierarchy level."
   - For each unavailable type, look up its metadata in `cache.issueTypes[typeName]`:
     - Determine suggestion based on `hierarchyLevel`:
       - `hierarchyLevel === 1` → suggest "Epic"
       - `hierarchyLevel === 0` and `subtask === false` → suggest "Task"
       - `subtask === true` → suggest "Skip (subtask)"
       - No `hierarchyLevel` available → no suggestion, present all options equally
     - Use AskUserQuestion:
       > Issue type "[typeName]" (hierarchy level: [N]) has no matching template.
       > Which default template should I use?

       Options: [Suggested template (Recommended)], [other available default templates], [Skip — no template for this type]
   - For each user selection (not "Skip"), copy the template:
     ```bash
     node "$SCRIPT" --project "$PROJECT_KEY" --copy-template --type "<typeName>" --from "<selectedTemplate>"
     ```
   - Report final results: "N additional templates created from user selections."

4. Cleanup is automatic — the `trap` declared at step 1 removes `$INIT_RESULT` (and `$JIRA_CONTEXT_FILE`) on shell exit.

5. Stop. Do not proceed with any Jira operation.

---

## Step 1 — Deterministic Cache Initialization

> Run this phase only when the cache is missing, incomplete, `--force-refresh` is set,
> a TTL-based expiry was exceeded, or an operation error triggered an auto-refresh.
> After it completes, the skill never calls discovery endpoints again until the next refresh.

Announce: "Initializing Jira cache for project `[PROJECT_KEY]`…"

### Phase 1 — Identity (run BOTH in parallel)

```
mcp__atlassian__getAccessibleAtlassianResources()
→ Extract: sites[0].id → cloudId
           sites[0].url → siteUrl

mcp__atlassian__atlassianUserInfo()
→ Extract: accountId → currentUser.accountId
           displayName → currentUser.displayName
           emailAddress → currentUser.email
```

### Phase 2 — Project metadata (run BOTH in parallel, needs cloudId)

```
mcp__atlassian__getVisibleJiraProjects({ cloudId, searchString: PROJECT_KEY })
→ Extract: values[0].key, values[0].name, values[0].id → project object

mcp__atlassian__getIssueLinkTypes({ cloudId })
→ Extract: issueLinkTypes array → linkTypes (name, inward, outward per entry)
```

### Phase 3 — Issue types (needs project)

```
mcp__atlassian__getJiraProjectIssueTypesMetadata({ cloudId, projectKey: PROJECT_KEY })
→ Extract: for each issue type: name → key, id, subtask boolean, hierarchyLevel (integer)
→ Store as: issueTypes = { "Task": { "id": "10001", "subtask": false, "hierarchyLevel": 0 }, ... }
```

### Phase 4 — Field schemas (one call per issue type, run ALL in parallel)

For each issueType from Phase 3:

```
mcp__atlassian__getJiraIssueTypeMetaWithFields({ cloudId, projectKey, issueTypeId: issueType.id })
→ Extract: ALL fields — standard AND custom
→ For each field: name, key (fieldId), required (boolean), schema.type, allowedValues
→ Field type mapping:
    API type "string"            → cache type "string"
    API type "number"            → cache type "number"
    API type "priority"          → cache type "priority" (has allowedValues)
    API type "option"            → cache type "option" (custom single-select)
    API type "array" of "option" → cache type "multi-option" (custom multi-select)
    API type "user"              → cache type "user"
    API type "date"              → cache type "date" (format: YYYY-MM-DD)
    API type "datetime"          → cache type "datetime" (ISO-8601)
→ Store allowedValues as flat string arrays (extract the name or value property)
→ Store in: fieldSchemas[issueTypeName] = { [fieldKey]: { required, type, name?, allowedValues? } }
```

### Phase 5 — Workflow discovery (per non-subtask issue type) (implements R14)

**Skip branch (when `flags.skipWorkflowDiscovery` is `true` in the `--check` output):**

Do not issue any of the Phase 5a/5b/5c calls. Instead, for each non-subtask issue type in
`issueTypes`, write:

```json
"workflows": { "<issueTypeName>": { "unsampled": true } }
```

Subtask types are omitted (no workflow entry). Transitions at runtime fall back to a live
`getTransitionsForJiraIssue` call per issue — the existing stale-cache auto-refresh path
handles `unsampled` markers identically to a cache miss. Use this branch in CI and other
pre-seeded environments where Phase 5 is too expensive.

**Standard branch (default):**

For each non-subtask issue type in `issueTypes`:

**5a** — Find all statuses in use:

```
mcp__atlassian__searchJiraIssuesUsingJql({
  cloudId,
  jql: `project = "${PROJECT_KEY}" AND issuetype = "${issueTypeName}" ORDER BY status ASC`,
  fields: ["status"],
  maxResults: 100
})
→ Extract unique status names from results
```

**5b** — For each unique status, find one issue in that status:

```
mcp__atlassian__searchJiraIssuesUsingJql({
  cloudId,
  jql: `project = "${PROJECT_KEY}" AND issuetype = "${issueTypeName}" AND status = "${statusName}"`,
  fields: ["status"],
  maxResults: 1
})
→ Get issues[0].key
```

**5c** — Get transitions from that status:

```
mcp__atlassian__getTransitionsForJiraIssue({ cloudId, issueKey })
→ Extract: for each transition: id, name, to.name (target status)
→ Extract requiredFields: if transition has a screen, extract field schemas for required fields
→ Store in: workflows[issueTypeName].transitions[currentStatusName] = [
    { "id": "21", "name": "...", "to": "...", "requiredFields": { ... } }
  ]
```

If no issues exist in a given status (5b returns empty), skip that status — note it in
`workflows[type].statuses` as known but unsampled.

### Phase 6 — Assemble and save cache

Assemble the full cache object:

```json
{
  "version": 1,
  "lastUpdated": "<current ISO timestamp>",
  "maxAgeHours": 0,
  "cloudId": "...",
  "siteUrl": "...",
  "currentUser": { "accountId": "...", "displayName": "...", "email": "..." },
  "project": { "key": "...", "name": "...", "id": "..." },
  "issueTypes": { "Task": { "id": "10001", "subtask": false, "hierarchyLevel": 0 }, "Bug": { "id": "10002", "subtask": false, "hierarchyLevel": 0 }, "Epic": { "id": "10005", "subtask": false, "hierarchyLevel": 1 }, "Sub-task": { "id": "10004", "subtask": true, "hierarchyLevel": -1 } },
  "fieldSchemas": { "Task": { "summary": { "required": true, "type": "string" }, "...": {} } },
  "workflows": { "Task": { "transitions": { "To Do": [ { "id": "21", "name": "...", "to": "...", "requiredFields": {} } ] } } },
  "linkTypes": [ { "name": "Blocks", "inward": "is blocked by", "outward": "blocks" } ],
  "userMappings": {}
}
```

Save:

```bash
echo '<cache_json>' | node "$SCRIPT" --project "$PROJECT_KEY" --save
```

Then load the cache:

```bash
node "$SCRIPT" --project "$PROJECT_KEY" --load > "$JIRA_CONTEXT_FILE"
```

Report: "Cache initialized for `[PROJECT_KEY]` — `[N]` issue types, `[N]` workflow states mapped."

---

## Step 2 — Classify Operation

Parse user intent into one of these operations:

| Operation | Trigger Phrases | Calls with cache |
|-----------|----------------|-----------------|
| `create` | create issue, new ticket, add bug/story/task | 1 |
| `edit` | update, change, set priority/label/assignee | 1 |
| `search` | find, list, show, search, which issues | 1 |
| `transition` | move to, start, close, complete, done, in progress | 1–2 |
| `comment` | comment on, add note, reply | 1 |
| `link` | link to, blocks, relates to, duplicate | 1 |
| `assign` | assign to, give to, ownership | 1–2 |
| `worklog` | log time, log work, spent time | 1 |
| `view` | show, get, display, details of | 1 |
| `bulk` | create N issues, multiple operations | N |

For ambiguous requests, use AskUserQuestion to ask one clarifying question before classifying.

---

## Step 2.5 — Critique (write-ops only, R20)

Skip this step for read operations (`search`, `view`). For every write operation (`create`, `edit`, `transition`, `comment`, `link`, `assign`, `worklog`, `bulk`), run a critique pass against the proposed payload **before** showing it to the user. Implements R20.

1. Build the initial payload exactly as you would dispatch it (template-resolved per R18, placeholders resolved per R19, fields validated against cache per G5/G6/G8).
   - **Template resolution and fallback notices (R18):** Read `resolved`, `fallbacks`, and `noneTypes` from the prepare script output (`resolveTemplateStatus`). For each entry in `fallbacks`, print a one-line notice before building the payload:
     `Using <fallbackTo> template for <type> — override at .sdlc/jira-templates/<type>.md`
     For each entry in `noneTypes`, print a one-line warning and stop the operation:
     `No template for <type>. Run /jira-sdlc --init-templates or create .sdlc/jira-templates/<type>.md`
     Sub-bug, Sub-task, and Subtask types resolve via the FALLBACK_MAP in the prepare script (Sub-bug → Bug, Sub-task → Task, Subtask → Task) — the skill never re-derives this mapping.
2. Run the critique checklist:
   - **Template completeness** (create / description-touching edit) — every `## ` heading in the payload description belongs to the resolved template; no invented sections.
   - **Field correctness** — issue type / project key / parent / components / labels match cached `allowedValues`.
   - **Workflow validity** — for `transition`, the target status is reachable per the cached workflow graph (R6).
   - **Terminology consistency** — summary vocabulary matches description vocabulary (no contradictions).
   - **Terse content (R25)** — every `## ` section body in the description payload is a bullet list, numbered list, sub-heading set, or (Release Notes only) a single sentence. No paragraph longer than two consecutive non-list non-heading lines in any section. No filler transitional sentences between sections (`This ticket covers…`, `In summary…`, `The goal of…`). The `## Acceptance Criteria` section body is exclusively `- [ ] …` checklist items — no prose introduction, no prose summary, no sentence-form criteria. Summary is an imperative phrase ≤ 100 characters with no filler tokens (`This task covers`, `The goal of`, `We need to make sure`). Surface any violations in the `Critique:` block.
3. Compute `payload_hash` and write the critique artifact:
   ```js
   const { payloadHash } = require('./lib/payload-hash.js');
   const { writeCritique } = require('./lib/artifact-store.js');
   const hash = payloadHash(toolInput);
   writeCritique(hash, { initial: '<one-line summary of initial draft>', findings: [...], final: '<one-line summary of final payload>' });
   ```
4. Surface the critique to the user as an `Initial:` / `Critique:` / `Final:` block — do not apply deltas silently.

## Step 2.6 — Approval (write-ops only, R17)

Skip for read operations. Implements R17 + the cooperative half of R21.

1. Print the full final payload (not a summary — the bytes the MCP call will dispatch).
2. Call `AskUserQuestion` with three options:
   - **approve** — proceed to Step 3 dispatch
   - **change <what>** — describe the desired change; loop back to Step 2.5 with the revised draft (new `payload_hash`, fresh artifacts; the previous artifacts are stale and will be auto-purged)
   - **cancel** — abort the operation, do not dispatch
3. On `approve` only, write the approval token:
   ```js
   const { writeApprovalToken } = require('./lib/artifact-store.js');
   writeApprovalToken(hash);
   ```
4. Proceed to Step 3.

## Step 2.7 — Link verification (write-ops only, R22, issue #198) — HARD GATE

Skip for read operations. After approval (Step 2.6) and before MCP dispatch, validate every URL embedded in the description payload (for `createJiraIssue`/`editJiraIssue`) and the comment body (for `addCommentToJiraIssue`) via `scripts/skill/jira.js --validate-body`. The script reads the body from stdin and resolves the expected Jira site (`siteUrl`) deterministically from the cached `~/.sdlc-cache/jira/<site>/<KEY>.json` — the skill MUST NOT construct ctx JSON.

```shell
<PLUGIN_ROOT>/skills/jira-sdlc/scripts/validate_body.sh
```

For ADF description payloads: extract every `text` node value, concatenate with newlines, and feed that as the body. URLs in ADF link marks must also appear in extracted text or be added explicitly to the validation input.

On non-zero exit (`LINK_EXIT != 0`):
- The script has already printed the violation list to stderr (URL, line, reason code, observed/expected detail)
- Do NOT dispatch the MCP write tool — the payload is never sent to Jira
- Surface the violation list verbatim to the user
- Stop. Do not retry. Do not edit URLs without user input. Do not bypass.
- **MCP failure telemetry + dispatch gate (R27/R28 — implements R22 exhausted path):**

> **Telemetry helper conventions (apply to every `mcp-failure.js` callsite below):**
> - HELPER is resolved inline at the top of each top-level step (R9/R14/R21/R22/R23) rather than once globally because steps may be entered independently. The `find` is idempotent and cheap.
> - The helper's stdout (`--telemetry` echoes the appended block, `--analyze` emits JSON) is intentionally NOT redirected to `/dev/null` — the block surfaces in the terminal for user visibility into what was written to `.sdlc/learnings/log.md`.
> - Cross-step session counting (R28 "twice in one invocation") is keyed by `SDLC_SESSION_ID` if set, otherwise by a per-project marker file at `.sdlc/state/mcp-session.id` written on first call. Callers do not need to export `SDLC_SESSION_ID` for the R21 dedup gate to function.
> - When the helper cannot be resolved (plugin not installed or `find` returns empty and the cwd fallback also misses), each block emits a single stderr WARNING and proceeds non-fatally. The downstream `[ -n "$HELPER" ] && node "$HELPER" ...` guards then skip the call without aborting the surrounding step. The warning satisfies the script-resolution convention while preserving R27's "telemetry is best-effort" design intent.
> - `ANALYZE_JSON` is the raw JSON string emitted by `node "$HELPER" --analyze ...` — it is NOT an object. To use `.proposal.title` and `.proposal.body`, parse explicitly:
>
>   ```shell
>   PROPOSAL_TITLE=$(printf '%s' "$ANALYZE_JSON" | <PLUGIN_ROOT>/skills/jira-sdlc/scripts/parse_proposal.sh title)
>   PROPOSAL_BODY=$(printf  '%s' "$ANALYZE_JSON" | <PLUGIN_ROOT>/skills/jira-sdlc/scripts/parse_proposal.sh body)
>   ```
>
>   Every "Read `ANALYZE_JSON.proposal.title` / `.proposal.body`" instruction below refers to the result of this parse — pass `$PROPOSAL_BODY` (not raw `$ANALYZE_JSON`) to `error-report-sdlc --error-text`.

```shell
<PLUGIN_ROOT>/skills/jira-sdlc/scripts/mcp_failure_link.sh
```

Then call `--analyze` and surface the returned proposal to the user:

```bash
[ -n "$HELPER" ] && ANALYZE_JSON=$(node "$HELPER" --analyze --class link-verification --tool "jira.js --validate-body" --site "$JIRA_SITE" --project "$PROJECT_KEY" --error "link verification abort: $LINK_EXIT" --recovered no --r-path R22)
```

Read `ANALYZE_JSON.proposal.title` and `ANALYZE_JSON.proposal.body`; present to user verbatim with prompt "Y (file issue) / edit / skip". On Y, dispatch `error-report-sdlc` with `--error-type mcp-link-verification`, `--skill jira-sdlc`, `--step "Step 2.7"`, `--operation "jira.js --validate-body"`, `--error-text <proposal.body>`, and labels `mcp-failure,class:link-verification`.

On zero exit, proceed to Step 3.

`SDLC_LINKS_OFFLINE=1` skips network reachability checks but keeps structural context-aware checks (GitHub identity match, Atlassian host match) — use this in sandboxed CI runs.

## Step 3 — Execute Operation

For write operations: precondition — Step 2.6 returned `approve`, Step 2.7 link verification passed, and both artifacts (`approval-<hash>.token`, `critique-<hash>.json`) are on disk. The PreToolUse hook (`hooks/pre-tool-jira-write-guard.js`) re-derives the hash from `tool_input`, verifies both artifacts, and BLOCKS dispatch otherwise (R21). If dispatch is blocked, surface the hook's `permissionDecisionReason` to the user verbatim — do not retry by guessing what changed.

**MCP failure telemetry on hook deny (R27/R28 — R21 path):** When the PreToolUse hook blocks, call the helper immediately after surfacing the deny reason:

```shell
<PLUGIN_ROOT>/skills/jira-sdlc/scripts/mcp_failure_hook.sh
```

When `HOOK_COUNT` equals 2 (same hook deny reason seen twice in this session), call `--analyze` and surface the dispatch gate:

```bash
[ -n "$HELPER" ] && [ "$HOOK_COUNT" -eq 2 ] && ANALYZE_JSON=$(node "$HELPER" --analyze --class hook-block --tool "$MCP_TOOL_NAME" --site "$JIRA_SITE" --project "$PROJECT_KEY" --error "$permissionDecisionReason" --recovered no --r-path R21)
```

Read `ANALYZE_JSON.proposal.title` and `ANALYZE_JSON.proposal.body`; present to user verbatim with prompt "Y (file issue) / edit / skip". On Y, dispatch `error-report-sdlc` with `--error-type mcp-hook-block`, `--skill jira-sdlc`, `--step "Step 3"`, `--operation "$MCP_TOOL_NAME"`, `--error-text <proposal.body>`, and labels `mcp-failure,class:hook-block`.

**On cloudId authorization error** (response text matches `isn't explicitly granted` or auth/403 with cloudId substring) — implements spec R23:

1. Call `getAccessibleAtlassianResources` exactly once.
2. Compare the returned cloudId(s) against the cached value at `~/.sdlc-cache/jira/<site>/<KEY>.json`.
3. If different, run `/jira-sdlc --force-refresh` and reload the cache.
4. Retry the original MCP call exactly once under the primary namespace. If it still fails with the same error — try the sibling namespace (`mcp__antigravity_ai_Atlassian__`) once if registered.
5. If the primary namespace retry failed, call the helper with `--recovered no` before trying the sibling namespace:

```shell
<PLUGIN_ROOT>/skills/jira-sdlc/scripts/mcp_failure_auth.sh
```

6. If the sibling namespace also fails (dual-namespace exhausted), call `--telemetry` again and then `--analyze` to trigger the R28 dispatch gate:

```bash
[ -n "$HELPER" ] && node "$HELPER" --telemetry --class auth --tool "mcp__antigravity_ai_Atlassian__${MCP_TOOL_SUFFIX}" --site "$JIRA_SITE" --project "$PROJECT_KEY" --error "$AUTH_ERROR_SIBLING" --recovered no
[ -n "$HELPER" ] && ANALYZE_JSON=$(node "$HELPER" --analyze --class auth --tool "$MCP_TOOL_NAME" --site "$JIRA_SITE" --project "$PROJECT_KEY" --error "$AUTH_ERROR" --recovered no --r-path R23)
```

Read `ANALYZE_JSON.proposal.title` and `ANALYZE_JSON.proposal.body`; present to user verbatim with prompt "Y (file issue) / edit / skip". On Y, dispatch `error-report-sdlc` with `--error-type mcp-auth`, `--skill jira-sdlc`, `--step "Step 3"`, `--operation "$MCP_TOOL_NAME"`, `--error-text <proposal.body>`, and labels `mcp-failure,class:auth`.

After Step 2 classifies the operation type, read `./resources/operations-reference.md` and follow the procedure for the matching operation type.

| Classified Operation | Section in resources/operations-reference.md |
|---------------------|------------------------------------|
| `create` | Create Operation |
| `edit` | Edit Operation |
| `search` | Search Operation |
| `transition` | Transition Operation |
| `comment` | Comment Operation |
| `link` | Link Operation |
| `assign` | Assign Operation |
| `worklog` | Worklog Operation |
| `view` | View Operation |
| `bulk` | Bulk Operation |

---

## Step 4 — Post-Operation Cache Updates

After operations that reveal new information, update the cache incrementally:

| Trigger | Cache update command |
|---------|---------------------|
| New user resolved via lookupJiraAccountId | `echo '{"<name>":"<id>"}' \| node "$SCRIPT" --project "$KEY" --save-field userMappings` |
| Transition from a status not in workflow cache | `echo '<workflows_json>' \| node "$SCRIPT" --project "$KEY" --save-field workflows` |
| Cache returned stale transition ID (404/400) | **Auto-refresh**: run `--force-refresh`, reload cache, retry operation once |
| Operation fails with field key or value not in cache | **Auto-refresh**: run `--force-refresh`, reload cache, retry operation once |

---

## Error Recovery

| Error | Diagnosis | Recovery |
|-------|-----------|----------|
| 400 on create | Missing required field or wrong field shape | Verify field key/shape against the cached `fieldSchemas` object. If the field doesn't match, run `--force-refresh`, reload cache, retry once. If still failing after refresh, use the **gated dispatch** below (R9 exhausted path) |
| 400 on transition | Missing required transition field (e.g., resolution) | Check `workflows[type].transitions[status][n].requiredFields`; include required fields. If transition ID is not recognized, **auto-refresh**: run `--force-refresh`, reload cache, retry once |
| 400 on edit | Wrong field shape or incorrect custom field key | Verify field key/shape against the cached `fieldSchemas` object. If the field doesn't match, run `--force-refresh`, reload cache, retry once. If field format details are needed, Read `./resources/REFERENCE.md` Section 2 only |
| 401 | Auth token expired | Reconnect Atlassian MCP; cannot recover programmatically |
| 403 | Insufficient permission | Report to user — cannot fix |
| 404 issue | Issue key wrong or issue deleted | Ask user to verify the issue key |
| 404 project | Wrong project key or no access | Re-run `--check`; verify cloudId matches the correct site |
| 409 | Concurrent edit conflict | Retry the operation once |
| Stale transition | Transition ID no longer valid | **Auto-refresh**: run `--force-refresh`, reload cache, retry with new IDs |
| Repeated 400 (2+ attempts) | Cache may have incorrect schema data | **Auto-refresh**: run `--force-refresh`, reload cache, retry once. If still failing after refresh, use the **gated dispatch** below (R9 exhausted path) |

**R9 exhausted path — MCP failure telemetry + gated dispatch (R27/R28):**

When a 400 on create or repeated 400 still fails after cache auto-refresh, call the helper to record telemetry and synthesize the dispatch proposal. Classify: `schema` for field/schema errors, `workflow` for transition errors.

```shell
<PLUGIN_ROOT>/skills/jira-sdlc/scripts/mcp_failure_schema.sh
```

Read `ANALYZE_JSON.proposal.title` and `ANALYZE_JSON.proposal.body`; present to user verbatim with prompt "Y (file issue) / edit / skip". On Y, dispatch `error-report-sdlc` with `--error-type mcp-${FAILURE_CLASS}`, `--skill jira-sdlc`, `--step "Step 3 — Error Recovery"`, `--operation "$MCP_TOOL_NAME"`, `--error-text <proposal.body>`, and labels `mcp-failure,class:${FAILURE_CLASS}`.

Also call `--telemetry` on every retry (even successful ones) to maintain a per-session failure log:

```bash
[ -n "$HELPER" ] && node "$HELPER" --telemetry --class "$FAILURE_CLASS" --tool "$MCP_TOOL_NAME" --site "$JIRA_SITE" --project "$PROJECT_KEY" --error "$ERROR_MSG" --recovered "yes:R9"
```

---

## Quality Gates

| Gate | Check |
|------|-------|
| Cache loaded | `cloudId`, `project`, `issueTypes`, `fieldSchemas` all present before any operation |
| Content format | Comment calls use `contentFormat: "adf"` with ADF body from conversion script; description/create calls use `contentFormat: "markdown"` |
| Response format | Every content-returning call uses `responseContentFormat: "markdown"` |
| No raw placeholders | All `{placeholder}` markers in templates filled or section removed |
| Required fields | All required fields per `fieldSchemas` have values before create |
| Transition safety | Transition `id` from cache or fresh `getTransitionsForJiraIssue`, never guessed |
| User disambiguation | `lookupJiraAccountId` results always disambiguated if multiple matches |
| No fabricated values | All field values derived from cache `allowedValues` or user input |
| Approval gate (G9) | No write MCP call dispatched without an `approve` from the R17 prompt in this turn |
| Template enforced (G10) | No `description` field built without a resolved template — `.sdlc/jira-templates/<Type>.md` (override) or shipped `templates/<Type>.md` (R18) |
| Placeholders resolved (G11) | No `low`-confidence `{name}` or `[prose]` marker dispatched without explicit user resolution (R19) |
| Critique surfaced (G12) | No proposal presented to the user without a preceding `Initial:` / `Critique:` / `Final:` block (R20) |
| Hook verified (G13) | No write MCP call dispatched without the PreToolUse hook successfully verifying R21 artifacts (payload-hash bound, < 10 min old) |
| Link verified (G14, R22, #198) | No write MCP call (`createJiraIssue`, `editJiraIssue`, `addCommentToJiraIssue`) dispatched without `scripts/skill/jira.js --validate-body` returning exit 0. The script enforces — SKILL.md only invokes it. See Step 2.7. |
| Terse content (G15) | No `createJiraIssue` / `editJiraIssue` dispatch where the description's `## Acceptance Criteria` section contains non-checklist lines — blocked deterministically by `hooks/pre-tool-jira-write-guard.js` (R25.2). Bullet/no-prose enforcement for all other description sections is LLM-driven via the Step 2.5 critique checklist (R25.1, R25.3, R25.4). |

---

## DO

- Present the full final payload before any write MCP call (R17)
- Resolve a description template — override or shipped — before building `description` (R18)
- Escalate every low-confidence placeholder marker via `AskUserQuestion` (R19)
- Run a critique pass before the approval gate; surface findings to the user (R20)
- Write critique + approval artifacts via `lib/artifact-store.js` and use `lib/payload-hash.js` for the canonical hash (R21)
- Compose description section bodies as bullet lists or numbered lists; emit `## Acceptance Criteria` content as `- [ ] …` checklist items only (R25)

## DO NOT

- Post comments with `contentFormat: "markdown"` — always convert to ADF via `markdown-to-adf.js` first and use `contentFormat: "adf"`
- Call `getAccessibleAtlassianResources` after cache init — use cached `cloudId`
- Call `getJiraIssueTypeMetaWithFields` after cache init — use cached `fieldSchemas`
- Call `getIssueLinkTypes` after cache init — use cached `linkTypes`
- Pass transition name to `transitionJiraIssue` — requires `{ id: "..." }` object
- Pass display name as assignee — requires `{ accountId: "..." }`
- Guess field IDs, custom field keys, or transition IDs
- Skip required fields for transitions (e.g., resolution when closing)
- Use values not in cache `allowedValues` — never fabricate enum values
- Retry a failed operation more than once without diagnosing the cause first
- Leave raw `{placeholder}` syntax in issue descriptions
- Ignore custom templates at `.sdlc/jira-templates/<Type>.md` when they exist
- Generate unstructured descriptions when a template is available
- Dispatch a write MCP without an `approve` answer to the R17 prompt in this turn (R17)
- Use a free-form description on `createJiraIssue` or `editJiraIssue` (R18)
- Fill `[bracketed prose]` or `{name}` placeholders from inference — every `low`-confidence marker requires explicit user resolution (R19)
- Apply critique deltas silently — always surface the `Initial:` / `Critique:` / `Final:` block (R20)
- Bypass `lib/artifact-store.js` with direct `fs.writeFile` calls — direct writes break the canonical hash contract the hook verifies (R21)
- Write prose paragraphs in description sections — bullet lists, numbered lists, or sub-headings only (R25)
- Write acceptance criteria as sentences — every item is `- [ ] <discrete criterion>` (R25)
- Add filler transitional sentences between description sections (`This ticket covers…`, `The goal of…`, `In summary…`) (R25)

---

## Gotchas

- `createJiraIssue` uses `issueTypeName` (string `"Task"`), NOT `issueTypeId` (`"10001"`)
- `editJiraIssue.fields` is a flat object — do NOT nest under `fields.fields`
- `additional_fields` on create is for everything beyond summary/description/assignee/parent
- Priority values are `{ name: "High" }` — NOT `{ id: "2" }` or bare `"High"`
- Labels are flat strings `["label1"]` — NOT `[{ name: "label1" }]`
- Components are objects `[{ name: "API" }]` — NOT flat strings `["API"]`
- Custom single-select uses `{ value: "Option" }` — NOT `{ name: "Option" }`
- Sprint field is a number (sprint ID integer) — NOT the sprint name or an object
- `lookupJiraAccountId` may return multiple results — always disambiguate with the user
- JQL values with special characters need escaping: `summary ~ "can\\'t"` not `"can't"`
- Sub-task creation requires `parent: "PROJ-123"` as a string parameter AND the exact subtask type name from `cache.issueTypes` (may be `"Sub-task"`, `"Subtask"`, or custom)
- When a transition is absent from `getTransitionsForJiraIssue` results, it means transition conditions aren't met (e.g., all subtasks must be closed) — missing transitions are intentional, not a bug
- Transition `requiredFields` may include screen-only fields not in `fieldSchemas` — if a required field is absent from the schema, try the transition without it first; screen fields sometimes only block the Jira UI, not the API
- `getVisibleJiraProjects` uses `searchString` (not `query`) for filtering — check parameter name before calling
- When Phase 5 workflow sampling finds no issues at all for a type, skip workflow discovery for that type entirely and note it in the cache as `"workflows": { "Story": { "unsampled": true } }`
- `unsampled: true` markers (from `--skip-workflow-discovery` in CI, or from no-sample results above) route transition operations through a live `getTransitionsForJiraIssue` per issue — the skill reuses the existing stale-cache auto-refresh path, so no separate branch is required in Step 3. Treat `unsampled` identically to "transition ID not cached". **When the live `getTransitionsForJiraIssue` call itself fails on an unsampled path (R14 exhausted), record telemetry and trigger the analyze gate (R27/R28):**

```shell
<PLUGIN_ROOT>/skills/jira-sdlc/scripts/mcp_failure_workflow.sh
```

Present `ANALYZE_JSON.proposal.title` and `ANALYZE_JSON.proposal.body` verbatim with prompt "Y (file issue) / edit / skip". On Y, dispatch `error-report-sdlc` with `--error-type mcp-workflow`, `--skill jira-sdlc`, `--step "Step 3 — unsampled fallback"`, `--operation "getTransitionsForJiraIssue"`, `--error-text <proposal.body>`, and labels `mcp-failure,class:workflow`.
- The `mcp__atlassian__` prefix is the default; if the user's MCP is registered under a different prefix (e.g., `mcp__antigravity_ai_Atlassian__`), use the active prefix consistently across all calls in the session
- **Namespace fallback (spec R23):** When the primary namespace (`mcp__atlassian__`) returns a cloudId authorization error and `mcp__antigravity_ai_Atlassian__` is also registered (visible in the deferred-tools list), retry the operation under the sibling namespace once. Persist the working namespace for the rest of the session — do not re-probe per-call. Combine with the Step 3 cloudId-error ladder: namespace-fallback is the second leg after the cache-refresh retry fails.
- **Release Notes is the one allowed single-sentence carve-out (R25.5).** The `## Release Notes` section in Bug and Story templates may contain a single sentence — it is changelog-bound and bullet form is contextually awkward. Two or more sentences in this section fail the R25 critique check. All other sections must use bullet lists, numbered lists, or sub-headings.

---

## Learning Capture

When executing Jira operations, capture discoveries by appending to `.sdlc/learnings/log.md`.
Record entries for: field formats that differ from the defaults documented here, workflow
quirks discovered in specific projects, issue type names that aren't standard (e.g., custom
subtask type names), user lookup disambiguation patterns, and transition required fields not
captured by the workflow sampling.

**MCP failures use the structured R27 form** (written by `scripts/lib/mcp-failure.js --telemetry`). The helper writes a 5-line block under a `## YYYY-MM-DD — jira-sdlc mcp-failure[<class>]: <tool>` heading. Non-MCP discoveries continue to use the free-form prose style above.

## What's Next

After completing a Jira operation, common follow-ups include:
- `/plan-sdlc` — write an implementation plan for a ticket
- `/execute-plan-sdlc` — execute an existing plan

## See Also

- [`/plan-sdlc`](../plan-sdlc/SKILL.md) — write an implementation plan from a Jira ticket
- [`/execute-plan-sdlc`](../execute-plan-sdlc/SKILL.md) — execute an existing plan
