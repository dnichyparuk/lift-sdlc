# Commit / PR Pattern Builders

Inline sub-flows for the `commit` (`delegatedTo: 'inline-commit-builder'`) and
`pr` (`delegatedTo: 'inline-pr-builder'`) sections. The parent skill's Step 3
verbose header (purpose / files-modified / consumed-by / config-file /
current-value) has already been printed before either builder below runs.

---

## Commit-pattern builder (`commit` section)

Use AskUserQuestion:

> Do you enforce commit message patterns in this project?

Options:
- **conventional** -- Conventional commits: `type(scope): description`
- **ticket-prefix** -- Ticket prefix: `PROJ-123: description`
- **custom** -- Enter your own regex pattern
- **skip** -- Don't configure commit patterns

On **conventional**: Use AskUserQuestion for sequential refinement:

1. "Require scope?" -- yes / no → Determines `subjectPattern`:
   - yes: `^(feat|fix|refactor|chore|docs|test|ci)(\\(.*\\)): .+$`
   - no: `^(feat|fix|refactor|chore|docs|test|ci)(\\(.*\\))?: .+$`

2. "Allowed types?" -- multi-select (feat, fix, refactor, chore, docs, test, ci; all selected by default) → Updates regex `(type1|type2|...)`

3. "Allowed scopes?" -- free text comma-separated or skip → Adds scope constraint if provided:
   - If scopes provided: `^(types)(\\((scope1|scope2)\\)): .+$`
   - If skip: use pattern without scope constraint

4. "Require body for which types?" -- multi-select (feat, fix, or skip) → Sets `requiresBody` array

5. "Required trailers?" -- free text comma-separated (e.g., `Ticket`, `Reviewed-By`) or skip → Sets `trailers` array

Assemble the `commit` section object. Only include optional fields if the user provided values; omit empty arrays.

On **ticket-prefix**: Use AskUserQuestion for sequential refinement:

1. "Ticket pattern?" -- free text regex (default: `[A-Z]{2,10}-\\d+` for `PROJ-123`) → Sets `ticketPattern`
2. "Combine with conventional type?" -- yes / no:
   - yes: `subjectPattern` becomes `^PROJ-\\d+ (feat|fix|...)(\\(.*\\))?: .+$`
   - no: `subjectPattern` becomes `^PROJ-\\d+: .+$`
3. If combined with types, ask the same type/scope/body/trailer refinement questions as **conventional**.

On **custom**: Use AskUserQuestion:

1. "Enter your regex pattern for commit subject:" → free text → `subjectPattern`
2. "Enter error message if pattern doesn't match:" → free text → `subjectPatternError`

On **skip**: Do not write a commit section.

Store the assembled `commit` config for use in the "Writing config files" step (`SKILL.md`).

---

## PR-pattern builder (`pr` section)

Use AskUserQuestion:

> Do you enforce PR title patterns?

Options:
- **same-as-commit** -- Use the same pattern as commit (only when the commit builder above produced a config)
- **conventional** -- Conventional format
- **ticket-prefix** -- Ticket prefix format
- **custom** -- Enter your own regex
- **skip** -- Don't configure PR title patterns

On **same-as-commit** (if available): Copy the commit config fields to PR config with renamed fields: `subjectPattern` → `titlePattern`, `subjectPatternError` → `titlePatternError`. Keep `allowedTypes`, `allowedScopes`, `requiresBody`, `trailers` as-is.

On **conventional**: Use sequential AskUserQuestion:

1. "Allowed types?" -- multi-select (feat, fix, refactor, chore, docs, test, ci; all selected by default)
2. "Require scope?" -- yes / no
3. "Allowed scopes?" -- free text comma-separated or skip
4. "Required trailers?" -- free text comma-separated or skip

On **ticket-prefix**: Ask same questions as the commit builder (ticket pattern, combine with types, etc.).

On **custom**: Ask:

1. "Enter your regex pattern for PR title:" → free text → `titlePattern`
2. "Enter error message if pattern doesn't match:" → free text → `titlePatternError`

On **skip**: Do not write a pr section.

Store the assembled `pr` config for use in the "Writing config files" step (`SKILL.md`).

---

## See Also

- [`/setup-sdlc`](../SKILL.md) — parent skill; Step 3 dispatch table routes the `commit` and `pr` sections here
