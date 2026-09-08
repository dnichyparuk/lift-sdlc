# Jira SDLC — Reference

Supporting reference for the `jira-sdlc` skill. Contains cache schema documentation,
exact MCP tool parameter specs, field format tables, JQL patterns, markdown content
rules, and error recovery actions. Always check this file before constructing an MCP
call — it eliminates guesswork and prevents the most common API errors.

---

## Section 0: Cache Schema

The cache lives at `~/.sdlc-cache/jira/<sanitizedSiteHost>/<PROJECT_KEY>.json` (home-keyed, outside the working tree). It is created on first
`--check`, permanent by default (`maxAgeHours: 0`), and read before every MCP call to
avoid redundant API round-trips. Refreshed only on `--force-refresh`, when required
sections are missing, or when an operation fails due to stale cached data.

```json
{
  "version": 1,
  "lastUpdated": "2026-03-12T10:00:00.000Z",
  "maxAgeHours": 0,
  "cloudId": "uuid-string",
  "siteUrl": "https://yoursite.atlassian.net",
  "currentUser": {
    "accountId": "abc123",
    "displayName": "John Doe",
    "email": "john@example.com"
  },
  "project": {
    "key": "PROJ",
    "name": "My Project",
    "id": "10000"
  },
  "issueTypes": {
    "Task":     { "id": "10001", "subtask": false, "hierarchyLevel": 0  },
    "Bug":      { "id": "10002", "subtask": false, "hierarchyLevel": 0  },
    "Story":    { "id": "10003", "subtask": false, "hierarchyLevel": 0  },
    "Sub-task": { "id": "10004", "subtask": true,  "hierarchyLevel": -1 }
  },
  "fieldSchemas": {
    "Task": {
      "summary":     { "required": true,  "type": "string" },
      "description": { "required": false, "type": "string" },
      "priority": {
        "required": false,
        "type": "priority",
        "allowedValues": ["Highest", "High", "Medium", "Low", "Lowest"]
      },
      "labels":   { "required": false, "type": "array<string>" },
      "components": {
        "required": false,
        "type": "array<component>",
        "allowedValues": ["API", "Frontend", "Backend"]
      },
      "assignee":    { "required": false, "type": "user" },
      "fixVersions": {
        "required": false,
        "type": "array<version>",
        "allowedValues": ["1.0", "2.0"]
      },
      "customfield_10020": {
        "required": false,
        "name": "Sprint",
        "type": "number"
      },
      "customfield_10016": {
        "required": false,
        "name": "Story Points",
        "type": "number"
      },
      "customfield_10050": {
        "required": false,
        "name": "Team",
        "type": "option",
        "allowedValues": ["Alpha", "Beta"]
      }
    }
  },
  "workflows": {
    "Task": {
      "statuses": ["To Do", "In Progress", "In Review", "Done"],
      "transitions": {
        "To Do": [
          {
            "id": "21",
            "name": "Start Progress",
            "to": "In Progress",
            "requiredFields": {}
          },
          {
            "id": "31",
            "name": "Done",
            "to": "Done",
            "requiredFields": {
              "resolution": {
                "required": true,
                "allowedValues": ["Done", "Won't Do", "Duplicate"]
              }
            }
          }
        ],
        "In Progress": [
          {
            "id": "11",
            "name": "Stop Progress",
            "to": "To Do",
            "requiredFields": {}
          },
          {
            "id": "41",
            "name": "Submit for Review",
            "to": "In Review",
            "requiredFields": {}
          },
          {
            "id": "51",
            "name": "Done",
            "to": "Done",
            "requiredFields": {
              "resolution": {
                "required": true,
                "allowedValues": ["Done", "Won't Do"]
              }
            }
          }
        ]
      }
    }
  },
  "linkTypes": [
    { "name": "Blocks",    "inward": "is blocked by",    "outward": "blocks"        },
    { "name": "Relates",   "inward": "relates to",       "outward": "relates to"    },
    { "name": "Duplicate", "inward": "is duplicated by", "outward": "duplicates"    }
  ],
  "userMappings": {
    "John Doe":            "account-id-123",
    "jane.smith@corp.com": "account-id-456"
  }
}
```

**Field Type Mapping** (used when populating `fieldSchemas` from
`getJiraIssueTypeMetaWithFields` in cache-initialization Phase 4):

