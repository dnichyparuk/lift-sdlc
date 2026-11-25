---
name: jira-sdlc
description: "Use this skill when creating, editing, reading, viewing, searching, transitioning, commenting on, or linking Jira issues using Atlassian MCP tools. Caches project metadata (custom fields, workflows, transitions, user mappings) to eliminate redundant discovery calls. Supports multi-project repos via jira.projects, and skipping workflow discovery for CI. Arguments: [--project <KEY>] [--force-refresh] [--init-templates] [--site <host>] [--skip-workflow-discovery]. Triggers on: create jira issue, edit jira ticket, search jira, transition jira, jira comment, link jira, assign jira, log work jira, bulk jira operations, manage jira, jira template, read jira, view jira, show jira, get jira, fetch jira, jira details, add comment, comment on jira, reply to jira, jira ticket, jira issue."
user-invocable: true
argument-hint: "[--project <KEY>] [--force-refresh] [--init-templates] [--site <host>] [--skip-workflow-discovery]"
---

# Managing Jira Issues

Cache Jira project metadata once per site at `~/.sdlc-cache/jira/<sanitizedSiteHost>/<PROJECT_KEY>.json` (host lowercased, `.` → `_`, e.g., `acme.atlassian.net` → `acme_atlassian_net`), then execute every Jira operation exclusively from cached values with zero repeat discovery calls. Legacy `.sdlc/jira-cache/<KEY>.json` caches auto-migrate on `--check`.

**Announce at start:** "I'm using jira-sdlc (sdlc v{sdlc_version})." — extract from the `sdlc:` line in the session-start system-reminder (omit parenthetical if absent).

## Step 0 — Parse Arguments and Check Cache

| Argument | Description | Default |
|----------|-------------|---------|
| `--project <KEY>` | Jira project key (rejected if outside `jira.projects`) | Auto-detected |
| `--force-refresh` | Rebuild cache even if fresh | `false` |
| `--init-templates` | Copy default templates to `.sdlc/jira-templates/` | `false` |
| `--site <host>` | Sanitized site host (e.g., `acme_atlassian_net`) for multi-site disambiguation | Unset |
| `--skip-workflow-discovery` | Skip Phase 5; set `workflows[type] = { unsampled: true }` (CI mode) | `false` |

**Project key resolution (ordered fallback):** (1) `--project <KEY>` (if `jira.projects` has ≥2 entries, keys outside it exit 1); (2) git branch matching `[A-Z]{2,10}-\d+` (must be in `jira.projects` if set); (3) `.sdlc/config.json` → `jira.defaultProject`; (4) if `jira.projects` has ≥2 entries, `ask_question` with that closed list; (5) `ask_question`: `"Which Jira project key should I use? (e.g., PROJ, TEAM)"`.

**Multi-site disambiguation:** If `--check` without `--site` returns `exists: false` and `candidateSites`, ask via `ask_question` and re-run with `--site <host>` (or `--force-refresh`). See `./resources/operations-and-telemetry.md`.

### Script Resolution Block

> **VERBATIM** — Run directly with `node` and the absolute plugin path (`<PLUGIN_ROOT>/scripts/<skill|util|lib>/<script-name>.js`). Do not modify flags.

```shell
JIRA_CONTEXT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/jira.js" $ARGUMENTS --check)
EXIT_CODE=$?
```

Read and parse `JIRA_CONTEXT_FILE` (auto-cleaned by the entry `trap`). On `EXIT_CODE == 1`, show `errors[]` and stop; on `EXIT_CODE == 2`, show `Script error — see output above` and stop.

### Cache Status Evaluation

- **Hook fast-path:** If the session-start system-reminder shows `Jira cache:` `stale`, prompt for `--force-refresh` immediately. If current, still run `--check` above for deep validation.
- Proceed to **Step 1** if `exists: false`, `missing` includes any of `cloudId`/`project`/`issueTypes`/`fieldSchemas`, `--force-refresh` is set, or (`fresh: false` AND `maxAgeHours > 0`).
- Otherwise load cache (`--load` prints a temp manifest path — capture stdout, never redirect into it) and skip to **Step 2**:

