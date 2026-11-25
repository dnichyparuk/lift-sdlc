# PR Label Inference, Custom Templates & Title Patterns

Reference guide for `pr-sdlc` label mode dispatch, custom PR template edge rules, and PR title pattern examples.

## Label Inference (`pr.labels`)

Label assignment is **mode-dispatched** based on `PR_CONTEXT_JSON.prConfig?.labels?.mode`. Each suggested label carries a provenance tag — `(forced)`, `(rule)`, or `(llm)` — shown in Step 5.

### Mode Resolution

- If `PR_CONTEXT_JSON.repoLabels` is empty, skip evaluation and set `inferredLabels = []`. Forced labels still apply (see [Common Post-Processing](#common-post-processing)).
- Otherwise read `mode = PR_CONTEXT_JSON.prConfig?.labels?.mode` (defaults to `"off"` when absent) and dispatch:
  - `"off"` → [Off mode](#off-mode)
  - `"rules"` → [Rules mode](#rules-mode)
  - `"llm"` → [LLM mode](#llm-mode)

The mode dispatch produces `{ label, source }` entries (`source ∈ {"rule", "llm"}`). Forced labels are merged on top with `source = "forced"`.

### Off Mode

Set `inferredLabels = []`. No automatic suggestions are produced. The merged `suggestedLabels` array contains only forced labels (or is empty when none are forced).

### Rules Mode

`scripts/skill/pr.js` already evaluates `prConfig.labels.rules` (pre-validated against `repoLabels`, with unknown labels stripped) against the PR context via `evaluateRule`/`matchRule` and returns deduplicated matches in `PR_CONTEXT_JSON.suggestedLabels` as `{ label, source: "rule" }` (multiple rules targeting the same label OR together into one entry). Set `inferredLabels = PR_CONTEXT_JSON.suggestedLabels` directly — do not run additional signal matching.

### LLM Mode

Run the legacy fuzzy-match heuristic. This branch is **opt-in only** — the user must have explicitly selected `mode = "llm"` during `setup-sdlc --only pr-labels`.

**Signals to match:**

| Signal | Example match |
| ------ | ------------- |
| Branch prefix (`fix/`, `feat/`, `docs/`, `refactor/`, `chore/`) | `bug`/`bugfix`, `enhancement`/`feature`, `documentation`, `refactoring` |
| Commit subject prefixes (conventional commits) | Same as branch prefix |
| Changed file paths (`changedFiles`) | Only `.md` files → `documentation`; only test files → `tests`; CI config files → `ci`/`infrastructure` |
| Diff size (`diffStat`) | Small diff (<50 lines changed) → `small`/`quick-review` |
| Jira ticket type (if available) | Bug ticket → `bug`; Story → `feature`/`enhancement` |

**Matching rules:**

1. Fuzzy-match each signal against `repoLabels[].name` and `repoLabels[].description` (e.g., repo has `type:bug` and branch is `fix/...` → match).
2. Never suggest a label not in `repoLabels` — only exact names from the list are valid.
3. Keep suggestions conservative: 1–4 labels typical; deduplicate so multiple signals matching the same label count as one.

Tag each survivor with `source = "llm"`.

### Common Post-Processing

Regardless of mode:

1. **Update mode:** when `existingPr.labels` is non-empty, drop any inferred entry already present there — they are already applied.
2. **Validity gate (defense-in-depth):** every entry must appear in `repoLabels[].name`. Drop fabricated entries (Step 3's "Label validity" gate is the contract; this keeps `rules` mode exact and catches `llm` hallucinations).
3. **Forced labels:** if `PR_CONTEXT_JSON.forcedLabels` is non-empty, prepend each forced label with `source = "forced"`. Forced labels are always included regardless of mode (including `"off"`) and cannot be removed during interactive edit. Deduplicate by label name; if the same name was inferred and forced, keep only the forced entry.
4. **Output:** `suggestedLabels` — the final ordered, deduplicated list of `{ label, source }` entries (forced first, then rule/llm matches in iteration order). If empty, omit the `Labels:` line in Step 5.

**Auto mode:** When `PR_CONTEXT_JSON.isAuto` is true, apply `suggestedLabels` directly without prompting for approval. Labels are still validated against `repoLabels` and shown in Step 5 output for visibility.

**Forced labels behavior summary:** The CLI `--label <name>` flag and `ship-sdlc`'s `skip-version-check` injection bypass `pr.labels.mode` entirely and apply in all three modes (`off`, `rules`, `llm`).

---

## Custom PR Template Edge Rules

- **Source:** `PR_CONTEXT_JSON.customTemplate` contains the full content of `.sdlc/pr-template.md`, or `null` if absent.
- **Section parsing:** When `customTemplate` is non-null, skip the default 8-section template. Parse every `## Heading` line as a section name and treat the body text beneath it as the fill instruction for that section.
- **Fill parity:** Apply the same fill rules as the default template — real content, `"N/A"`, or `"Not detected"` — never fabricate. All sections defined in the custom template must appear in the output.
- **Critique gate scoping:** When a custom template is active, the `"No file paths"` gate applies only if the custom template defines a section named `Changes Overview`. All universal gates (title length, title pattern, no fabrication, issue accuracy, audience check, documentation sync, label validity, forced label inclusion, link verification) still apply.
- **Installed plugin version skew:** `skill/pr.js` resolves from the installed plugin, which may be older than the project's local copy and omit `customTemplate` support (returning `null` even when `.sdlc/pr-template.md` exists). Always cross-check: if `customTemplate` is `null`, check whether `.sdlc/pr-template.md` exists on disk before defaulting to the 8-section template; if it exists, read and use it directly and warn the user that the installed plugin may be out of date.

---

## PR Title Common Patterns Reference

Teams configure PR title rules in `.sdlc/config.json` via `pr.titlePattern` (regex), `pr.titlePatternError`, `pr.allowedTypes`, and `pr.allowedScopes`.

| Pattern | `titlePattern` | Example title |
| ------- | -------------- | ------------- |
| Conventional Commits | `^(feat\|fix\|refactor\|chore\|docs\|test\|ci)(\([a-z-]+\))?: .+$` | `feat(auth): add SSO` |
| Ticket prefix | `^[A-Z]{2,10}-\d+: .+$` | `PROJ-42: description` |
| Ticket + Conventional | `^[A-Z]{2,10}-\d+ (feat\|fix\|chore): .+$` | `PROJ-42 feat: description` |
| Semantic (squash-merge friendly) | `^(feat\|fix\|breaking): .+$` | `feat: description` |

Each pattern pairs with a matching `allowedTypes` list (and `allowedScopes` where scopes are used) and a human-readable `titlePatternError` shown on validation failure.