| API `schema.type` | Cache `type` | Notes |
|---|---|---|
| `string` | `string` | |
| `number` | `number` | |
| `priority` | `priority` | Has `allowedValues` |
| `option` | `option` | Custom single-select |
| `array` of `option` | `multi-option` | Custom multi-select |
| `user` | `user` | |
| `date` | `date` | Format `YYYY-MM-DD` |
| `datetime` | `datetime` | ISO-8601 |

**Key invariant:** Always use `cloudId` from cache — never call
`getAccessibleAtlassianResources` again after initialization. Similarly, never re-fetch
`issueTypes`, `fieldSchemas`, `workflows`, or `linkTypes` unless `--force-refresh` is
passed or an operation error indicates stale cached data.

Cache permanence: when `maxAgeHours` is `0` (the default), the cache never expires based
on time — it is refreshed only when `--force-refresh` is passed or when operations fail
due to stale data. If `maxAgeHours` is set to a positive number, the TTL behavior applies:
compare `lastUpdated` + `maxAgeHours` against the current timestamp; if stale, run the
full initialization sequence.

**Unsampled workflow shape:** When `--skip-workflow-discovery` is passed, Phase 5 is
bypassed and each non-subtask issue type is stored with:

```json
"workflows": {
  "Task": { "unsampled": true },
  "Bug":  { "unsampled": true }
}
```

Subtask types have no workflow entry. At runtime, any transition operation that encounters
an `unsampled` marker falls back to a live `getTransitionsForJiraIssue` call per issue —
the same stale-cache auto-refresh path handles it transparently.

**`--check` output shape:** The prepare script `--check` subcommand emits JSON with
these fields:

```jsonc
{
  "exists": false,           // true when cache file present and readable
  "fresh": false,            // true when within TTL or maxAgeHours === 0
  "projectKey": "PROJ",
  "cachePath": null,         // resolved file path (null when not resolvable)
  "candidateSites": [],      // non-empty when same key found under 2+ site subdirs
  "missing": ["all"],        // required sections absent from cache
  "flags": {
    "skipWorkflowDiscovery": false,   // echoes the --skip-workflow-discovery arg
    "site": null                      // echoes the --site arg (null if not passed)
  },
  "errors": [],
  "warnings": []
}
```

When `candidateSites` is non-empty, `exists` is always `false` and `cachePath` is `null`.
The caller must re-run with `--site <host>` from `candidateSites` to disambiguate.

---

## Section 1: MCP Tool Parameter Reference

### Universal Rules

```
ALWAYS:
  Comments:     convert markdown to ADF via scripts/lib/markdown-to-adf.js,
                then pass contentFormat: "adf" with the ADF JSON body
  Descriptions: contentFormat: "markdown"  — on create/edit calls (no conversion needed)
  Reading:      responseContentFormat: "markdown"   — on every call that returns content

NEVER:
  Post raw markdown comments without ADF conversion — always pipe through markdown-to-adf.js
  Call getAccessibleAtlassianResources after cache init
  Call getJiraIssueTypeMetaWithFields after cache init
  Call getIssueLinkTypes after cache init
  Guess field IDs, transition IDs, or accountIds
```

---

### Identity & Discovery

#### `mcp__atlassian__getAccessibleAtlassianResources`

No parameters. Called once during initialization only. Returns an array of accessible
Atlassian sites, each with `id` (the `cloudId` to store in cache) and `url`.

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| _(none)_ | — | — | Returns `[{ id, url, name, scopes, avatarUrl }]` |

#### `mcp__atlassian__atlassianUserInfo`

No parameters. Called once during initialization. Returns the authenticated user's
account details to populate `cache.currentUser`.

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| _(none)_ | — | — | Returns `{ accountId, displayName, emailAddress }` |

#### `mcp__atlassian__getIssueLinkTypes`

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `cloudId` | string | Yes | From `cache.cloudId` |

Returns all link type objects. Store in `cache.linkTypes`. Do not call again after init.

---

### Project & Metadata

#### `mcp__atlassian__getVisibleJiraProjects`

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `cloudId` | string | Yes | From `cache.cloudId` |
| `limit` | number | No | Default 50, max 100 |
| `startAt` | number | No | Pagination offset |
| `searchString` | string | No | Filters by project key or name prefix |

Use `searchString` to confirm a project key exists before caching. Prefer exact key match.

#### `mcp__atlassian__getJiraProjectIssueTypesMetadata`

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `cloudId` | string | Yes | From `cache.cloudId` |
| `projectKey` | string | Yes | E.g., `"PROJ"` |