```bash
JIRA_CONTEXT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/jira.js" --project "$PROJECT_KEY" --load)
```

### Handle `--init-templates`

If `--init-templates` is set, initialize templates, report created/skipped counts, and **stop** (do not proceed with any Jira operation):

```shell
INIT_RESULT=$(node "<PLUGIN_ROOT>/scripts/skill/jira.js" --project "$PROJECT_KEY" --init-templates)
trap 'rm -f "$JIRA_CONTEXT_FILE" "$INIT_RESULT"' EXIT INT TERM
```

If `unavailable` is non-empty and cache is loaded, follow the `hierarchyLevel` suggestion and `--copy-template` walkthrough in `./resources/operations-and-telemetry.md`.

## Step 1 — Deterministic Cache Initialization

Run only when cache is missing, incomplete, expired, or `--force-refresh` is set. Announce: `"Initializing Jira cache for project \`[PROJECT_KEY]\`…"`.

1. **Phase 1 — Identity (parallel):** `mcp__atlassian__getAccessibleAtlassianResources()` (`sites[0].id` → `cloudId`, `sites[0].url` → `siteUrl`) and `mcp__atlassian__atlassianUserInfo()` (`accountId`, `displayName`, `emailAddress` → `currentUser`).
2. **Phase 2 — Project & link types (parallel):** `mcp__atlassian__getVisibleJiraProjects({ cloudId, searchString: PROJECT_KEY })` (`values[0]` → `project`) and `mcp__atlassian__getIssueLinkTypes({ cloudId })` (`issueLinkTypes` → `linkTypes`).
3. **Phase 3 — Issue types:** `mcp__atlassian__getJiraProjectIssueTypesMetadata({ cloudId, projectKey: PROJECT_KEY })` → `issueTypes[name] = { id, subtask, hierarchyLevel }`.
4. **Phase 4 — Field schemas (parallel per type):** `mcp__atlassian__getJiraIssueTypeMetaWithFields({ cloudId, projectKey, issueTypeId: issueType.id })` → map standard + custom fields per `resources/REFERENCE.md` Section 0 (`fieldSchemas[type][key]`, flat `allowedValues` string arrays).
5. **Phase 5 — Workflow discovery (per non-subtask type):**
   - **Skip (`flags.skipWorkflowDiscovery === true`):** Write `"workflows": { "<type>": { "unsampled": true } }` (omit subtasks); runtime falls back to `getTransitionsForJiraIssue`.
   - **Standard:** Per non-subtask type: **5a** `mcp__atlassian__searchJiraIssuesUsingJql` (`project = "<KEY>" AND issuetype = "<Type>" ORDER BY status ASC`, `fields: ["status"]`, `maxResults: 100`) → unique statuses; **5b** per status, `searchJiraIssuesUsingJql` (`maxResults: 1`) → `issues[0].key` (empty → mark unsampled in `workflows[type].statuses`); **5c** `mcp__atlassian__getTransitionsForJiraIssue({ cloudId, issueKey })` → `workflows[type].transitions[status] = [{ id, name, to: to.name, requiredFields }]`.
6. **Phase 6 — Save & load:** Assemble per `resources/REFERENCE.md` Section 0 (`version`, `lastUpdated`, `maxAgeHours`, `cloudId`, `siteUrl`, `currentUser`, `project`, `issueTypes`, `fieldSchemas`, `workflows`, `linkTypes`, `userMappings`), then save and load (both print temp manifest paths — capture stdout):

```bash
SAVE_RESULT=$(echo '<cache_json>' | node "<PLUGIN_ROOT>/scripts/skill/jira.js" --project "$PROJECT_KEY" --save)
JIRA_CONTEXT_FILE=$(node "<PLUGIN_ROOT>/scripts/skill/jira.js" --project "$PROJECT_KEY" --load)
```

Report: `"Cache initialized for \`[PROJECT_KEY]\` — \`[N]\` issue types, \`[N]\` workflow states mapped."` (See `resources/EXAMPLES.md` Section 1.)

