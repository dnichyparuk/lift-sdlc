# Review Dimension Examples

Ready-to-use dimension files. Copy any of these to your project's
`.sdlc/review-dimensions/` directory and adjust triggers and instructions
for your tech stack.

> **Note on `model:`** — every example below carries a `model:` recommendation matched to the dimension's precision/cost trade-off. The values are recommendations only; adopters should override per project budget and quality needs. Omit the field entirely to inherit the manifest default (`manifest.subagent_model`).

---

## security-review.md

```markdown
---
name: security-review
description: "OWASP Top 10 review — tags every finding with the matching A01–A10 category"
triggers:
  - "**/middleware/**"
  - "**/auth/**"
  - "**/crypto/**"
  - "**/session/**"
  - "**/*auth*"
  - "**/*token*"
  - "**/*secret*"
  - "**/*password*"
  - "**/routes/**"
  - "**/controllers/**"
skip-when:
  - "**/*.test.*"
  - "**/*.spec.*"
  - "**/testdata/**"
  - "**/__fixtures__/**"
severity: high
max-files: 50
model: gemini-3.5-flash
---

# Security Review (OWASP Top 10)

Review changes against the OWASP Top 10 (2025).

## Tagging Instruction (REQUIRED)

For every finding, set `**OWASP:**` to the matching category code (`A01`–`A10`). When a finding spans multiple categories, pick the most specific. Omit the field only when no OWASP category applies (rare).

## Checklist

- [ ] A01 — Broken access control: route/resource checks enforce both authentication AND authorization (role/permission), not just login
- [ ] A02 — Cryptographic failures: approved algorithms only, no MD5/SHA1/DES/ECB, secrets never logged, TLS verified, keys not hardcoded
- [ ] A03 — Injection: no SQL/command/template/LDAP injection vectors; user input is parameterised, escaped, or strictly validated
- [ ] A04 — Insecure design: trust boundaries respected, rate limiting on sensitive endpoints, no missing threat-model controls
- [ ] A05 — Security misconfiguration: no debug mode in prod, no default credentials, no overly broad CORS / permissive headers
- [ ] A06 — Vulnerable & outdated components: no deprecated/unmaintained deps, no known-CVE versions added, lockfile reviewed
- [ ] A07 — Identification & authentication failures: no weak password policy, no missing MFA on sensitive flows, sessions rotated on privilege change
- [ ] A08 — Software & data integrity failures: no unsigned updates, no untrusted deserialisation, CI/build pipeline integrity preserved
- [ ] A09 — Security logging & monitoring failures: auth/authz failures logged, no sensitive data in logs, audit trail not silently dropped
- [ ] A10 — SSRF: outbound requests with user-controlled URLs validated against an allowlist; metadata IPs blocked

## Severity Guide

| Category | Default Severity |
|----------|------------------|
| A01 — Broken access control | critical |
| A02 — Cryptographic failures | critical |
| A03 — Injection | critical |
| A04 — Insecure design | high |
| A05 — Security misconfiguration | high |
| A06 — Vulnerable & outdated components | high |
| A07 — Identification & authentication failures | critical |
| A08 — Software & data integrity failures | high |
| A09 — Security logging & monitoring failures | medium |
| A10 — SSRF | high |
```

> `model:` — optional. Forces this dimension's subagent onto the named model. Omit to inherit the manifest default.

---

## code-quality.md

```markdown
---
name: code-quality
description: "Reviews for code clarity, error handling, naming conventions, and common code smells"
triggers:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
  - "**/*.py"
  - "**/*.go"
  - "**/*.java"
  - "**/*.rb"
skip-when:
  - "**/*.test.*"
  - "**/*.spec.*"
  - "**/node_modules/**"
  - "**/vendor/**"
  - "**/dist/**"
  - "**/build/**"
severity: medium
model: gemini-3.5-flash
---

# Code Quality Review

Review for code clarity, maintainability, and common code smells.

## Checklist

- [ ] Function and variable names are clear and intention-revealing
- [ ] Functions do one thing (single responsibility)
- [ ] Error cases are handled explicitly — no silent failures
- [ ] No magic numbers or strings (use named constants)
- [ ] No dead code or commented-out code blocks
- [ ] No unnecessary complexity (YAGNI — you aren't gonna need it)
- [ ] No deeply nested conditionals that could be simplified
- [ ] Async operations handle errors (try/catch or .catch())
- [ ] No obvious resource leaks (unclosed connections, files, event listeners)
- [ ] Consistent style with surrounding code

## Severity Guide

| Finding | Severity |
|---------|----------|
| Silent error swallowing / lost error context | high |
| Resource leak | high |
| Inconsistent/misleading naming that could cause bugs | medium |
| Dead code | low |
| Magic number without explanation | low |
| Overly nested code (>3 levels deep) | low |
| Commented-out code blocks | info |
```