Authoritative source for issue type names and IDs. Store results in
`cache.issueTypes`. Do not call after init.

#### `mcp__atlassian__getJiraIssueTypeMetaWithFields`

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `cloudId` | string | Yes | From `cache.cloudId` |
| `projectKey` | string | Yes | E.g., `"PROJ"` |
| `issueTypeId` | string | Yes | From `cache.issueTypes[name].id` — NOT the name |

Returns all available fields for the issue type, including custom fields with their keys
(`customfield_XXXXX`), allowed values, and `required` flags. Store in
`cache.fieldSchemas[issueTypeName]`. Do not call after init.

#### `mcp__atlassian__getTransitionsForJiraIssue`

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `cloudId` | string | Yes | From `cache.cloudId` |
| `issueKey` | string | Yes | E.g., `"PROJ-123"` |

Returns only the transitions available from the issue's **current** status — the list is
context-sensitive. Use the returned `id` value when calling `transitionJiraIssue`. Do not
rely on cached transition IDs if the issue may have been updated since the cache was
written; call this fresh when transitioning.

---

### Issue CRUD

#### `mcp__atlassian__createJiraIssue`

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `cloudId` | string | Yes | From `cache.cloudId` |
| `projectKey` | string | Yes | E.g., `"PROJ"` |
| `issueTypeName` | string | Yes | String name — NOT the numeric ID. E.g., `"Task"`, `"Bug"` |
| `summary` | string | Yes | Plain text; no markdown |
| `description` | string | No | Markdown string; pair with `contentFormat: "markdown"` |
| `contentFormat` | string | No | Always pass `"markdown"` when description is provided |
| `assignee_account_id` | string | No | accountId from `cache.userMappings` or `lookupJiraAccountId` |
| `parent` | string | No | Parent issue key as string (e.g., `"PROJ-100"`); required for Sub-task types |
| `additional_fields` | object | No | Flat object of extra fields; see Section 2 for shapes |
| `responseContentFormat` | string | No | Always pass `"markdown"` |

#### `mcp__atlassian__editJiraIssue`

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `cloudId` | string | Yes | From `cache.cloudId` |
| `issueKey` | string | Yes | E.g., `"PROJ-123"` |
| `fields` | object | Yes | Flat object of fields to update; see Section 2 for shapes |
| `contentFormat` | string | No | Pass `"markdown"` when fields include description |
| `responseContentFormat` | string | No | Always pass `"markdown"` |

`fields` is a **flat object** — do NOT nest fields under `fields.fields`. Pass custom
fields directly by their key: `{ "customfield_10016": 5 }`.

#### `mcp__atlassian__getJiraIssue`

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `cloudId` | string | Yes | From `cache.cloudId` |
| `issueKey` | string | Yes | E.g., `"PROJ-123"` |
| `fields` | array | No | Array of field name strings to return; omit for all fields |
| `responseContentFormat` | string | No | Always pass `"markdown"` |

Example `fields` array: `["summary", "status", "assignee", "customfield_10016"]`

---

### Workflow

#### `mcp__atlassian__transitionJiraIssue`

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `cloudId` | string | Yes | From `cache.cloudId` |
| `issueKey` | string | Yes | E.g., `"PROJ-123"` |
| `transition` | object | Yes | `{ "id": "21" }` — object with `id` string, NOT the transition name |
| `fields` | object | No | Required fields for the transition (e.g., `{ "resolution": { "name": "Done" } }`) |

Always call `getTransitionsForJiraIssue` first to obtain the current valid transition IDs.
Do not reuse a transition `id` from cache without verifying it is still in the live
transitions list.

#### `mcp__atlassian__createIssueLink`

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `cloudId` | string | Yes | From `cache.cloudId` |
| `linkType` | object | Yes | `{ "name": "Blocks" }` — use the link type name from `cache.linkTypes` |
| `inwardIssue` | object | Yes | `{ "key": "PROJ-123" }` |
| `outwardIssue` | object | Yes | `{ "key": "PROJ-456" }` |

Direction matters: for `linkType.name = "Blocks"`, the `outwardIssue` is the one doing the
blocking and the `inwardIssue` is the one being blocked. Cross-reference `inward`/`outward`
labels in `cache.linkTypes` to confirm directionality before calling.

---

### Search & Read

