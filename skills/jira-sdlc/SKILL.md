---
name: jira-sdlc
description: "Use this skill when creating, editing, reading, viewing, searching, transitioning, commenting on, or linking Jira issues using Atlassian MCP tools. Caches project metadata (custom fields, workflows, transitions, user mappings) to eliminate redundant discovery calls. Supports multi-project repos via jira.projects, and skipping workflow discovery for CI. Arguments: [--project <KEY>] [--force-refresh] [--init-templates] [--site <host>] [--skip-workflow-discovery]. Triggers on: create jira issue, edit jira ticket, search jira, transition jira, jira comment, link jira, assign jira, log work jira, bulk jira operations, manage jira, jira template, read jira, view jira, show jira, get jira, fetch jira, jira details, add comment, comment on jira, reply to jira, jira ticket, jira issue."
user-invocable: true
argument-hint: "[--project <KEY>] [--force-refresh] [--init-templates] [--site <host>] [--skip-workflow-discovery]"
model: gemini-3.8-flash-medium
---

# Managing Jira Issues

Cache Jira project metadata on first use, then execute any Jira operation — create,
edit, search, transition, comment, link, assign, worklog — using only cached values.
Eliminate all redundant discovery calls after initialization.

**Announce at start:** "I'm using jira-sdlc (sdlc v{sdlc_version})." — extract the version from the `sdlc:` line in the session-start system-reminder. If no version is in context, omit the parenthetical.

## When to Use This Skill

Any Jira operation — create, edit, view, search, transition, comment, link, assign, log
work, or bulk (see Step 2 for classification) — plus initializing or refreshing the
project cache.

## How This Skill Works

Cache Jira project metadata once per site at
`~/.sdlc-cache/jira/<sanitizedSiteHost>/<PROJECT_KEY>.json` (host lowercased, `.` → `_`,
e.g. `acme.atlassian.net` → `acme_atlassian_net`; lives outside the working tree, keyed by
site for multi-tenant repos), then serve every subsequent operation exclusively from the
cache — no repeat discovery calls. The cache is permanent by default and rebuilt only per
Step 0's cache-status evaluation (`--force-refresh` or a stale-data failure). Legacy
caches at `.sdlc/jira-cache/<KEY>.json` migrate to this layout automatically on the next
`--check`; the legacy file is left in place.

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

**Project key resolution (ordered fallback):**

1. `--project <KEY>` argument. When `jira.projects` is set (≥2 entries), the prepare script rejects values not in the list (exit 1).
2. Parse current git branch for `[A-Z]{2,10}-\d+` pattern (e.g., `feat/PROJ-123-fix` → `PROJ`). When `jira.projects` is set, accept only keys in the list; otherwise fall through.
3. Read `.sdlc/config.json` → `jira.defaultProject`.
4. When `jira.projects` has ≥2 entries, use AskUserQuestion with a closed list matching `jira.projects` ("Which Jira project key should I use?").
5. Use AskUserQuestion to ask: "Which Jira project key should I use? (e.g., PROJ, TEAM)".

Backward compatible: repos without `jira.projects` retain the previous 4-step behavior (1/2/3/5).

**Multi-candidate cache disambiguation:**

When `--check` is run without `--site` and the home-cache contains entries for the project key under two or more site subdirectories, the script returns `exists: false` and `candidateSites: [<host>, …]`. Present the `candidateSites` list to the user via AskUserQuestion and re-run with `--site <host>`, or use `--force-refresh` to rebuild against a specific site.

### Script Resolution Block

> **VERBATIM** — Execute this command directly with `node` and the absolute plugin path (replace `<PLUGIN_ROOT>` with the absolute path to this plugin. Note the strict CLI location pattern: `<PLUGIN_ROOT>/scripts/<skill|util|lib>/<script-name>.js`). Do not modify, rephrase, or simplify the flags.