---

## performance.md

```markdown
---
name: performance
description: "Reviews for N+1 queries, unnecessary allocations, blocking operations, and caching opportunities"
triggers:
  - "**/services/**"
  - "**/repositories/**"
  - "**/models/**"
  - "**/queries/**"
  - "**/*repository*"
  - "**/*service*"
  - "**/*query*"
  - "**/*cache*"
severity: medium
max-files: 30
model: gemini-3.5-flash
---

# Performance Review

Review for common performance pitfalls.

## Checklist

- [ ] No N+1 query patterns (single-row fetches inside loops)
- [ ] Database queries select only needed columns (avoid SELECT *)
- [ ] Large result sets are paginated, not fetched entirely
- [ ] Expensive operations are not repeated unnecessarily (memoize / cache where appropriate)
- [ ] No synchronous / blocking I/O calls in async contexts
- [ ] No unnecessary data serialization / deserialization in hot paths
- [ ] Database indexes exist for fields used in WHERE / ORDER BY clauses (check migrations)
- [ ] Bulk operations use batch APIs rather than individual calls

## Severity Guide

| Finding | Severity |
|---------|----------|
| N+1 query in high-traffic path | high |
| Unbounded result set (no pagination) | high |
| Blocking I/O in async context | high |
| Repeated expensive computation (no memoization) | medium |
| SELECT * on large table | medium |
| Missing index on frequently queried field | medium |
| Minor allocation inefficiency | low |
```

---

## api-review.md

```markdown
---
name: api-review
description: "Reviews API changes for breaking changes, versioning, consistent error responses, and OpenAPI alignment"
triggers:
  - "**/routes/**"
  - "**/controllers/**"
  - "**/handlers/**"
  - "**/api/**"
  - "**/*router*"
  - "**/*handler*"
  - "**/*.yaml"
  - "**/*.json"
skip-when:
  - "**/node_modules/**"
  - "**/dist/**"
  - "**/*.test.*"
  - "**/*.spec.*"
severity: high
model: gemini-3.5-flash
---

# API Review

Review API changes for contract stability and consistency.

## Checklist

- [ ] No breaking changes to existing endpoints (removed fields, changed types, renamed paths)
- [ ] New endpoints follow existing naming and versioning conventions
- [ ] All error responses use consistent shape (e.g., `{ error: { code, message } }`)
- [ ] HTTP status codes are semantically correct (200/201/204/400/401/403/404/422/500)
- [ ] Pagination, filtering, and sorting follow existing API conventions
- [ ] Auth requirements are explicitly enforced on new endpoints
- [ ] OpenAPI/Swagger spec updated if it exists
- [ ] Sensitive data is not returned in responses unnecessarily

## Severity Guide

| Finding | Severity |
|---------|----------|
| Breaking change to existing endpoint | critical |
| Missing auth on new endpoint | critical |
| Inconsistent error response shape | high |
| Wrong HTTP status code | medium |
| OpenAPI spec not updated | medium |
| Sensitive data in response | high |
| Missing pagination on list endpoint | medium |
```

---

## test-coverage.md

```markdown
---
name: test-coverage
description: "Reviews whether new code paths have corresponding tests and whether existing tests remain meaningful"
triggers:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.jsx"
  - "**/*.py"
  - "**/*.go"
  - "**/*.java"
  - "**/*.rb"
skip-when:
  - "**/*.test.*"
  - "**/*.spec.*"
  - "**/node_modules/**"
  - "**/vendor/**"
severity: medium
model: gemini-3.5-flash
---

# Test Coverage Review

Review whether new code changes are accompanied by appropriate tests.

## Checklist

- [ ] New functions / methods have at least one test covering the happy path
- [ ] New error conditions have tests (edge cases, invalid input, failure modes)
- [ ] Tests are meaningful — they assert on behavior, not just that code runs
- [ ] Tests do not rely on external state (no implicit ordering, no shared mutable state)
- [ ] Mock/stub usage is appropriate — not hiding real behavior that should be tested
- [ ] Test names describe the scenario clearly (Given/When/Then or similar)
- [ ] Regression tests added when fixing bugs

## Severity Guide

| Finding | Severity |
|---------|----------|
| Complex new logic with no tests | high |
| Bug fix with no regression test | high |
| New public API function with no tests | medium |
| Test assertions too broad (only checks non-null) | medium |
| Missing edge case test | low |
| Test name does not describe scenario | info |
```

---

## ci-cd-pipeline-review.md

