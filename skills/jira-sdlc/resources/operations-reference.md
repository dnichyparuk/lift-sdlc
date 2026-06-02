# Jira Operations Reference

Per-operation execution procedures for the `jira-sdlc` skill. This file is loaded
conditionally after Step 2 classifies the operation type.

> **Universal rules — apply to EVERY MCP call:**
> - **Comments:** convert markdown to ADF via `scripts/lib/markdown-to-adf.js`, then pass `contentFormat: "adf"` with the ADF JSON body
> - **Descriptions/create:** pass `contentFormat: "markdown"` (no conversion needed)
> - Always pass `responseContentFormat: "markdown"` on calls that return content
> - Always use `cloudId` from cache — never call `getAccessibleAtlassianResources` again
> - Never guess field IDs, transition IDs, or user accountIds
> - Never fabricate field values — use only `allowedValues` from `fieldSchemas`
>
> **Write-op canonical procedure (R17–R21):** every write operation below — Create, Edit, Transition, Comment, Worklog, Link — MUST follow the eight-step sequence:
>
> 1. Gather inputs from the user request
> 2. Resolve description template (Create + description-touching Edit only — R18)
> 3. Detect placeholders via the C13 regex; escalate every `low`-confidence marker via `AskUserQuestion` (R19)
> 4. Build the proposed payload
> 5. Critique (R20) — emit the `Initial:` / `Critique:` / `Final:` block, then call `lib/artifact-store.js` `writeCritique(hash, ...)`
> 6. Approval gate (R17) — `AskUserQuestion` with `approve` / `change <what>` / `cancel`; on `approve` call `lib/artifact-store.js` `writeApprovalToken(hash)`. The PreToolUse hook (`hooks/pre-tool-jira-write-guard.js`) verifies the artifacts written by steps 5–6 and BLOCKS dispatch otherwise (R21)
> 7. Dispatch the MCP write call
> 8. Post-op cache update
>
> Read operations (Search, View, GetTransitions) and metadata-discovery operations are exempt from steps 5–7.

---

## Create Operation

```
1. Gather inputs — determine issue type from user request
   - Map user language ("bug", "feature", "task") to exact type name from cache.issueTypes
   - If ambiguous, ask: "Should I create a Bug, Task, or Story?"
   - Read cache.fieldSchemas[issueTypeName]; for each required field not provided
     by the user, ask before proceeding

2. Resolve description template (R18 — required for Create)
   a. Check .sdlc/jira-templates/<issueTypeName>.md — if exists, read it (override)
   b. Else, find templates/<issueTypeName>.md relative to the resolved $SCRIPT path (shipped)
   c. If found: fill all {placeholder} markers from user context (see step 3)
   d. If neither exists: AskUserQuestion with the closed list of available templates —
      free-form descriptions are prohibited

3. Detect placeholders via C13 regex (R19) — `\{[a-zA-Z_][a-zA-Z0-9_-]*\}|\[[^\]\n]{3,}\]`
   - Classify each marker `high` (explicit user input or definitive cache value) or `low`
   - For every `low` marker: AskUserQuestion to resolve before payload finalization
   - Inapplicable section removal requires explicit user consent (no silent drops)
   - NEVER leave raw {placeholder} or [bracketed prose] in the final description

4. Build the proposed payload using values from cache and user input
   - issueTypeName: exact string from cache.issueTypes (e.g., "Task" NOT "task")
   - priority: { name: "..." } from cache fieldSchemas.priority.allowedValues
   - labels: flat string array
   - components: array of { name: "..." } objects
   - custom fields: use fieldId key (e.g., customfield_10016) with correct type shape
   - For Sub-task: include parent: "PROJ-123" as top-level parameter

5. Critique the payload (R20) — check template completeness, field correctness,
   workflow validity (n/a for create), terminology consistency
   - Emit `Initial:` / `Critique:` / `Final:` block to the user
   - Compute hash and persist:
       const { payloadHash } = require('./lib/payload-hash.js');
       const { writeCritique } = require('./lib/artifact-store.js');
       const hash = payloadHash(payload);
       writeCritique(hash, { initial, findings, final });

6. Approval gate (R17) — print full final payload, AskUserQuestion approve/change/cancel
   - On `approve`: writeApprovalToken(hash)
   - On `change <what>`: revise payload, return to step 5 (new hash, fresh artifacts)
   - On `cancel`: abort — do not dispatch

7. Dispatch — call mcp__atlassian__createJiraIssue with contentFormat: "markdown"
   - The PreToolUse hook (R21) re-derives the hash from tool_input and verifies the
     two artifacts; on hook block, surface permissionDecisionReason verbatim
   - On 400 error: check fieldSchemas for the issue type; verify field shapes from
     REFERENCE.md Section 2

8. Post-op cache update — record any newly resolved user mappings or workflow data
```