#### `mcp__atlassian__searchJiraIssuesUsingJql`

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `cloudId` | string | Yes | From `cache.cloudId` |
| `jql` | string | Yes | JQL query string; see Section 3 for patterns |
| `fields` | array | No | Array of field names to return; omit for default set |
| `maxResults` | number | No | Max 100 per call; default 50 |
| `startAt` | number | No | Pagination offset; use with `maxResults` for large result sets |
| `responseContentFormat` | string | No | Always pass `"markdown"` |

For paginated results, increment `startAt` by `maxResults` until the returned `total`
is exhausted.

#### `mcp__atlassian__search`

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `cloudId` | string | Yes | From `cache.cloudId` |
| `query` | string | Yes | Full-text search string across all content |
| `limit` | number | No | Max results to return |
| `offset` | number | No | Pagination offset |

Broader than JQL — searches across Jira issues and Confluence content. Use
`searchJiraIssuesUsingJql` when you need structured filtering; use `search` for
open-ended discovery.

---

### Social

#### `mcp__atlassian__addCommentToJiraIssue`

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `cloudId` | string | Yes | From `cache.cloudId` |
| `issueIdOrKey` | string | Yes | E.g., `"PROJ-123"` |
| `commentBody` | string | Yes | ADF JSON string from `markdown-to-adf.js` |
| `contentFormat` | string | No | Pass `"adf"` for comments (compose in markdown, convert via script) |
| `responseContentFormat` | string | No | Always pass `"markdown"` |

#### `mcp__atlassian__addWorklogToJiraIssue`

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `cloudId` | string | Yes | From `cache.cloudId` |
| `issueKey` | string | Yes | E.g., `"PROJ-123"` |
| `timeSpent` | string | Yes | Format: `"2h"`, `"30m"`, `"1d"`, `"1h 30m"` — Jira duration notation |
| `comment` | string | No | Optional work description (plain text or markdown) |
| `adjustEstimate` | string | No | `"auto"`, `"leave"`, `"manual"`, `"new"` — controls remaining estimate |
| `newEstimate` | string | No | New remaining estimate (same format as `timeSpent`); only used when `adjustEstimate = "new"` |

---

### User Lookup

#### `mcp__atlassian__lookupJiraAccountId`

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `cloudId` | string | Yes | From `cache.cloudId` |
| `query` | string | Yes | Display name, email, or username fragment |

Returns an array of matching user objects. If multiple results are returned, surface them
to the user for disambiguation — never guess which account to use. Store confirmed
mappings in `cache.userMappings` keyed by display name and email.

---

## Section 2: Field Format Specifications

Use this table when constructing `createJiraIssue.additional_fields` or
`editJiraIssue.fields`. Deviations from these shapes are the most common cause of 400
errors.

| Field / Type | JSON Shape | Example | Notes |
|---|---|---|---|
| `summary` (string) | `"value"` | `"Fix login redirect bug"` | Top-level param on create, not in `additional_fields` |
| `description` (markdown) | `"markdown text"` | `"## Bug\n\nSteps to reproduce:\n1. ..."` | Always pair with `contentFormat: "markdown"` |
| `priority` | `{ "name": "..." }` | `{ "name": "High" }` | NOT `{ "id": "2" }` or bare `"High"` |
| `assignee` | `{ "accountId": "..." }` | `{ "accountId": "abc123" }` | Get from `cache.userMappings` or `lookupJiraAccountId` |
| `labels` | `["...", "..."]` | `["backend", "urgent"]` | Flat string array — NOT array of objects |
| `components` | `[{ "name": "..." }]` | `[{ "name": "API" }]` | Array of name-keyed objects |
| `fixVersions` | `[{ "name": "..." }]` | `[{ "name": "2.0" }]` | Array of name-keyed objects |
| `resolution` | `{ "name": "..." }` | `{ "name": "Done" }` | Required on transitions to Done in many workflows |
| `parent` (subtask) | `"PROJ-123"` | `"PROJ-100"` | String key, top-level param on create only |
| `duedate` | `"YYYY-MM-DD"` | `"2026-03-31"` | ISO date string, no time component |
| `datetime` fields | ISO-8601 string | `"2026-03-12T10:00:00.000+0000"` | Full ISO-8601 with timezone offset |
| `number` (story points, custom) | `N` | `5` | Raw number — no object wrapper |
| `sprint` (`customfield_10020`) | `N` | `42` | Sprint **ID** as number — not the sprint name or an object |
| `custom select` (single) | `{ "value": "..." }` | `{ "value": "Option A" }` | NOT `{ "name": "..." }` |
| `custom multi-select` | `[{ "value": "..." }]` | `[{ "value": "A" }, { "value": "B" }]` | Array of value-keyed objects |
| `custom cascading select` | `{ "value": "...", "child": { "value": "..." } }` | `{ "value": "Level1", "child": { "value": "Level2" } }` | Nested value objects |
| `custom user picker` | `{ "accountId": "..." }` | `{ "accountId": "abc123" }` | Same shape as `assignee` |
| `custom text field` | `"value"` | `"any string"` | Plain string, same as `summary` |