```markdown
---
name: ci-cd-pipeline-review
description: "Reviews CI/CD pipeline definitions for secret handling, job ordering, caching correctness, and reproducibility"
triggers:
  - ".github/workflows/**"
  - ".circleci/**"
  - "**/Jenkinsfile"
  - "**/.travis.yml"
  - "**/Makefile"
severity: medium
max-files: 20
model: gemini-3.5-flash
---

# CI/CD Pipeline Review

Review pipeline definitions for correctness, security, and efficiency.

## Checklist

- [ ] No secrets or tokens hardcoded in workflow files — use repository/org secrets
- [ ] `GITHUB_TOKEN` permissions are scoped to the minimum required (`contents: read`, etc.)
- [ ] Jobs run in the correct order — dependencies declared with `needs:` where required
- [ ] Cache keys are content-addressed (e.g., hash of lockfile) to avoid stale caches
- [ ] Cache restore uses fallback keys to avoid full cache misses on first run
- [ ] Pinned action versions use full SHA commit hashes, not mutable tags (`@v3`)
- [ ] Test and lint jobs fail fast — `fail-fast: true` or equivalent
- [ ] Artifact upload/download steps reference consistent names between jobs
- [ ] Environment-specific secrets are scoped to the correct environment (`environment:`)
- [ ] Workflow triggers are appropriately scoped — not running on every push to all branches
- [ ] No `continue-on-error: true` masking real failures in critical steps
- [ ] Matrix strategies do not include unnecessary combinations

## Severity Guide

| Finding | Severity |
|---------|----------|
| Hardcoded secret or token in workflow | critical |
| Overly permissive `GITHUB_TOKEN` permissions | high |
| Unpinned action version (mutable tag, not SHA) | high |
| Job dependency ordering error | high |
| Cache key not content-addressed (stale cache risk) | medium |
| `continue-on-error` masking real failures | medium |
| Workflow triggers too broad | low |
| Redundant matrix combinations | info |
```

---

## database-migrations-review.md

```markdown
---
name: database-migrations-review
description: "Reviews database migration files for ordering, reversibility, data integrity, and safe deployment patterns"
triggers:
  - "**/migrations/**"
  - "**/*.sql"
  - "**/alembic/**"
  - "**/flyway/**"
  - "**/db/migrate/**"
severity: high
max-files: 30
model: gemini-3.5-flash
---

# Database Migrations Review

Review migration files for correctness, safety, and reversibility.

## Checklist

- [ ] Migrations are numbered/timestamped and will apply in the correct order
- [ ] Each migration has a corresponding rollback / down migration
- [ ] No destructive operations (`DROP COLUMN`, `DROP TABLE`, `TRUNCATE`) without a data backup plan
- [ ] Column additions use `DEFAULT` values or are nullable to avoid locking issues on large tables
- [ ] Indexes are created `CONCURRENTLY` (PostgreSQL) or equivalent to avoid table locks
- [ ] No raw data transformations that could fail mid-migration and leave data inconsistent
- [ ] Foreign key constraints are added after data is in a consistent state
- [ ] Migration does not mix schema changes with data backfills in the same transaction
- [ ] Backfill migrations are idempotent (safe to re-run)
- [ ] No hardcoded environment-specific values (connection strings, schema names)
- [ ] Migration file name follows project conventions (timestamp prefix, descriptive name)

## Severity Guide

| Finding | Severity |
|---------|----------|
| Destructive operation without safety net | critical |
| Non-idempotent data migration | critical |
| Table lock on large table (blocking index creation) | high |
| Missing rollback / down migration | high |
| Non-nullable column added without default | high |
| Mixed schema + data changes in one transaction | medium |
| Hardcoded environment-specific value | medium |
| Missing timestamp prefix / naming convention | low |
```

---

## dependency-management-review.md

```markdown
---
name: dependency-management-review
description: "Reviews dependency changes for lockfile consistency, version pinning, deprecated packages, and license compliance"
triggers:
  - "**/package.json"
  - "**/package-lock.json"
  - "**/yarn.lock"
  - "**/pnpm-lock.yaml"
  - "**/requirements.txt"
  - "**/pyproject.toml"
  - "**/poetry.lock"
  - "**/Gemfile"
  - "**/Gemfile.lock"
  - "**/go.mod"
  - "**/go.sum"
  - "**/Cargo.toml"
  - "**/Cargo.lock"
skip-when:
  - "**/node_modules/**"
  - "**/vendor/**"
severity: medium
model: gemini-3.5-flash
---

# Dependency Management Review

Review dependency changes for consistency, security, and compliance.

## Checklist

- [ ] Lockfile is updated consistently with manifest changes (no divergence)
- [ ] New dependencies are pinned to an exact or narrow version range
- [ ] No packages added that are deprecated, unmaintained, or have known CVEs
- [ ] Major version bumps are intentional and migration notes reviewed
- [ ] Dev dependencies are not in the production dependency list
- [ ] No duplicate packages solving the same problem added
- [ ] License of new dependencies is compatible with the project's license
- [ ] Transitive dependency changes from lockfile updates are reviewed for unexpected major bumps
- [ ] No `*` or `latest` version specifiers in manifests
- [ ] For monorepos: shared dependency versions are consistent across workspace packages

## Severity Guide

| Finding | Severity |
|---------|----------|
| Package with known critical CVE added | critical |
| Lockfile diverges from manifest | high |
| Deprecated/unmaintained package with no alternative noted | high |
| Incompatible license added | high |
| Unintended major version bump in lockfile | medium |
| Dev dependency in production list | medium |
| `*` or `latest` version specifier | medium |
| Duplicate dependency solving same problem | low |
```