## Edit Operation

```
1. Gather inputs — parse: which issue key, which field(s), what new value(s)

2. Resolve description template (R18) — ONLY when description is being touched
   - Look up the issue's issueTypeName via cache or getJiraIssue
   - Resolve override `.sdlc/jira-templates/<Type>.md` then shipped `templates/<Type>.md`
   - If editing description without a template match, AskUserQuestion with a closed list

3. Detect placeholders via C13 regex (R19) — applies to every string-valued field, not
   only description; ADF text nodes traversed recursively
   - Resolve every `low`-confidence marker via AskUserQuestion before payload finalization

4. Build fields object (flat — NOT nested under fields.fields)
   - Priority → { name: "..." }
   - Labels → flat string array (REPLACES existing labels entirely)
   - Components → array of { name: "..." } objects
   - Custom select → { value: "..." }
   - Assignee → { accountId: "..." } from cache.userMappings

5. Critique (R20) — emit Initial/Critique/Final block; writeCritique(hash, ...)

6. Approval gate (R17) — AskUserQuestion approve/change/cancel; on `approve`
   writeApprovalToken(hash)

7. Dispatch — call mcp__atlassian__editJiraIssue with responseContentFormat: "markdown"
   - On hook block (R21): surface permissionDecisionReason verbatim
   - On 400: check field key spelling (customfield_XXXXX), field type, and value shape

8. Post-op cache update — record any newly resolved user mappings
```

## Search Operation

```
1. Build JQL from user intent using REFERENCE.md Section 3 patterns:
   - Always scope with "project = <KEY>" unless user explicitly wants cross-project
   - Apply escaping rules for values with spaces or special characters

2. Choose field list based on what info user needs:
   - Summary view: ["summary", "status", "assignee", "priority", "issuetype"]
   - Detailed view: ["summary", "status", "assignee", "priority", "created", "updated", "description"]

3. Call mcp__atlassian__searchJiraIssuesUsingJql:
   - maxResults: 25 for summary, 10 for detailed
   - responseContentFormat: "markdown"

4. Format results as a readable table
5. If total > maxResults: inform user, offer to paginate with startAt
```

## Transition Operation

```
1. Gather inputs — determine target status from user ("move to Done", "start",
   "mark in review"); get current status (context or getJiraIssue)

   (Steps 2–3 of the canonical procedure are skipped — transitions have no description
   field and no string fields where placeholder markers can hide.)

4. Build payload — look up workflow in cache:
   - transitions = cache.workflows[issueTypeName].transitions[currentStatus]
   - Find transition matching target status; if none, inform user of available
     transitions and ask which to use
   - Include requiredFields when non-empty
     (e.g., { resolution: { name: "Done" } })
   - Final shape: { cloudId, issueKey, transition: { id }, fields? }

5. Critique (R20) — verify transition target reachable per cached workflow graph;
   emit Initial/Critique/Final; writeCritique(hash, ...)

6. Approval gate (R17) — AskUserQuestion approve/change/cancel; on `approve`
   writeApprovalToken(hash)

7. Dispatch — call mcp__atlassian__transitionJiraIssue
   - On hook block (R21): surface permissionDecisionReason verbatim
   - On 400 with requiredFields: verify all required fields were included with correct shapes
   - On "transition not found": getTransitionsForJiraIssue for fresh list (auto-refresh path)

8. Post-op cache update — record fresh transitions if cache was stale
```

## Comment Operation