```shell
JIRA_CONTEXT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/jira.js" $ARGUMENTS --check)
EXIT_CODE=$?
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

Load cache. `--load` prints the path of a temp manifest (via `writeOutput`), **not** the
cache JSON — capture that path into `JIRA_CONTEXT_FILE` (never redirect stdout into it,
which would overwrite the manifest with its own path):

```bash
JIRA_CONTEXT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/jira.js" --project "$PROJECT_KEY" --load)
```

### Handle `--init-templates`

If `--init-templates` flag is present:

1. Run the init-templates script:
   ```bash
   INIT_RESULT=$(node "<PLUGIN_ROOT>/scripts/skill/jira.js" --project "$PROJECT_KEY" --init-templates)
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
   - For each user selection (not "Skip"), copy the template. `--copy-template` prints
     the path of a temp manifest (`{ copied, reason, type, destination }`), not the JSON
     itself — capture it:
     ```bash
     COPY_RESULT=$(node "<PLUGIN_ROOT>/scripts/skill/jira.js" --project "$PROJECT_KEY" --copy-template --type "<typeName>" --from "<selectedTemplate>")
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
→ Extract: ALL fields — standard AND custom (name, key, required, schema.type, allowedValues)
→ Map API type → cache type per resources/REFERENCE.md Section 0 (Field Type Mapping)
→ Store allowedValues as flat string arrays (extract the name or value property)
→ Store in: fieldSchemas[issueTypeName] = { [fieldKey]: { required, type, name?, allowedValues? } }
```

### Phase 5 — Workflow discovery (per non-subtask issue type)

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

Assemble the cache object using the exact shape documented in `resources/REFERENCE.md`
Section 0 — top-level keys `version`, `lastUpdated`, `maxAgeHours`, `cloudId`, `siteUrl`,
`currentUser`, `project`, `issueTypes`, `fieldSchemas`, `workflows`, `linkTypes`,
`userMappings` — populated from Phases 1–5.

Save. `--save` prints the path of a temp manifest (`{ saved, cachePath }`), not the JSON
itself — capture it:

```bash
SAVE_RESULT=$(echo '<cache_json>' | node "<PLUGIN_ROOT>/scripts/skill/jira.js" --project "$PROJECT_KEY" --save)
```

Then load the cache — `--load` likewise prints a manifest path, so capture it into
`JIRA_CONTEXT_FILE` rather than redirecting stdout into that file:

```bash
JIRA_CONTEXT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/jira.js" --project "$PROJECT_KEY" --load)
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

## Step 2.5 — Critique (write-ops only)

Skip this step for read operations (`search`, `view`). For every write operation (`create`, `edit`, `transition`, `comment`, `link`, `assign`, `worklog`, `bulk`), run a critique pass against the proposed payload **before** showing it to the user.

1. Build the initial payload exactly as you would dispatch it (template-resolved, placeholders resolved, fields validated against the cached schemas).
   - **Template resolution and fallback notices:** No `description` field is ever built without a resolved template — the override at `.sdlc/jira-templates/<Type>.md` or the shipped `templates/<Type>.md`. Free-form descriptions on `createJiraIssue` / `editJiraIssue` are prohibited. Read `resolved`, `fallbacks`, and `noneTypes` from the prepare script output (`resolveTemplateStatus`). For each entry in `fallbacks`, print a one-line notice before building the payload:
     `Using <fallbackTo> template for <type> — override at .sdlc/jira-templates/<type>.md`
     For each entry in `noneTypes`, print a one-line warning and stop the operation:
     `No template for <type>. Run /jira-sdlc --init-templates or create .sdlc/jira-templates/<type>.md`
     Sub-bug, Sub-task, and Subtask types resolve via the FALLBACK_MAP in the prepare script (Sub-bug → Bug, Sub-task → Task, Subtask → Task) — the skill never re-derives this mapping.
   - **Placeholder resolution:** Every `{name}` or `[bracketed prose]` marker classified `low`-confidence is escalated via `AskUserQuestion` and resolved from the user's explicit answer — never filled from inference, and never dispatched raw.
2. Run the critique checklist:
   - **Template completeness** (create / description-touching edit) — every `## ` heading in the payload description belongs to the resolved template; no invented sections.
   - **Field correctness** — issue type / project key / parent / components / labels match cached `allowedValues`.
   - **Workflow validity** — for `transition`, the target status is reachable per the cached workflow graph.
   - **Terminology consistency** — summary vocabulary matches description vocabulary (no contradictions).
   - **Terse content** — every `## ` section body in the description payload is a bullet list, numbered list, sub-heading set, or (Release Notes only) a single sentence. No prose paragraphs; no paragraph longer than two consecutive non-list non-heading lines in any section. No filler transitional sentences between sections (`This ticket covers…`, `In summary…`, `The goal of…`). The `## Acceptance Criteria` section body is exclusively `- [ ] <discrete criterion>` checklist items — no prose introduction, no prose summary, no sentence-form criteria. This is LLM-enforced via this checklist only — no hook currently blocks a dispatch whose Acceptance Criteria section contains non-checklist lines (`hooks/pre-tool-jira-write-guard.js` does not exist; see Step 3). Bullet/no-prose enforcement for every other section is likewise LLM-driven via this checklist. Summary is an imperative phrase ≤ 100 characters with no filler tokens (`This task covers`, `The goal of`, `We need to make sure`). Surface any violations in the `Critique:` block.