**Important notes on `editJiraIssue`:**

- `fields` is a flat object — do NOT nest fields under `fields.fields`.
- Pass custom fields directly by their key: `{ "customfield_10016": 5, "customfield_10020": 42 }`.
- Omitted fields are left unchanged — you do not need to include all fields on every edit.
- To clear a field, pass `null` for fields that accept null (not all do — check `fieldSchemas`).

If an operation fails with 400 and the field format matches this table, check whether the
field is required for the specific issue type using `cache.fieldSchemas[issueType][field].required`.
Required fields on create produce 400 if omitted.

---

## Section 3: JQL Quick Reference

### Common Query Patterns

| Intent | JQL |
|--------|-----|
| My open issues | `assignee = currentUser() AND status != Done ORDER BY updated DESC` |
| Sprint backlog | `project = PROJ AND sprint in openSprints() ORDER BY rank ASC` |
| Recent bugs (7 days) | `project = PROJ AND issuetype = Bug AND created >= -7d ORDER BY created DESC` |
| By label | `project = PROJ AND labels = "backend"` |
| Unassigned open issues | `project = PROJ AND assignee is EMPTY AND status != Done` |
| All subtasks of parent | `parent = PROJ-123` |
| Text search | `project = PROJ AND text ~ "search term" ORDER BY updated DESC` |
| By status category | `project = PROJ AND statusCategory = "In Progress"` |
| Updated in last 24h | `project = PROJ AND updated >= -1d ORDER BY updated DESC` |
| Linked to an issue | `issue in linkedIssues("PROJ-123")` |
| High/Highest priority open | `project = PROJ AND priority in (Highest, High) AND status != Done` |
| Created by me | `project = PROJ AND reporter = currentUser() ORDER BY created DESC` |
| Resolved last week | `project = PROJ AND resolved >= -1w AND resolved <= now()` |
| Epic children | `"Epic Link" = PROJ-50 ORDER BY rank ASC` |
| By component | `project = PROJ AND component = "API"` |
| Open blockers of an issue | `project = PROJ AND issue in linkedIssues("PROJ-123", "is blocked by") AND status != Done` |
| Multiple statuses | `project = PROJ AND status in ("To Do", "In Progress")` |
| No fix version (non-Epic) | `project = PROJ AND fixVersion is EMPTY AND issuetype != Epic` |
| Overdue (past due date) | `project = PROJ AND duedate < now() AND status != Done` |
| Issues I'm watching | `issue in watchedIssues()` |

### JQL Escaping Rules

- Wrap values containing spaces in double quotes: `project = "My Project"`
- Escape single quotes inside a value: `summary ~ "can\\'t login"`
- Reserved words (`AND`, `OR`, `NOT`, `ORDER`, `BY`, `ASC`, `DESC`, `IS`, `EMPTY`,
  `NULL`, `TRUE`, `FALSE`) must be quoted if used as literal values, but are used bare
  as keywords in the query structure
- Issue keys do not need quotes: `parent = PROJ-123`
- `currentUser()` is a function — no quotes around it: `assignee = currentUser()`
- Relative date offsets use a number followed by a unit suffix: `-7d` (days), `-1w`
  (weeks), `-1h` (hours). No spaces between number and suffix.
- `in` clauses use parentheses, not square brackets: `status in ("To Do", "In Progress")`
- `is EMPTY` and `is not EMPTY` test for null/unset fields — do not use `= null`

---

## Section 4: Markdown Content Rules

Compose all content (descriptions and comments) in markdown following the rules below.
For **comments**, the markdown is then converted to ADF via `scripts/lib/markdown-to-adf.js`
before posting — the conversion is automatic, but the source must use only the safe syntax
defined here. For **descriptions**, markdown is submitted directly with `contentFormat: "markdown"`.

The Jira markdown renderer is a subset of CommonMark. The following tables define what is
safe to use and what to avoid.

### Supported Syntax