## Step 2 — Classify Operation

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

If ambiguous, ask one clarifying question via `ask_question`. For `bulk` dependency ordering and batching, see `./resources/operations-and-telemetry.md`.

## Step 2.5 — Critique (write-ops only)

Skip for read ops (`search`, `view`). For every write op (`create`, `edit`, `transition`, `comment`, `link`, `assign`, `worklog`, `bulk`), critique **before** presenting to the user:

1. **Build the initial payload** (template-resolved, placeholders resolved, fields validated against cached schemas):
   - **Template resolution & fallback notices:** Never build `description` without a resolved template (`.sdlc/jira-templates/<Type>.md` or shipped `templates/<Type>.md`); free-form descriptions on `createJiraIssue` / `editJiraIssue` are prohibited. Read `resolved`, `fallbacks`, and `noneTypes` from `resolveTemplateStatus`:
     - Per `fallbacks` entry, print: `Using <fallbackTo> template for <type> — override at .sdlc/jira-templates/<type>.md`
     - Per `noneTypes` entry, print and stop: `No template for <type>. Run /jira-sdlc --init-templates or create .sdlc/jira-templates/<type>.md`
     - `Sub-bug`, `Sub-task`, and `Subtask` resolve via `FALLBACK_MAP` in the prepare script — never re-derive it.
   - **Placeholder resolution:** Escalate every `low`-confidence `{name}` or `[bracketed prose]` marker via `ask_question` and resolve from the user's answer — never infer or dispatch raw markers.
2. **Critique checklist:**
   - **Template completeness** (create / description-touching edit): every `## ` heading belongs to the resolved template; no invented sections.
   - **Field correctness:** issue type, project key, parent, components, and labels match cached `allowedValues`.
   - **Workflow validity:** for `transition`, target status is reachable per the cached workflow graph.
   - **Terminology consistency:** summary vocabulary matches description vocabulary.
   - **Terse content:** every `## ` section body is a bullet list, numbered list, sub-heading set, or (`## Release Notes` only) a single sentence — no prose paragraphs (>2 consecutive non-list non-heading lines) or filler transitions (`This ticket covers…`, `In summary…`, `The goal of…`). `## Acceptance Criteria` contains **exclusively** `- [ ] <discrete criterion>` checklist items. Summary is an imperative phrase ≤ 100 chars without filler tokens. Both are LLM-enforced here (no hook blocks non-checklist sections).
3. **Compute `payload_hash` and write critique artifact:**
   ```js
   const { payloadHash } = require('./lib/payload-hash.js');
   const { writeCritique } = require('./lib/artifact-store.js');
   const hash = payloadHash(toolInput);
   writeCritique(hash, { initial: '<one-line summary>', findings: [...], final: '<one-line summary>' });
   ```
4. **Surface** `Initial:` / `Critique:` / `Final:` to the user — never apply deltas silently.

## Step 2.6 — Approval (write-ops only) — HARD GATE

Skip for read ops. No write MCP call may be dispatched without an `approve` answer in this turn:
1. Print the **full final payload** (exact bytes to dispatch, not a summary).
2. Call `ask_question` with: **approve** (proceed), **change <what>** (revise and loop back to Step 2.5 with new `payload_hash` and fresh artifacts), **cancel** (abort).
3. On `approve` only:
   ```js
   const { writeApprovalToken } = require('./lib/artifact-store.js');
   writeApprovalToken(hash);
   ```

## Step 2.7 — Link verification (write-ops only) — HARD GATE

Skip for read ops. After Step 2.6 approval and before MCP dispatch, validate every URL in `description` (`createJiraIssue`/`editJiraIssue`) or comment body (`addCommentToJiraIssue`) via stdin (`--validate-body` resolves `siteUrl` from `~/.sdlc-cache/jira/<site>/<KEY>.json` — never construct ctx JSON):

```shell
printf '%s' "$body_or_description" | node "<PLUGIN_ROOT>/scripts/skill/jira.js" --validate-body --project "$PROJECT_KEY" --json
LINK_EXIT=$?
```

