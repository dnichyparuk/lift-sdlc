# review-sdlc — Reference

Supporting reference for the `review-sdlc` skill.
Contains: dimension file format spec, subagent prompt template, consolidated comment template.

See `EXAMPLES.md` (in this directory) for 5 copy-paste-ready example dimension files.

---

## 0. JSON Manifest Schema

`skill/review.js` outputs this JSON to stdout. The orchestrator agent reads it.

```json
{
  "version": 1,
  "timestamp": "ISO-8601",
  "subagent_model": "gemini-3.5-flash",
  "scope": "all",
  "base_branch": "main",
  "current_branch": "feat/xyz",
  "uncommitted_changes": false,
  "dirty_files": [],
  "git": {
    "commit_count": 5,
    "commit_log": "abc1234 feat: add widget\n...",
    "changed_files": ["src/a.ts", "src/b.ts"]
  },
  "pr": {
    "exists": true,
    "number": 42,
    "url": "https://github.com/owner/repo/pull/42",
    "owner": "owner",
    "repo": "repo"
  },
  "dimensions": [
    {
      "name": "security-review",
      "description": "...",
      "severity": "high",
      "requires_full_diff": false,
      "model": "gemini-3.5-flash",
      "status": "ACTIVE",
      "matched_files": ["src/auth/login.ts"],
      "matched_count": 1,
      "truncated": false,
      "diff_file": "/tmp/sdlc-review-XXXXX/security-review.diff",
      "body": "# Security Review\n...",
      "file_context": [
        {
          "file": "src/auth/login.ts",
          "commits": [{ "hash": "abc1234", "subject": "feat: add OAuth2 flow" }]
        }
      ],
      "warnings": []
    }
  ],
  "plan_critique": {
    "uncovered_files": ["README.md"],
    "uncovered_suggestions": [
      {
        "dimension": "documentation-quality-review",
        "files": ["README.md"],
        "reason": "1 documentation file not covered by any dimension"
      }
    ],
    "still_uncovered": [],
    "over_broad_dimensions": [],
    "overlapping_pairs": [],
    "dimension_cap_applied": false,
    "queued_dimensions": []
  },
  "summary": {
    "total_dimensions": 5,
    "active_dimensions": 3,
    "skipped_dimensions": 2,
    "queued_dimensions": 0,
    "total_changed_files": 12,
    "uncovered_file_count": 1,
    "suggested_dimensions": 1
  },
  "diff_dir": "/tmp/sdlc-review-XXXXX"
}
```

`status` values: `ACTIVE`, `SKIPPED`, `TRUNCATED`, `QUEUED`

`scope` values:

- `all` (default) — committed branch changes + staged changes (`git diff --cached {base}`)
- `committed` — committed branch changes only (`git diff {base}..HEAD`)
- `staged` — staged changes vs HEAD only (`git diff --cached`)
- `working` — all uncommitted changes vs HEAD, staged + unstaged (`git diff HEAD`)
- `worktree` — full working tree vs base: committed + staged + unstaged (`git diff {base}`)

When `scope` is `staged` or `working`: `base_branch` is `null`, `git.commit_count` is `0`, `git.commit_log` is `""`, and `file_context[].commits` arrays are empty. `pr` is `{ exists: false }`.

When `scope` is `worktree`: `base_branch` is set, `git.commit_count` and `git.commit_log` reflect commits since base, and `file_context[].commits` arrays are populated. The diff additionally includes unstaged working tree changes. `pr` is populated if a PR exists. Note: untracked files (never `git add`-ed) are not included.

---

## 1. Dimension File Format

Each project defines review dimensions as `.md` files in `<project>/.sdlc/review-dimensions/`.

### Schema

```yaml
---
name: <string>              # REQUIRED. Lowercase letters, digits, hyphens. Max 64 chars. Unique.
description: <string>       # REQUIRED. What this dimension reviews. Max 256 chars.
triggers:                   # REQUIRED. Non-empty array of glob patterns. At least one pattern.
  - "**/*.pattern"
  - "**/directory/**"
skip-when:                  # OPTIONAL. Negative globs — matched files are excluded even if triggers match.
  - "**/*.md"
  - "**/testdata/**"
severity: medium            # OPTIONAL. Default: medium. One of: critical | high | medium | low | info
max-files: 100              # OPTIONAL. Default: 100. Positive integer. Files over this limit are truncated with a warning.
requires-full-diff: false   # OPTIONAL. Default: false. If true, subagent receives the full diff for matched files.
---

[Review instructions body — free-form Markdown, minimum 10 characters]
```

### Field reference

| Field | Required | Type | Default | Constraints |
|-------|----------|------|---------|-------------|
| `name` | Yes | string | — | Lowercase, digits, hyphens; max 64 chars; unique across all dimension files |
| `description` | Yes | string | — | Non-empty; max 256 chars |
| `triggers` | Yes | string[] | — | Non-empty array; each must be valid glob syntax |
| `skip-when` | No | string[] | `[]` | Each must be valid glob syntax |
| `severity` | No | string | `medium` | One of: `critical`, `high`, `medium`, `low`, `info` |
| `max-files` | No | integer | `100` | Positive integer |
| `requires-full-diff` | No | boolean | `false` | — |
| `model` | No | string | `null` | One of: `gemini-3.5-flash`, `gemini-3.5-flash`, `gemini-3.1-pro`. Per-dimension model override; falls back to `manifest.subagent_model` when null. Claude-Code-only — Copilot transform omits it. |