| Element | Syntax | Example |
|---------|--------|---------|
| Heading 1 | `# text` | `# Summary` |
| Heading 2 | `## text` | `## Steps to Reproduce` |
| Heading 3 | `### text` | `### Expected Behavior` |
| Bold | `**text**` | `**Critical**` |
| Italic | `*text*` | `*optional*` |
| Unordered list | `- item` or `* item` | `- Step one` |
| Ordered list | `1. item` | `1. Open the app` |
| Inline code | `` `code` `` | `` `null pointer` `` |
| Fenced code block | ` ```lang\ncode\n``` ` | ` ```js\nconsole.log()\n``` ` |
| Link | `[text](url)` | `[Ticket](https://...)` |
| Table | `\| col \| col \|` with `\|---\|---\|` separator row | Standard markdown table |
| Horizontal rule | `---` | Separates sections |
| Blockquote (single level) | `> text` | `> Original requirement` |

### Broken or Unsupported — Avoid

| Element | Syntax | Problem |
|---------|--------|---------|
| HTML tags | `<b>`, `<br>`, `<details>` | Rendered as literal text, not interpreted |
| Task lists | `- [ ] item` | Variable support; renders as literal `[ ]` in many Jira versions |
| Nested blockquotes | `>> text` | Renders as literal `>` |
| Footnotes | `[^1]: text` | Not supported |
| Definition lists | `term\n: definition` | Not supported |
| Strikethrough | `~~text~~` | Not supported in all Jira versions |
| Custom emoji | `:smile:` | Not rendered |
| Raw HTML entities | `&nbsp;`, `&mdash;` | May render as literals |

### Template Placeholder Rule

Never submit a description or comment that contains unfilled placeholder text such as
`{placeholder}`, `{{variable}}`, `<INSERT HERE>`, or `TODO: fill in`. Either:

1. Replace the placeholder with the actual content derived from user context, or
2. Remove the entire line or section if the content is not available.

A description with raw placeholders visible to other Jira users is always incorrect.

---

## Section 5: Error Code Reference

| HTTP Status | Meaning | Likely Cause | Recovery |
|-------------|---------|--------------|----------|
| 400 Bad Request | Invalid field value or format | Wrong field shape (e.g., `"High"` instead of `{ "name": "High" }`), missing required field, invalid enum value | Check `cache.fieldSchemas` for allowed values; verify field shape against Section 2 |
| 400 on transition | Transition validation failed | Missing required field for the transition (e.g., `resolution` when closing) | Check `cache.workflows[issueType].transitions[currentStatus][n].requiredFields`; include all required fields in `transitionJiraIssue.fields` |
| 401 Unauthorized | Authentication failure | MCP token expired or not connected | Reconnect the Atlassian MCP integration; cannot recover programmatically |
| 403 Forbidden | Insufficient permissions | Authenticated user lacks the required project or issue permission | Report to user — this cannot be fixed programmatically |
| 404 Issue not found | Issue key does not exist | Typo in issue key, issue was deleted, or wrong project prefix | Ask user to verify the issue key; check project key in `cache.project.key` |
| 404 Project not found | Project key does not exist | Typo, no access, or wrong Atlassian cloud | Re-run `--check` to validate; verify `cloudId` matches the intended site |
| 409 Conflict | Concurrent edit detected | Another user or process modified the issue between your read and write | Retry once after a brief pause; if it persists, fetch fresh state and reapply the change |
| 422 Unprocessable Entity | Schema validation failed | Field value type mismatch (e.g., passing a string where a number is expected) | Re-read field schema from `cache.fieldSchemas`; cross-check type column in Section 2 |
| Stale transition ID | Transition ID no longer valid | Jira workflow was reconfigured by an admin after the cache was written | Pass `--force-refresh` to rebuild the cache, or call `getTransitionsForJiraIssue` fresh before retrying |

**Diagnosing 400 errors systematically:**

1. Confirm the field key is correct (check `cache.fieldSchemas` — custom field keys are
   `customfield_XXXXX`, not human names).
2. Confirm the value shape matches Section 2 for the declared field type.
3. Check `cache.fieldSchemas[issueType][field].required` — if `true` and the field was
   omitted on create, the API returns 400.
4. Check `cache.fieldSchemas[issueType][field].allowedValues` — if the field has
   constrained values and the submitted value is not in the list, the API returns 400.
5. If all of the above check out and the error persists, the cache may be stale; run
   `--force-refresh` and retry.