For ADF payloads, extract all `text` node values (and link mark URLs), join with newlines, and pipe to `--validate-body`. Use `SDLC_LINKS_OFFLINE=1` in sandboxed CI to keep structural checks without network requests.

On `LINK_EXIT != 0`: do **NOT** dispatch the MCP write tool; print the stderr violation list verbatim; stop without retrying, auto-editing URLs, or bypassing; and run **MCP failure telemetry (shared)** (`class: link-verification`, `tool: jira.js --validate-body`, `error: "link verification abort: $LINK_EXIT"`, `r-path: R22`, `step: "Step 2.7"`).

## MCP failure telemetry (shared)

Every exhausted-recovery path records telemetry and offers a gated issue dispatch (`<CLASS>`, `<TOOL>`, `<ERROR>`, `<R-PATH>`, `<STEP>`):

```shell
node "<PLUGIN_ROOT>/scripts/lib/mcp-failure.js" --telemetry --class <CLASS> --tool "<TOOL>" --site "$JIRA_SITE" --project "$PROJECT_KEY" --error "<ERROR>" --recovered no
ANALYZE_JSON=$(node "<PLUGIN_ROOT>/scripts/lib/mcp-failure.js" --analyze --class <CLASS> --tool "<TOOL>" --site "$JIRA_SITE" --project "$PROJECT_KEY" --error "<ERROR>" --recovered no --r-path <R-PATH>)
PROPOSAL_TITLE=$(printf '%s' "$ANALYZE_JSON" | node "<PLUGIN_ROOT>/scripts/util/parse-proposal.js" title)
PROPOSAL_BODY=$(printf  '%s' "$ANALYZE_JSON" | node "<PLUGIN_ROOT>/scripts/util/parse-proposal.js" body)
```

Present `$PROPOSAL_TITLE` and `$PROPOSAL_BODY` verbatim (`"Y (file issue) / edit / skip"`). On `Y`, dispatch `error-report-sdlc` with `--error-type mcp-<CLASS>`, `--skill jira-sdlc`, `--step "<STEP>"`, `--operation "<TOOL>"`, `--error-text "$PROPOSAL_BODY"`, and labels `mcp-failure,class:<CLASS>`. See `./resources/operations-and-telemetry.md` for full conventions and `R9`/`R14`/`R21`/`R22`/`R23` paths.

## Step 3 — Execute Operation

**Write-op precondition check:** Before dispatching any write MCP call, verify Step 2.6 returned `approve`, Step 2.7 exited 0, and both `approval-<hash>.token` and `critique-<hash>.json` exist for this `payload_hash` (< 10 min old). `hooks/pre-tool-jira-write-guard.js` (registered in `hooks.json`) enforces this fresh token pair fail-closed.

Read `./resources/operations-reference.md` and follow the section for the Step 2 classification (`Create`, `Edit`, `Search`, `View`, `Transition`, `Link`, `Comment`, `Assign`, `Worklog`, `Bulk`). For **cloudId authorization errors** and dual-namespace retry (`mcp__antigravity_ai_Atlassian__`, `R23`), **hook-block telemetry** (`R21`), and **unsampled transition failures** (`R14`), follow `./resources/operations-and-telemetry.md`.

## Step 4 — Post-Operation Cache Updates

`--save-field` prints a temp manifest path (`{ saved, field, cachePath }`) — always capture `SAVE_RESULT=$(…)`:

| Trigger | Cache update command |
|---------|---------------------|
| New user resolved via `lookupJiraAccountId` | `SAVE_RESULT=$(echo '{"<name>":"<id>"}' \| node "<PLUGIN_ROOT>/scripts/skill/jira.js" --project "$KEY" --save-field userMappings)` |
| Transition from status not in workflow cache | `SAVE_RESULT=$(echo '<workflows_json>' \| node "<PLUGIN_ROOT>/scripts/skill/jira.js" --project "$KEY" --save-field workflows)` |
| Stale transition ID or missing field/value (404/400) | **Auto-refresh:** run `--force-refresh`, reload cache, retry once |

## Error Recovery