### Body content

The Markdown body below the frontmatter contains the review instructions passed verbatim to the subagent.
There is no enforced section structure — the author decides what the subagent needs.

Recommended elements:
- A brief statement of the dimension's focus
- A checklist of specific things to look for
- A severity guide (what constitutes critical vs. high vs. medium for this dimension)
- Project-specific context (e.g., "This project uses Express.js — check for missing middleware")

---

## 2. Subagent Prompt Template

When the skill dispatches a review subagent for a dimension, it fills this template:

```
# Code Review: {dimension.name}

## Your Role
You are a code reviewer focused exclusively on: {dimension.description}

## Review Instructions
{dimension body — full Markdown content below the frontmatter}

## Changed Files in Your Scope
{list of matched files, one per line}

## Commit Context

{if any entry in file_context has commits.length > 0}
Use these to understand the author's intent:

{for each entry in file_context where entry.commits.length > 0}
- `{entry.file}` — {entry.commits.map(c => `${c.hash}: ${c.subject}`).join('; ')}
{end for}
{else}
No commit context available (reviewing {scope} changes — no commits to reference).
{end if}

## Diff to Review
{content of dimension.diff_file — pre-computed by skill/review.js}

## Default Severity
Unless the review instructions specify otherwise, classify findings as: {dimension.severity}

## Output Format
Return your findings as a structured list. Each finding MUST follow this exact format:

### Finding N
- **File**: {relative file path}
- **Line**: {line number or range, e.g., 42 or 42-48}
- **Severity**: {critical|high|medium|low|info}
- **OWASP**: {A01–A10, OPTIONAL — populate ONLY when the dimension body instructs OWASP tagging; omit this line entirely for any other dimension}
- **Title**: {one-line summary, max 80 chars}
- **Description**: {what is wrong and why it matters, 1-3 sentences}
- **Suggestion**: {how to fix it, 1-3 sentences — "N/A" if no clear fix}

## Constraints
- Review ONLY the files listed above — do not read other files
- Review ONLY for the concerns described in the review instructions — stay in scope
- If you find ZERO issues, explicitly state: "No findings for this dimension."
- Do NOT fabricate issues
- Each finding must reference a specific file and line number
- Maximum 20 findings (prioritize by severity if more exist)
```

**Diff scoping:**
- When `requires-full-diff` is `false` (default): subagent receives only the diff hunks for its matched files
- When `requires-full-diff` is `true`: subagent receives the complete diff output for those files

---

## 3. Consolidated PR Comment Template

After all subagents complete and findings are deduplicated, post this as a single PR comment:

```markdown
## Code Review — {N} dimension(s), {M} finding(s)

> Automated review by `review-sdlc` v{plugin_version} · {date}

### Summary

| Dimension | Findings | Critical | High | Medium | Low | Info |
|-----------|----------|----------|------|--------|-----|------|
| {name} | {total} | {critical} | {high} | {medium} | {low} | {info} |
| **Total** | **{total}** | **{critical}** | **{high}** | **{medium}** | **{low}** | **{info}** |

### Verdict: {CHANGES REQUESTED | APPROVED WITH NOTES | APPROVED}

{One-sentence overall assessment}

---

### {dimension.name} — {N} finding(s)

<details>
<summary>{critical} critical · {high} high · {medium} medium · {low} low · {info} info</summary>

#### [{SEVERITY}] {title}
**File:** `{file}:{line}`{if OWASP set: ` · OWASP {OWASP}`}
{description}
**Suggestion:** {suggestion}

</details>

---
```

**Template variable `{plugin_version}`:** Resolved by the prepare script (`review.js`) and emitted as `manifest.plugin_version`. The orchestrator reads it from the manifest and substitutes it verbatim — the `v` prefix is part of the template, not the value.

**OWASP rendering rule:** When the finding contains an `**OWASP:**` value, append ` · OWASP {code}` to the File line (e.g., ``**File:** `src/auth/login.ts:42` · OWASP A07``). Omit the suffix entirely when the field is absent. The OWASP slot is opt-in per dimension — only dimensions whose body explicitly instructs OWASP tagging will populate it.

**Verdict computation:**
- `CHANGES REQUESTED` — any `critical` finding, or ≥ 3 `high` findings
- `APPROVED WITH NOTES` — any `high` finding, or ≥ 5 `medium` findings
- `APPROVED` — all other cases (low/info only, or nothing)

**Deduplication rule:** When two dimensions flag the same `file:line`, keep the finding from the higher-severity dimension. Add a note: "Also flagged by: {other dimension}."

**Contradiction rule:** When two dimensions give conflicting recommendations for the same `file:line`, keep both findings and add: "Note: conflicting recommendations — manual review required."