3. Compute `payload_hash` and write the critique artifact:
   ```js
   const { payloadHash } = require('./lib/payload-hash.js');
   const { writeCritique } = require('./lib/artifact-store.js');
   const hash = payloadHash(toolInput);
   writeCritique(hash, { initial: '<one-line summary of initial draft>', findings: [...], final: '<one-line summary of final payload>' });
   ```
4. Surface the critique to the user as an `Initial:` / `Critique:` / `Final:` block — do not apply deltas silently.

## Step 2.6 — Approval (write-ops only) — HARD GATE

Skip for read operations. No write MCP call is ever dispatched without an `approve` answer to this prompt in the current turn.

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

## Step 2.7 — Link verification (write-ops only) — HARD GATE

Skip for read operations. After approval (Step 2.6) and before MCP dispatch, validate every URL embedded in the description payload (for `createJiraIssue`/`editJiraIssue`) and the comment body (for `addCommentToJiraIssue`) via `scripts/skill/jira.js --validate-body`. The script reads the body from stdin and resolves the expected Jira site (`siteUrl`) deterministically from the cached `~/.sdlc-cache/jira/<site>/<KEY>.json` — the skill MUST NOT construct ctx JSON.

```shell
printf '%s' "$body_or_description" | node "<PLUGIN_ROOT>/scripts/skill/jira.js" --validate-body --project "$PROJECT_KEY" --json
LINK_EXIT=$?
```

For ADF description payloads: extract every `text` node value, concatenate with newlines, and feed that as the body. URLs in ADF link marks must also appear in extracted text or be added explicitly to the validation input.

On non-zero exit (`LINK_EXIT != 0`):
- The script has already printed the violation list to stderr (URL, line, reason code, observed/expected detail)
- Do NOT dispatch the MCP write tool — the payload is never sent to Jira
- Surface the violation list verbatim to the user
- Stop. Do not retry. Do not edit URLs without user input. Do not bypass.
- Run **MCP failure telemetry (shared)** below with `class: link-verification`, `tool: jira.js --validate-body`, `error: "link verification abort: $LINK_EXIT"`, `r-path: R22`, `step: "Step 2.7"`.

On zero exit, proceed to Step 3.

`SDLC_LINKS_OFFLINE=1` skips network reachability checks but keeps structural context-aware checks (GitHub identity match, Atlassian host match) — use this in sandboxed CI runs.

---

## MCP failure telemetry (shared)

Every exhausted-recovery path in this skill records telemetry and offers a gated issue
dispatch through the same two calls. Each citing site supplies its own `<CLASS>`,
`<TOOL>`, `<ERROR>`, `<R-PATH>`, and `<STEP>`; everything else is identical.

```shell
node "<PLUGIN_ROOT>/scripts/lib/mcp-failure.js" --telemetry --class <CLASS> --tool "<TOOL>" --site "$JIRA_SITE" --project "$PROJECT_KEY" --error "<ERROR>" --recovered no
ANALYZE_JSON=$(node "<PLUGIN_ROOT>/scripts/lib/mcp-failure.js" --analyze --class <CLASS> --tool "<TOOL>" --site "$JIRA_SITE" --project "$PROJECT_KEY" --error "<ERROR>" --recovered no --r-path <R-PATH>)
```

