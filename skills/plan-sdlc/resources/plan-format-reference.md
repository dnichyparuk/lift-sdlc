# Plan Document Format Reference

Canonical format for implementation plans produced by `plan-sdlc` and consumed by `execute-plan-sdlc`. Both skills reference this document.

---

## Document Header (required)

Every plan document must begin with this header:

```markdown
# [Feature Name] Implementation Plan

**Goal:** [One sentence describing what this plan implements]
**Architecture:** [2–3 sentences about the overall approach and key design decisions]
**Source:** [Spec file path, or "conversation context" if no file]
**Verification:** [Primary verification command — e.g., "npm test", "go test ./...", "make test"]

---
```

All four fields are required. `execute-plan-sdlc` uses `Verification` as the default test command.

## Key Decisions (optional)

Capture architecture and design decisions made during planning that executing agents need to understand. Place this section between the document header and the first task block.

```markdown
## Key Decisions

- **[Choice A] over [Choice B]:** [Why — reference codebase patterns or constraints, not preference]
- **[Choice C] over [Choice D]:** [Why]
```

**What to include:**
- Choices where a reasonable implementer might choose differently without context
- Decisions backed by codebase evidence (e.g., "existing modules use pattern X in Y")
- Architecture decisions that affect multiple tasks

**What to skip:**
- Obvious decisions where only one reasonable option existed
- Stylistic preferences with no execution impact

Recommended for plans with 5+ tasks. Omit for simple plans. The Key Decisions section is free-text — `execute-plan-sdlc` does not parse it, but agents receive it as context alongside task descriptions.

---

## Guardrail Compliance (optional)

Present when `plan.guardrails` are configured in `.sdlc/config.json`. Produced by plan-sdlc Step 4.
`execute-plan-sdlc` does not parse this section — it documents constraint evaluation for reviewers.

```markdown
## Guardrail Compliance

| Guardrail | Severity | Status | Rationale |
|---|---|---|---|
| no-direct-db-access | error | PASS | No tasks modify database schema files |
| prefer-composition | warning | PASS | No class hierarchies proposed |
```

---

## Per-Task Block (required for every task)

```markdown
### Task N: [Component Name]

**Complexity:** Trivial | Standard | Complex
**Risk:** Low | Medium | High
**Depends on:** Task X, Task Y (or "none")
**Verify:** tests | build | lint | manual

**Files:**
- Create: `exact/relative/path/to/file.ts`
- Modify: `exact/relative/path/to/existing.ts` — [one line: what changes]
- Test: `tests/exact/relative/path/to/test.ts`

**Description:**
[Full description of what to implement: what to build, how it connects to existing code,
expected behavior, edge cases to handle. Include code snippets for non-obvious patterns.
Complete enough that an agent with no codebase context can execute it.]

**Acceptance criteria:**
- [ ] [Specific, verifiable criterion]
- [ ] [Another criterion]

**openspec-task:** (optional — present only when plan was generated with `--from-openspec`)
- change: <change-name>
- ref: <kebab-slug-6char-hash>
- line: <1-indexed-line-number-at-plan-time>
- title: <verbatim-task-title-at-plan-time>
```

---

## Out-of-scope OpenSpec tasks (optional)

Present only when `--from-openspec` was used AND at least one OpenSpec task has no plan
coverage. Documents intentional exclusions so the G16 coverage gate passes and the archive
gate does not suppress the suggestion at execute time.

Format:
- <verbatim OpenSpec task title> — <one-line rationale>

---

## Field Value Constraints

| Field | Allowed Values | Notes |
|---|---|---|
| Complexity | `Trivial` \| `Standard` \| `Complex` | Used by execute-plan-sdlc for model assignment and wave building |
| Risk | `Low` \| `Medium` \| `High` | High-risk tasks trigger a user confirmation gate before execution |
| Depends on | `Task N, Task M` or `none` | Must reference tasks by their exact number; no forward references |
| Verify | `tests` \| `build` \| `lint` \| `manual` | Multiple allowed: `tests, build` |
| Files → Create | Relative path from project root | Must be exact — agents use this to know what to create |
| Files → Modify | Relative path + one-line description of change | Required if an existing file is modified |
| Files → Test | Relative path from project root | Omit row if task has no tests |
| openspec-task → change | String | OpenSpec change directory name |
| openspec-task → ref | kebab-slug + 6-char sha256 suffix | Computed from task title at plan time |
| openspec-task → line | Integer ≥ 1 | 1-indexed line in tasks.md at plan time |
| openspec-task → title | String | Verbatim task title at plan time |

---

## Example Plan

```markdown
# User Authentication Implementation Plan

**Goal:** Add JWT-based authentication to the API server.
**Architecture:** Stateless JWT tokens validated by middleware; user records in the existing database; no session storage.
**Source:** docs/specs/auth-spec.md
**Verification:** npm test

---

### Task 1: JWT utility module

**Complexity:** Standard
**Risk:** Low
**Depends on:** none
**Verify:** tests

**Files:**
- Create: `src/utils/jwt.ts`
- Test: `tests/utils/jwt.test.ts`

**Description:**
Create a JWT utility module that exports `signToken(payload, expiresIn)` and `verifyToken(token)`.
Use the `jsonwebtoken` npm package (already installed). Sign with `process.env.JWT_SECRET`.
`verifyToken` should throw a typed error (`JwtExpiredError` | `JwtInvalidError`) on failure.

**Acceptance criteria:**
- [ ] `signToken` returns a JWT string with the given payload
- [ ] `verifyToken` returns the decoded payload on valid tokens
- [ ] `verifyToken` throws `JwtExpiredError` on expired tokens
- [ ] `verifyToken` throws `JwtInvalidError` on malformed tokens
- [ ] Tests cover all four cases: sign, verify success, verify expired, verify invalid

---

### Task 2: Auth middleware

**Complexity:** Standard
**Risk:** Medium
**Depends on:** Task 1
**Verify:** tests

**Files:**
- Create: `src/middleware/auth.ts`
- Test: `tests/middleware/auth.test.ts`

**Description:**
Create Express middleware that reads the `Authorization: Bearer <token>` header,
calls `verifyToken` from Task 1, and attaches the decoded payload to `req.user`.
On missing or invalid token, respond with `401 { error: "Unauthorized" }`.
Import path: `import { verifyToken } from '../utils/jwt'`.

**Acceptance criteria:**
- [ ] Valid token: attaches decoded payload to `req.user` and calls `next()`
- [ ] Missing header: responds 401 with `{ error: "Unauthorized" }`
- [ ] Invalid/expired token: responds 401 with `{ error: "Unauthorized" }`
- [ ] Tests cover all three cases
```

---

## What NOT to Include in Plans

- Full implementation code (code snippets for patterns are fine; complete implementations are not)
- Absolute file paths (always use paths relative to project root)
- Superpowers-specific directives or REQUIRED SUB-SKILL headers
- References to tools or skills the executing agent should use
- Tasks with fewer than 2 acceptance criteria (not specific enough)
- Tasks that touch more than 5 files (split them)