---

## error-handling-review.md

```markdown
---
name: error-handling-review
description: "Reviews error handling patterns for consistency, error context preservation, retry logic, and user-facing error messages"
triggers:
  - "**/*.ts"
  - "**/*.tsx"
  - "**/*.js"
  - "**/*.py"
  - "**/*.go"
  - "**/*.java"
  - "**/*.rb"
skip-when:
  - "**/*.test.*"
  - "**/*.spec.*"
  - "**/node_modules/**"
  - "**/vendor/**"
  - "**/dist/**"
severity: medium
model: gemini-3.5-flash
---

# Error Handling Review

Review error handling for consistency, context preservation, and safe failure modes.

## Checklist

- [ ] Errors are not silently swallowed — catch blocks either handle or re-throw
- [ ] Error context is preserved when wrapping errors (original cause attached)
- [ ] User-facing error messages are actionable — they explain what happened and what to do
- [ ] Internal error details (stack traces, raw DB errors) are not exposed to end users
- [ ] Async operations handle errors explicitly — no unhandled promise rejections
- [ ] Retry logic uses exponential backoff and has a maximum retry limit
- [ ] Circuit breaker or fallback strategy exists for external service calls
- [ ] Error types are specific enough to distinguish recoverable from non-recoverable errors
- [ ] HTTP error responses use semantically correct status codes
- [ ] Cleanup / resource release happens in finally blocks or equivalent, not only in the happy path
- [ ] Errors that should alert on-call are logged at the appropriate level (error/fatal vs warn)

## Severity Guide

| Finding | Severity |
|---------|----------|
| Silent catch block (error swallowed, no log) | high |
| Internal error details exposed to end user | high |
| Unhandled promise rejection / uncaught async error | high |
| Error context lost when re-throwing | medium |
| Retry without backoff or max limit | medium |
| Resource leak in error path | medium |
| Generic catch-all with no error type distinction | low |
| Non-actionable user-facing error message | low |
```

---

## accessibility-review.md

```markdown
---
name: accessibility-review
description: "Reviews UI components for ARIA correctness, keyboard navigation, semantic HTML, and color contrast"
triggers:
  - "**/*.tsx"
  - "**/*.jsx"
  - "**/*.vue"
  - "**/*.svelte"
  - "**/*.html"
  - "**/*.css"
  - "**/*.scss"
skip-when:
  - "**/*.test.*"
  - "**/*.spec.*"
  - "**/node_modules/**"
  - "**/dist/**"
  - "**/build/**"
severity: medium
max-files: 40
model: gemini-3.5-flash
---

# Accessibility Review

Review UI changes for accessibility compliance (WCAG 2.1 AA).

## Checklist

- [ ] Interactive elements (`<button>`, `<a>`, custom components) have accessible names (text content or `aria-label`)
- [ ] Images have meaningful `alt` text; decorative images use `alt=""`
- [ ] Form inputs are associated with labels via `<label for>` or `aria-labelledby`
- [ ] Error messages are associated with their input via `aria-describedby`
- [ ] Focus is managed correctly after dynamic content changes (modals, toasts, route transitions)
- [ ] Keyboard navigation works without a mouse — all interactive elements reachable via Tab
- [ ] Focus indicators are visible — not removed with `outline: none` without a replacement style
- [ ] Color is not the only means of conveying information
- [ ] Text contrast meets WCAG AA ratio (4.5:1 for normal text, 3:1 for large text)
- [ ] ARIA roles, states, and properties are used correctly — not redundant or conflicting
- [ ] Touch targets are at least 44×44px on mobile
- [ ] Dynamic content updates (live regions) use `aria-live` appropriately

## Severity Guide

| Finding | Severity |
|---------|----------|
| Interactive element with no accessible name | high |
| Form input with no label | high |
| Focus trapped or lost after modal/dialog | high |
| Keyboard navigation broken for interactive element | high |
| Contrast ratio below WCAG AA | medium |
| Missing `alt` on informative image | medium |
| ARIA role/state used incorrectly | medium |
| Focus indicator removed without replacement | medium |
| Touch target below 44×44px | low |
| Decorative image missing `alt=""` | low |
```