See `resources/REFERENCE.md` Section 5 for the HTTP status table.
- **Auto-refresh:** On stale-cache errors (field key/shape mismatch, unrecognized transition ID, missing value in `fieldSchemas`), run `--force-refresh`, reload cache, and retry **once**. Never retry more than once without diagnosing.
- **401/403:** Report to the user (or follow `R23` in `./resources/operations-and-telemetry.md` for `cloudId` auth mismatch).
- **Exhausted retries:** Record `--telemetry` on every retry and run shared telemetry (`R9`, `class: schema` or `workflow`) if `400` on create or repeated `400` persists — see `./resources/operations-and-telemetry.md`.

## Quality Gates

| Gate | Check |
|------|-------|
| Cache loaded | `cloudId`, `project`, `issueTypes`, `fieldSchemas` present before any operation |
| Content format | Comments use `contentFormat: "adf"` via conversion script; descriptions/create use `contentFormat: "markdown"` |
| Response format | Every content-returning call uses `responseContentFormat: "markdown"` |
| No raw placeholders | All `{placeholder}` markers filled or section removed |
| Required fields | All required fields per `fieldSchemas` populated before create |
| Transition safety | Transition `id` from cache or fresh `getTransitionsForJiraIssue`, never guessed |
| User disambiguation | `lookupJiraAccountId` multi-match results always disambiguated |
| No fabricated values | All field values from cache `allowedValues` or user input |
| Artifacts verified | Both `approval-<hash>.token` and `critique-<hash>.json` confirmed for exact `payload_hash` (< 10 min old); enforced fail-closed by `hooks/pre-tool-jira-write-guard.js` (Step 3) |
| Link verified | `scripts/skill/jira.js --validate-body` returned exit 0 before write dispatch (Step 2.7) |
| Hash-bound approval | `approval-<hash>.token` on disk for exact `payload_hash` (LLM-verified per Step 3) |
| Critique artifact age | `critique-<hash>.json` on disk for exact `payload_hash` and < 10 min old (LLM-verified per Step 3) |
| Link verification passed | Step 2.7 `--validate-body` exited 0 for the final payload in this turn |
| No write without approve | Explicit `approve` from Step 2.6 `ask_question` in this exact turn (LLM-verified per Step 3) |
| Release notes single-sentence | `## Release Notes` has at most one sentence (single-sentence carve-out `R25.5`; ≥2 sentences fail) |

## DO NOT

- Dispatch any write MCP call without explicit `approve` in this turn (Step 2.6), passing `--validate-body` (Step 2.7), and verifying `approval-<hash>.token` + `critique-<hash>.json` on disk for the exact `payload_hash`.
- Write critique or approval artifacts directly via `fs.writeFile` — always use `lib/artifact-store.js` and `lib/payload-hash.js`.
- Generate a free-form `description` when a template exists, or ignore `.sdlc/jira-templates/<Type>.md`.
- Leave raw `{placeholder}` or `[bracketed prose]` markers in payloads, skip transition `requiredFields`, or guess field IDs, transition IDs, or `accountId`s.
- Send markdown directly in comments (`contentFormat: "adf"` via `scripts/lib/markdown-to-adf.js` is mandatory) or omit `responseContentFormat: "markdown"`.
- Edit URLs without user input, retry, or bypass Step 2.7 when `--validate-body` fails.
- Retry a failed MCP operation more than once without diagnosing or running `--force-refresh`.

## What's Next & See Also

- `./resources/operations-and-telemetry.md` — multi-site disambiguation, `--init-templates` walkthrough, bulk batching, telemetry (`R9`/`R14`/`R21`/`R22`/`R23`), gotchas, learning capture
- `./resources/operations-reference.md` — step-by-step procedures per operation type
- `./resources/REFERENCE.md` & `./resources/EXAMPLES.md` — cache schema, MCP parameters, JQL, field formats, errors, worked examples
- [`/plan-sdlc`](../plan-sdlc/SKILL.md) & [`/execute-plan-sdlc`](../execute-plan-sdlc/SKILL.md) — plan and execute from a Jira ticket