Read `ANALYZE_JSON.proposal.title` and `ANALYZE_JSON.proposal.body`; present them to the user verbatim with prompt "Y (file issue) / edit / skip". On Y, dispatch `error-report-sdlc` with `--error-type mcp-<CLASS>`, `--skill jira-sdlc`, `--step "<STEP>"`, `--operation "<TOOL>"`, `--error-text <proposal.body>`, and labels `mcp-failure,class:<CLASS>`.

**Conventions (apply to every `mcp-failure.js` callsite):**

- Invoke `node "<PLUGIN_ROOT>/scripts/lib/mcp-failure.js"` with the absolute plugin path written out in full at each callsite. There is no `HELPER` variable to resolve first — steps may be entered independently.
- Do NOT redirect the helper's stdout to `/dev/null` (`--telemetry` echoes the appended block, `--analyze` emits JSON) — the block surfaces in the terminal so the user sees what was written to `.sdlc/learnings/log.md`.
- Cross-step session counting is keyed by `SDLC_SESSION_ID` when set, otherwise by a per-project marker file at `.sdlc/state/mcp-session.id` written on first call. Callers do not need to export `SDLC_SESSION_ID` for the dedup gate to function.
- When the command cannot be run (plugin not installed, so the path does not exist) or it exits non-zero, emit a single stderr WARNING and proceed non-fatally — skip the call without aborting the surrounding step.
- `ANALYZE_JSON` is a raw JSON string, NOT an object. To use `.proposal.title` and `.proposal.body`, parse explicitly:

  ```shell
  PROPOSAL_TITLE=$(printf '%s' "$ANALYZE_JSON" | node "<PLUGIN_ROOT>/scripts/util/parse-proposal.js" title)
  PROPOSAL_BODY=$(printf  '%s' "$ANALYZE_JSON" | node "<PLUGIN_ROOT>/scripts/util/parse-proposal.js" body)
  ```

  Every "Read `ANALYZE_JSON.proposal.title` / `.proposal.body`" instruction refers to the result of this parse — pass `$PROPOSAL_BODY` (not raw `$ANALYZE_JSON`) to `error-report-sdlc --error-text`.

---

## Step 3 — Execute Operation

For write operations: precondition — Step 2.6 returned `approve`, Step 2.7 link verification passed, and both artifacts (`approval-<hash>.token`, `critique-<hash>.json`) are on disk. **No PreToolUse hook enforces this precondition in the current codebase** — `hooks/pre-tool-jira-write-guard.js` does not exist and is not registered in `hooks.json`. The two-gate consent flow (Step 2.6 approval + Step 2.7 link verification) is enforced solely by the LLM following this checklist; there is no hook-level backstop that blocks dispatch if the LLM skips it. Do NOT dispatch `createJiraIssue` / `editJiraIssue` / any write MCP call unless you have personally verified both artifacts exist for this exact `payload_hash` — treat this as a self-check, not a guaranteed gate.

**If a `pre-tool-jira-write-guard.js` hook is implemented in the future** and returns a deny decision, surface its `permissionDecisionReason` to the user verbatim (do not retry by guessing what changed) and record telemetry:

```shell
node "<PLUGIN_ROOT>/scripts/lib/mcp-failure.js" --telemetry --class hook-block --tool "$MCP_TOOL_NAME" --site "$JIRA_SITE" --project "$PROJECT_KEY" --error "$permissionDecisionReason" --recovered no
HOOK_HASH=$(node "<PLUGIN_ROOT>/scripts/lib/mcp-failure.js" --hash "$permissionDecisionReason")
HOOK_COUNT=$(node "<PLUGIN_ROOT>/scripts/lib/mcp-failure.js" --record-occurrence --class hook-block --key "$HOOK_HASH")
```

Only when `HOOK_COUNT` equals 2 (same hook deny reason seen twice in this session), run the `--analyze` half of **MCP failure telemetry (shared)** with `class: hook-block`, `tool: "$MCP_TOOL_NAME"`, `error: "$permissionDecisionReason"`, `r-path: R21`, `step: "Step 3"` (the `--telemetry` call above already ran).

**On cloudId authorization error** (response text matches `isn't explicitly granted` or auth/403 with cloudId substring):