```
1. Gather inputs — compose comment in markdown (REFERENCE.md Section 4 safe syntax only)

   (Step 2 — template resolution — is skipped; comments have no template.)

3. Detect placeholders via C13 regex (R19) — applies to ADF text nodes recursively
   - After ADF conversion, walk commentBody.body[] and resolve every `low`-confidence marker

4. Build payload — convert markdown to ADF and assemble:
   Write the markdown comment to a temporary file (e.g., `comment.md`), then convert it to ADF using the node script:
   ```shell
   node <PLUGIN_ROOT>/scripts/lib/markdown-to-adf.js < comment.md
   ```
   Final shape: { cloudId, issueIdOrKey, commentBody: <ADF JSON>, contentFormat: "adf",
                 responseContentFormat: "markdown" }
   Never use HTML tags, task lists (- [ ]), or footnotes in source markdown.

5. Critique (R20) — emit Initial/Critique/Final block; writeCritique(hash, ...)

6. Approval gate (R17) — AskUserQuestion approve/change/cancel; on `approve`
   writeApprovalToken(hash)

7. Dispatch — call mcp__atlassian__addCommentToJiraIssue
   - On hook block (R21): surface permissionDecisionReason verbatim

8. Post-op cache update — none typically required for comments
```

## Link Operation

```
1. Gather inputs — determine link direction from user intent:
   - "PROJ-A blocks PROJ-B" → outwardIssue = PROJ-A, inwardIssue = PROJ-B
   - "PROJ-A is blocked by PROJ-B" → outwardIssue = PROJ-B, inwardIssue = PROJ-A
   - "PROJ-A relates to PROJ-B" → either direction (symmetric)
   - Cross-reference cache.linkTypes for exact inward/outward label semantics

   (Steps 2–3 of the canonical procedure are skipped — link payloads carry no
   description and no free-text fields where placeholders can hide.)

4. Build payload — find link type in cache.linkTypes by name; assemble:
   { cloudId, linkType: { name: "Blocks" },
     inwardIssue: { key: "PROJ-123" }, outwardIssue: { key: "PROJ-456" } }

5. Critique (R20) — emit Initial/Critique/Final block; writeCritique(hash, ...)

6. Approval gate (R17) — AskUserQuestion approve/change/cancel; on `approve`
   writeApprovalToken(hash)

7. Dispatch — call mcp__atlassian__createIssueLink
   - On hook block (R21): surface permissionDecisionReason verbatim

8. Post-op cache update — none typically required for links
```

## Assign Operation

```
1. If user mentions a name/email already in cache.userMappings:
   - Use cached accountId directly

2. If user mentions someone not in cache:
   - Call mcp__atlassian__lookupJiraAccountId({ cloudId, query: "<name or email>" })
   - If multiple results: show all and ask user to confirm which one
   - Once confirmed: save to cache via:
     echo '{"<displayName>":"<accountId>"}' | node "$SCRIPT" --project "$KEY" --save-field userMappings

3. Call mcp__atlassian__editJiraIssue({
     cloudId, issueKey,
     fields: { assignee: { accountId: "<confirmed accountId>" } },
     responseContentFormat: "markdown"
   })
```

## Worklog Operation

```
1. Gather inputs — parse time from user ("2 hours 30 minutes" → "2h 30m",
   "half a day" → "4h"); collect optional work description

   (Steps 2–3 of the canonical procedure are skipped — worklog has no template
   and the optional comment is plain text without templated placeholders. The
   C13 regex still runs over the comment field at hook-verification time.)

4. Build payload:
   { cloudId, issueKey, timeSpent: "<Jira duration string>",
     comment: "<optional description>", adjustEstimate: "auto" }

5. Critique (R20) — emit Initial/Critique/Final block; writeCritique(hash, ...)

6. Approval gate (R17) — AskUserQuestion approve/change/cancel; on `approve`
   writeApprovalToken(hash)

7. Dispatch — call mcp__atlassian__addWorklogToJiraIssue
   - On hook block (R21): surface permissionDecisionReason verbatim

8. Post-op cache update — none typically required for worklogs
```

## View Operation

```
1. Determine what detail level the user needs:
   - Quick summary: fields: ["summary", "status", "assignee", "priority", "issuetype", "labels"]
   - Full details: all fields including description, custom fields
2. Call mcp__atlassian__getJiraIssue({
     cloudId, issueKey, fields: [...], responseContentFormat: "markdown"
   })
3. Render response clearly; show description as formatted markdown
```

## Bulk Operation

```
1. Parse all items from user request into discrete operation specs
2. Identify dependencies (e.g., Epic must exist before Stories that link to it)
3. Execute independent operations in parallel; dependent operations sequentially
4. Report progress after each batch: "Created 3 of 5 issues..."
5. On partial failure: complete remaining independent operations, then report all failures
```