1. Call `getAccessibleAtlassianResources` exactly once.
2. Compare the returned cloudId(s) against the cached value at `~/.sdlc-cache/jira/<site>/<KEY>.json`.
3. If different, run `/jira-sdlc --force-refresh` and reload the cache.
4. Retry the original MCP call exactly once under the primary namespace. If it still fails with the same error, retry once under the sibling namespace (`mcp__antigravity_ai_Atlassian__`) when that namespace is registered (visible in the deferred-tools list). Persist the working namespace for the rest of the session — do not re-probe per call.
5. If the primary namespace retry failed, call the helper with `--recovered no` before trying the sibling namespace:

```shell
node "<PLUGIN_ROOT>/scripts/lib/mcp-failure.js" --telemetry --class auth --tool "$MCP_TOOL_NAME" --site "$JIRA_SITE" --project "$PROJECT_KEY" --error "$AUTH_ERROR" --recovered no
```

6. If the sibling namespace also fails (dual-namespace exhausted), record the sibling failure and then run **MCP failure telemetry (shared)** with `class: auth`, `tool: "$MCP_TOOL_NAME"`, `error: "$AUTH_ERROR"`, `r-path: R23`, `step: "Step 3"`:

```bash
node "<PLUGIN_ROOT>/scripts/lib/mcp-failure.js" --telemetry --class auth --tool "mcp__antigravity_ai_Atlassian__${MCP_TOOL_SUFFIX}" --site "$JIRA_SITE" --project "$PROJECT_KEY" --error "$AUTH_ERROR_SIBLING" --recovered no
```

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
| New user resolved via lookupJiraAccountId | `SAVE_RESULT=$(echo '{"<name>":"<id>"}' \| node "<PLUGIN_ROOT>/scripts/skill/jira.js" --project "$KEY" --save-field userMappings)` |
| Transition from a status not in workflow cache | `SAVE_RESULT=$(echo '<workflows_json>' \| node "<PLUGIN_ROOT>/scripts/skill/jira.js" --project "$KEY" --save-field workflows)` |
| Stale transition ID, or a field key/value not in cache (404/400) | **Auto-refresh**: run `--force-refresh`, reload cache, retry operation once |

`--save-field` prints the path of a temp manifest (`{ saved, field, cachePath }`), not the
JSON itself — always capture it (`SAVE_RESULT=$(…)`) rather than calling `node …` bare.

---

## Error Recovery

See `resources/REFERENCE.md` Section 5 for the full HTTP status → diagnosis → recovery
table (400 on create/edit/transition, 401, 403, 404 issue/project, 409, stale transition).
This skill adds two rules on top of that table:

- **Auto-refresh:** any error implicating stale cache data (field key/shape mismatch,
  unrecognized transition ID, field or value not in `fieldSchemas`) → run
  `--force-refresh`, reload the cache, retry the operation once. Never retry more than
  once without first diagnosing the cause.
- **401/403** cannot be recovered programmatically — report to the user.

**Exhausted path — gated dispatch:** when a 400 on create, or a repeated 400 (2+
attempts), still fails after the auto-refresh retry above, classify the failure —
`schema` for field/schema errors, `workflow` for transition errors:

```shell
FAILURE_CLASS=schema  # or "workflow" for transition errors
```

Then run **MCP failure telemetry (shared)** with `class: "$FAILURE_CLASS"`, `tool: "$MCP_TOOL_NAME"`, `error: "$ERROR_MSG"`, `r-path: R9`, `step: "Step 3 — Error Recovery"`.

Also call `--telemetry` on every retry (even successful ones) to maintain a per-session failure log:

```bash
node "<PLUGIN_ROOT>/scripts/lib/mcp-failure.js" --telemetry --class "$FAILURE_CLASS" --tool "$MCP_TOOL_NAME" --site "$JIRA_SITE" --project "$PROJECT_KEY" --error "$ERROR_MSG" --recovered "yes:R9"
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
| Artifacts verified | No write MCP call dispatched without the LLM confirming both `approval-<hash>.token` and `critique-<hash>.json` exist for this exact `payload_hash` (< 10 min old). No hook backstop exists (see Step 3). |
| Link verified | No write MCP call (`createJiraIssue`, `editJiraIssue`, `addCommentToJiraIssue`) dispatched without `scripts/skill/jira.js --validate-body` returning exit 0. The script enforces — SKILL.md only invokes it. See Step 2.7. |
| Hash-bound approval | No write MCP call dispatched without `approval-<hash>.token` present on disk for this exact `payload_hash` — LLM-verified per Step 3; no hook backstop exists |
| Critique artifact age | No write MCP call dispatched without `critique-<hash>.json` present for this `payload_hash` and less than 10 minutes old — LLM-verified per Step 3; no hook backstop exists |
| Link verification passed | No write MCP call dispatched before Step 2.7's `scripts/skill/jira.js --validate-body` has returned exit 0 for the final payload in this turn |
| No write without approve | No write MCP call dispatched without an explicit `approve` from the Step 2.6 `AskUserQuestion` prompt in this exact turn — LLM-verified per Step 3; no hook backstop exists |
| Release notes single-sentence | No `createJiraIssue` / `editJiraIssue` dispatch where the `## Release Notes` section contains two or more sentences — a single sentence is the only allowed carve-out (R25.5); two or more sentences fail this check |

---

## Additional Rules

- Include transition `requiredFields` (e.g., `resolution` when closing) — never skip them
- Never ignore a custom template at `.sdlc/jira-templates/<Type>.md` when one exists, and
  never generate a free-form description when a template is available (Step 2.5)
- Write critique + approval artifacts only via `lib/artifact-store.js` /
  `lib/payload-hash.js` — never bypass with a direct `fs.writeFile`, which breaks the
  canonical hash contract both artifacts are keyed by

---

## Gotchas

Non-obvious edge cases not already covered by `resources/REFERENCE.md`'s parameter and
field-format tables:

- Sub-task creation requires `parent: "PROJ-123"` as a string parameter AND the exact subtask type name from `cache.issueTypes` (may be `"Sub-task"`, `"Subtask"`, or custom)
- When a transition is absent from `getTransitionsForJiraIssue` results, it means transition conditions aren't met (e.g., all subtasks must be closed) — missing transitions are intentional, not a bug
- Transition `requiredFields` may include screen-only fields not in `fieldSchemas` — if a required field is absent from the schema, try the transition without it first; screen fields sometimes only block the Jira UI, not the API
- When Phase 5 workflow sampling finds no issues at all for a type, skip workflow discovery for that type entirely and note it in the cache as `"workflows": { "Story": { "unsampled": true } }` (see Step 1 Phase 5 and `resources/REFERENCE.md` Section 0 for the full `unsampled` fallback behavior). When the live `getTransitionsForJiraIssue` call itself fails on an unsampled path, run **MCP failure telemetry (shared)** with `class: workflow`, `tool: getTransitionsForJiraIssue`, `error: "$TRANSITION_ERROR"`, `r-path: R14`, `step: "Step 3 — unsampled fallback"`.
- The `mcp__atlassian__` prefix is the default; if the user's MCP is registered under a different prefix (e.g., `mcp__antigravity_ai_Atlassian__`), use the active prefix consistently across all calls in the session

---

## Learning Capture

When executing Jira operations, capture discoveries by appending to `.sdlc/learnings/log.md`.
Record entries for: field formats that differ from the defaults documented here, workflow
quirks discovered in specific projects, issue type names that aren't standard (e.g., custom
subtask type names), user lookup disambiguation patterns, and transition required fields not
captured by the workflow sampling.

**MCP failures use the structured telemetry form** (written by `scripts/lib/mcp-failure.js --telemetry`). The helper writes a 5-line block under a `## YYYY-MM-DD — jira-sdlc mcp-failure[<class>]: <tool>` heading. Non-MCP discoveries continue to use the free-form prose style above.

## What's Next

After completing a Jira operation, common follow-ups include:
- `/plan-sdlc` — write an implementation plan for a ticket
- `/execute-plan-sdlc` — execute an existing plan

## See Also

- [`/plan-sdlc`](../plan-sdlc/SKILL.md) — write an implementation plan from a Jira ticket
- [`/execute-plan-sdlc`](../execute-plan-sdlc/SKILL.md) — execute an existing plan
