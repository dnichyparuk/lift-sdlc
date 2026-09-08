# Lift-SDLC Skill Optimization Report

This report consolidates findings from 14 background subagents.

*The actionable roadmap derived from this report is available in the [Skill Optimization Plan](./skill-optimization-plan.md).*


---

The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.

<SYSTEM_MESSAGE>
[Message] timestamp=2026-09-01T14:21:05Z sender=aa062994-7d62-4eec-9c3f-58cf558e27ef priority=MESSAGE_PRIORITY_HIGH content=### received-review-sdlc

#### Overview & Metrics
- **Current Size:** 741 lines (~36.4 KB / ~9,000 tokens)
- **Estimated Reduction:** ~280–320 lines (~40–45% token reduction) with zero loss of functionality, rigor, or safety gates.

---

#### Key Optimization Opportunities

1. **Offload Deterministic Clustering & Dedup to a Script (Step 11.6)** (~70–80 lines saved)
   - **Current State:** Lines 439–536 contain ~98 lines instructing the LLM to filter threads by verdict, group into clusters by tuple keys, apply singleton filters for `disagree`, sort/cap clusters, parse the last 100 lines of `.sdlc/learnings/log.md` for duplicate runs, and string-truncate failure texts to 4,096 chars.
   - **Recommendation:** Offload clustering, sorting, deduplication against `log.md`, and text synthesis to a node script (e.g. `scripts/skill/received-review-cluster.js` or extending `received-review.js`). The prompt only needs to instruct the LLM to run the script and dispatch `Skill("harden-sdlc")` for each returned cluster based on the matrix.

2. **Deduplicate Configuration & R18 Bypass Rules** (~50–60 lines saved)
   - **Current State:** The R18 severity bypass rules, local configuration schemas, warning semantics for misplaced `.sdlc/config.json`, and `--auto` fallback rules are explained across 4 separate locations:
     - Configuration section (lines 30–77)
     - Step 10 Consent Gate (lines 369–388)
     - Step 11 Implementation preamble (lines 414–415)
     - Step 12 Reply & Resolve Gate (lines 572–594)
   - **Recommendation:** Since `received-review.js` already validates config and emits pre-resolved booleans/arrays in `flags`, remove the internal config parser explanations and JSON schemas from `SKILL.md`. State the R18 rule once in a concise definition and reference it by name in Steps 10, 11, and 12.

3. **Consolidate Dual Self-Critique Gates (Steps 5/6 & 8/9)** (~40–50 lines saved)
   - **Current State:** Lines 244–273 (Critique/Improve #1) and 310–341 (Critique/Improve #2) contain large markdown tables and boilerplate iteration instructions that repeat criteria already stated in Steps 2–4 and Step 7.
   - **Recommendation:** Replace the 12-row markdown tables and separate "IMPROVE" steps with concise, actionable bullet checklists embedded directly within the Evaluation (Step 4) and Drafting (Step 7) steps or in unified internal critique blocks.

4. **Eliminate Duplicate 4-Cell Matrix in Step 11.6.3** (~25–30 lines saved)
   - **Current State:** The 4-cell auto-mode matrix table in Configuration (lines 89–97) is repeated in full narrative detail in Step 11.6.3 (lines 466–508).
   - **Recommendation:** Keep the authoritative compact table in Step 11.6 and remove the duplicate narrative walkthrough.

5. **Prune Redundancies in Best Practices, DO NOT, and Gotchas** (~45–55 lines saved)
   - **Current State:** Lines 648–718 restate rules defined earlier (forbidden openers, single vs batch implementation, GraphQL vs REST IDs, unclear feedback clarification, auto mode scope).
   - **Recommendation:** Remove overlapping points from Best Practices and DO NOT, retaining only unique edge cases in Gotchas (e.g. handling comments on deleted lines, GraphQL mutation vs REST ID mapping).

6. **Simplify Reply & Resolution Scripting (Step 12)** (~15–20 lines saved)
   - **Current State:** Contains repetitive shell command blocks for posting REST comment replies and GraphQL thread resolution mutations.
   - **Recommendation:** Provide a compact template or helper CLI call to handle the thread reply/resolve batch cleanly.
</SYSTEM_MESSAGE>

---

The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.

<SYSTEM_MESSAGE>
[Message] timestamp=2026-09-01T14:21:05Z sender=60c25ee2-227b-414c-8571-68a1a8772eca priority=MESSAGE_PRIORITY_HIGH content=### github-sdlc

#### 1. Redundant Instructions & Inconsistencies
- **Redundant "When to Use This Skill" Section (Lines 16–23):** Once the skill is loaded, re-listing trigger scenarios that already exist in frontmatter `description` consumes context unnecessarily. Removing this section saves ~8 lines.
- **Step Routing Glitch for Read-Only Ops (Line 59):** States *"If the operation is purely read-only (view, list), skip to Step 2"*, but Step 2 is explicitly titled *"Step 2 — User Approval (Modifying Operations Only)"*. Read-only flows should route directly to Step 3.
- **Duplicate Quality Gates & DO NOT Rules (Lines 49–58, 115–119):** Rules regarding approval gates, non-empty titles, and guessing issue numbers are repeated across Step 1 Quality Gates, Step 2, and the DO NOT block. Merging them into concise step-level constraints eliminates duplication.

#### 2. Verbosity & Boilerplate Compression
- **Step 0 Script Boilerplate Mismatch (Lines 28–37):** Contains a boilerplate banner referencing `<PLUGIN_ROOT>/skills/<skill-name>/scripts/<script-name>.sh` ("Do NOT prepend bash or sh"), but immediately follows with an inlined 8-line bash snippet instead of a script file.
- **Fragmented CLI Examples (Lines 87–110):** Spans 5 separate bash code blocks (24 lines) for `create`, `edit`, `comment`, `view`, and `list`. These can be condensed into a single concise reference block or table, while also adding the currently missing `close` and `reopen` command syntaxes.
- **Verbose Step 2 Formatting Draft (Lines 65–82):** The multi-line ASCII box template and approval looping explanation can be tightened to ~4 lines without losing the required output structure.

#### 3. Deterministic Script Offloading Opportunities
- **Auth & Context Preflight Script (`scripts/prepare.sh`):** Offload `gh auth status` validation, current git repository resolution (`gh repo view --json nameWithOwner`), and argument parsing (`--repo <owner/repo>`) to a lightweight deterministic script (matching the `prepare.sh` pattern used in `commit-sdlc` and `jira-sdlc`).
- **Template Discovery:** Offload inspection of local `.github/ISSUE_TEMPLATE/*.md` or repository issue forms to a deterministic script so the LLM doesn't have to guess or manually glob for issue templates.

#### 4. Estimated Impact
- **Current Prompt Size:** 123 lines (~4.9 KB / ~1,000 tokens)
- **Target Size After Refactoring:** ~55–60 lines (~50% token reduction) with tighter control flow, fixed read-only routing, and complete CLI coverage (including `close`/`reopen`).
</SYSTEM_MESSAGE>

---

The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.

<SYSTEM_MESSAGE>
[Message] timestamp=2026-09-01T14:21:10Z sender=e9979b67-fb1c-43b3-80e3-cba6826a2418 priority=MESSAGE_PRIORITY_HIGH content=### execute-plan-sdlc

#### Current Footprint
- **File size:** 919 lines (~78.9 KB, ~18–20k tokens).
- **Structure:** 10 core steps (0 through 9) + 5 auxiliary reference files in `resources/` + 9 wrapper scripts in `scripts/`.

---

#### Key Opportunities for Size & Token Reduction

1. **Offload Deterministic Logic to JS/Bash Scripts (High Impact: ~180–220 lines saved)**
   - **Per-Wave WIP Commit (Step 5c-quater, lines 509–543):**
     - *Current:* 35 lines detailing 72-char truncation, commit flags, git exit code handling, `git rev-parse HEAD`, and conditional state persistence.
     - *Solution:* Move to `scripts/wave_commit.sh --wave <N> --titles "<titles>"`, which returns `{ committed: bool, sha: string, softSuccess: bool }`.
   - **Resume Detection & Post-Compact Discrimination (Step 0 & 1, lines 83–131):**
     - *Current:* ~50 lines detailing `git worktree list`, hash verification, `committedSha` reachability via `git merge-base --is-ancestor`, and post-compact hook parsing.
     - *Solution:* Move inspection logic into `scripts/check_resume.sh` or `state/execute.js inspect-resume`, returning a concise structured JSON (`{ canResume, wave, reachableSha, mismatch }`).
   - **OpenSpec Task-Flip & Archive Coverage (Step 5d-bis & What's Next, lines 572–596, 865–906):**
     - *Current:* ~65 lines specifying task-flip sets, sibling matching, out-of-scope title filtering, tasks.md status parsing, and diagnostic formatting.
     - *Solution:* Encapsulate inside `scripts/openspec_sync.sh` and `scripts/openspec_archive_check.sh` so the skill prompt simply invokes the script and evaluates a high-level JSON status.
   - **Workspace Setup & Rebase (Step 1, lines 148–196):**
     - *Current:* 48 lines explaining symbolic ref f
<truncated 707 bytes>
ist (lines 794–810):**
     - 17 bullets restate constraints already enforced in Steps 0, 1, 5b, 5c, and 6 (e.g., no >2 retries, no agent SDK worktree isolation, require `model:` param, no state file for ≤3 tasks).
   - **Quality Gates Table (lines 761–778):**
     - 18-row table repeats every step's verification criteria verbatim.

3. **Prune Specification / PR Noise & Explanatory Prose (~50–70 lines saved)**
   - **Issue Numbers & Spec Citation Noise:**
     - Remove numerous inline citations like `(Fixes #392 / R35)`, `(implements R37 — Fixes #414)`, `(R-FACT-SHEET-DISPATCH, #432)`, `(R-todowrite-visibility, issue #427)`. These add token weight without operational utility for the model.
   - **Verbose Rationales:**
     - Trim repetitive explanatory paragraphs (e.g., why subagent TodoWrite does not propagate to parent, why the hook context is layer-agnostic, why wave-runner is locked to flash-low).

4. **Lean Resource References (~40–60 lines saved)**
   - **Manifest JSON Schema (Step 5b, lines 370–385):** Schema is duplicated in both `SKILL.md` and `resources/wave-runner-template.md`. Reference the template resource instead of embedding a 20-line JSON example.
   - **Error Recovery Table (Step 6, lines 637–651):** 15-row table duplicates the dedicated `./resources/recovering-from-failures.md` playbook. A compact 3-line summary with reference to the resource file is sufficient.
   - **Model Escalation Ladder Descriptions (Step 5b, lines 399–400):** Long parenthetical examples of the model ladder (`gemini-3.8-flash-low → ...`) can be stated as a concise 1-line rule.

---

#### Estimated Impact
- **Line Count:** Reduction from **919 lines** to **~450–520 lines** (~45–50% reduction).
- **Token Count:** Reduction from **~19k tokens** to **~9–10k tokens** on initial load.
- **Functionality & Quality:** Zero loss — core algorithmic logic and validations become more reliable by running in deterministic JS/Bash scripts rather than relying on LLM-side git/JSON manipulation.
</SYSTEM_MESSAGE>

---

The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.

<SYSTEM_MESSAGE>
[Message] timestamp=2026-09-01T14:21:12Z sender=92297c6d-b721-4dab-9c3b-de4b2d9ab963 priority=MESSAGE_PRIORITY_HIGH content=### commit-sdlc

**File Size & Current Footprint:** 351 lines, ~22.3 KB (~5,500 tokens).
**Target Potential:** ~100–120 lines (~65–70% token reduction) with zero loss of functionality, safety, or quality.

---

#### 1. Redundant Instructions & Duplicated Content
- **Quality Gates Table (Lines 264–278, ~15 lines):** Duplicates the self-critique rules already defined in `agents/commit-orchestrator.md` (Lines 73–83). SKILL.md explicitly states Steps 3 & 4 are handled by the subagent; the main context only needs to run the deterministic post-gates (subject pattern and link validation).
- **"When to Use This Skill" (Lines 18–24, ~7 lines):** Completely restates the frontmatter `description` and trigger keywords.
- **DO NOT & Best Practices Sections (Lines 279–297, ~20 lines):** Re-iterates constraints already strictly outlined in the workflow steps (e.g., asking user approval, not stashing untracked files, not fabricating changes, respecting `--no-stash` and `--amend`).
- **Duplicate Error/Crash Handling in Step 0 & 0.5 (Lines 49–77):** Verbose descriptions of exit codes 1 vs 2, JSON `errors[]`/`warnings[]`, default branch handling, and branch guards that the `prepare.sh` / `commit.js` script already computes and formats.

#### 2. Overly Verbose Explanations & Historical/Architectural Bleed
- **Architectural Rationale & Issue Annotations:** Removes developer design notes and issue citations (e.g., Issue #202 explanation in Step 2 on why `model:` is the wrong isolation knob, R-requirement cross-references like R1, R2, R12, R13, R14, R35, and defense-in-depth rationale in Step 1c).
- **Step 1c WIP Squash Description (Lines 84–128, ~45 lines):** Contains theoretical explanations of git soft-reset mechanics, idempotency guarantees, and JSON schema definitions. Can be condensed to 5 lines of executable logic.
- **Step 5 Presentation & Gate Details (Lines 156–245, ~90 lines):** 19 lines of ASCII mockups and overly granular multi-level fallback flows (such as verbose `/harden-sdlc` payload construction on subject regex failure) can be simplified into concise operational rules.

#### 3. Opportunities for Deterministic Script Offloading
- **WIP Squash Execution (`squash_wip.sh` or inside `commit.js`):** Offload calculating `FORK_POINT`, `git reset --soft`, and `git add -A` to a helper script or prepare step instead of having the LLM parse `wipSquash` and execute multi-command bash sequences.
- **Commit & Stash Execution Wrapper (`scripts/execute_commit.sh`):** Stash pushing with `--keep-index`, executing `git commit` / `git commit --amend`, and running `git stash pop` (along with hook failure detection) is purely deterministic git plumbing. Offloading this eliminates all risk of LLM deviations during stashing and simplifies Step 5 to a single script execution.
- **OpenSpec Trailer Resolution (into `commit.js`):** Moving the OpenSpec glob and branch matching logic from prompt Step 2 directly into `scripts/skill/commit.js` removes 6 lines of filesystem Globbing from the LLM prompt and provides a pre-computed `openSpecTrailer` field in the manifest.

#### 4. Summary of Key Reductions
| Area | Current Lines | Proposed Lines | Savings |
| :--- | :--- | :--- | :--- |
| **Intro & Redundant Sections** (When to Use, Gates, Best Practices, DO NOT, Gotchas) | ~80 lines | ~10 lines (or removed) | ~70 lines |
| **Step 0 / 0.5 / 1 / 1c** (Preparation, Branch Guard, WIP Squash) | ~90 lines | ~25 lines | ~65 lines |
| **Step 2 / 3 / 4** (Orchestrator dispatch, remove Issue #202 rationale & OpenSpec globbing) | ~30 lines | ~12 lines | ~18 lines |
| **Step 5 / 6 / Error Recovery** (Presentation, gates, git execution) | ~140 lines | ~50 lines | ~90 lines |
| **Total** | **351 lines** | **~100 lines** | **~245–250 lines (~70%)** |
</SYSTEM_MESSAGE>

---

The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.

<SYSTEM_MESSAGE>
[Message] timestamp=2026-09-01T14:21:12Z sender=0057aaa3-8966-4c30-8d96-ad6b523240cb priority=MESSAGE_PRIORITY_HIGH content=### ship-sdlc

**Current Size:** 1,015 lines (~67 KB / ~15–18k tokens).  
**Estimated Reduction:** 50–60% (~400–450 lines remaining) with zero loss in functionality or rigor.

---

### 1. Offload Deterministic Shell & Git Logic to Scripts (~150–180 lines saved)
Several multi-step bash/git workflows are currently micromanaged via prompt instructions rather than single script executions:

* **Rebase & Conflict Flow (Lines 691–742, ~52 lines):** The LLM is instructed to run `git fetch`, `git merge-base --is-ancestor`, `git rebase`, catch errors, run `git rebase --abort`, list conflict files, and branch on merge fallback.  
  * *Solution:* Encapsulate in `scripts/rebase_helper.sh` returning JSON (`{ status: "up_to_date" | "clean" | "conflicts", files: [...] }`).
* **OpenSpec Validation & Archiving (Lines 570–599, ~30 lines):** Validation checks, archive script execution, and `git add openspec/ && git commit` can be handled by a single `scripts/openspec_archive_step.sh` script.
* **Learnings Commit Step (Lines 668–689, ~22 lines):** `git diff --quiet`, staging `log.md`, committing with `chore(...)`, and handling push failures can be unified in `scripts/learnings_commit.sh`.
* **Worktree Detection & Cleanup (Lines 858–877, ~20 lines):** Worktree detection (`git worktree list --porcelain`) and cleanup shell one-liners should be consolidated into a cleanup script.
* **Coupled State & TodoWrite Invocations (Lines 399–437, 482–518, 744–786, ~60 lines):** The LLM must separately invoke `state_wrapper.sh` AND `todos_wrapper.sh` across every lifecycle transition (init, step start, step complete, step fail, resume, cleanup). Merging or automating TodoWrite derivations within the state wrapper eliminates substantial prompt over
<truncated 328 bytes>
n-ancestry, fixes #349)`, `(R41–R49)`, etc.) bloat the prompt without providing actionable runtime guidance to the model.
* **Historical Post-Mortems:** Text explaining past bugs and migrations (e.g. lines 529–530 explaining why R37 was moved pre-execute; line 955 explaining issue #68 where an LLM previously skipped review on docs) should be stripped from runtime instructions.

---

### 3. Deduplicate Rules & Constraints in "DO NOT" / "Gotchas" (~60–80 lines saved)
* **DO NOT (Lines 917–935) & Gotchas (Lines 937–979):** Almost every item in these sections repeats rules already strictly established in Steps 0–6 (e.g., staging gap after execute, sub-skill Agent dispatch isolation, double commit reasoning, worktree git lifecycle, `.sdlc/` gitignore rules, `skipSource` provenance).
* *Solution:* Prune redundant entries; retain only high-leverage negative constraints not already enforced by script contracts.

---

### 4. Streamline Step 1 (CONSUME) and UI Output Templates (~80–100 lines saved)
* **Redundant Display Directives in Step 1 (Lines 87–206):** Step 1c runs `skill/ship.js` (`prepare.sh`), which already returns a consolidated JSON manifest with precomputed flags, context, step statuses, and resume metadata. Sub-steps 1b, 1d, 1e, 1f, and 1g spend over 100 lines micromanaging how the LLM formats each individual JSON section.
* **Excessive ASCII / Mock Terminal Blocks:** Trimming verbose multi-line output templates across Steps 1, 3, 4, 5, 6, and Error Recovery down to concise schema definitions will significantly reduce token footprint.

---

### 5. Consolidate Pipeline Plan & Auto-Mode Tables (~30–40 lines saved)
* **Step 2 Tables (Lines 218–267):** The full pipeline markdown table, `--auto Mode Audit` table, and review verdict table duplicate the exact decisions already computed in `step.invocation`, `step.args`, `step.dispatchMode`, and `flags.reviewThreshold` by `skill/ship.js`. A single compact reference table or delegating directly to `prepare.sh` output is sufficient.
</SYSTEM_MESSAGE>

---

The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.

<SYSTEM_MESSAGE>
[Message] timestamp=2026-09-01T14:21:15Z sender=3d83a2f9-ca3a-43d5-82ce-f320d1fc3b44 priority=MESSAGE_PRIORITY_HIGH content=### pr-sdlc

#### 1. Overview & Reduction Potential
- **Current Size:** 617 lines, 35.3 KB (~8,800–9,500 tokens).
- **Estimated Reduction:** **55%–65% reduction** (~350+ lines / ~5,000+ tokens saved) with zero loss of functionality, quality, or safety gates.

---

#### 2. Logic That Can Be Offloaded to Deterministic Scripts / JS
1. **Rule-Based Label Inference (Step 2b - `rules` mode, ~45 lines):**
   - *Current state:* SKILL.md contains extensive instructions and a matching table for evaluating `branchPrefix`, `commitType`, `pathGlob`, `jiraType`, and `diffSizeUnder` against context.
   - *Recommendation:* Move deterministic rule evaluation into `scripts/skill/pr.js`. `prepare.sh` / `pr.js` should evaluate `prConfig.labels.rules` directly and output resolved `suggestedLabels: [{ label, source: "rule" }]`. The prompt then only needs 4–5 lines to handle the opt-in `llm` fuzzy-match mode or pass through pre-computed labels.
2. **Publish & Execution Pipeline Consolidation (Step 6, ~65 lines):**
   - *Current state:* SKILL.md coordinates title regex checking, body link validation, just-in-time `gh label create`, `gh pr create` / `gh pr edit`, exit code handling, and account-switch retry parsing across multiple fragmented shell snippets.
   - *Recommendation:* Consolidate into a unified `publish_pr.sh` (or extend `create_pr.sh`) that takes title, body, labels, draft, and mode. The script deterministically runs title validation, body link verification (`--validate-body`), JIT label creation, and `gh pr create/edit` with auto-recovery, returning a structured JSON result (`{ success, url, error, recovered }`). This eliminates ~65 lines of prompt orchestration.
3. **Branch Guard Check (Step 0.5, ~12 lines):**
   - Can be enforced directl
<truncated 2162 bytes>
ion examples entirely from SKILL.md (keep in `docs/` or `setup-sdlc`).
2. **Git Issue / Spec Tracking Numbers (~15 occurrences):**
   - References like `(issue #234)`, `(spec E7, issue #184)`, `(issue #198, implements spec R15)`, `(issue #197)`, `(issue #260)`, `(issues #347, #348, #349)`.
   - *Fix:* Strip all changelog/ticket issue tags from runtime instructions.
3. **"When to Use This Skill" Section (Lines 25–32, ~8 lines):**
   - Redundant with the frontmatter description once the skill is already loaded and active.

---

#### 5. Overly Verbose Explanations & Formatting
1. **Context Fields Table (Step 1, lines 144–166, ~23 lines):**
   - Lists 17 fields, most self-evident (`mode`, `baseBranch`, `currentBranch`, `isDraft`).
   - *Fix:* Condense into a 3-line summary highlighting only the non-obvious fields (`customTemplate`, `prConfig`, `forcedLabels`).
2. **Review Output Display Blocks (Step 5, lines 370–405, ~35 lines):**
   - Shows redundant ASCII art / code blocks for create mode vs update mode across various label permutations.
   - *Fix:* Collapse into a single unified format template showing optional/update elements in brackets.
3. **Gotchas & Auxiliary Sections (Lines 562–617, ~55 lines):**
   - "Large diff output" discusses historical shell piping bugs rather than actionable instructions.
   - Version skew and account switch gotchas re-explain earlier mechanisms.
   - *Fix:* Retain only critical runtime edge cases (OpenSpec non-blocking and version skew fallback) in 3–4 concise bullets.

---

#### Summary of Estimated Savings

| Category | Lines Saved | Estimated Token Savings |
| :--- | :--- | :--- |
| Common Patterns Reference (Config examples) | ~50 | ~500 |
| PR Template / Gate / DO NOT Redundancies | ~100 | ~1,500 |
| Script Offloading (Label Rules + Publishing) | ~110 | ~1,600 |
| Multi-Repetitions (Auth recovery, Error reporting) | ~45 | ~650 |
| Context Table, Gotchas, & Section Trimming | ~60 | ~850 |
| **Total** | **~365 lines (~59%)** | **~5,100 tokens (~57%)** |
</SYSTEM_MESSAGE>

---

The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.

<SYSTEM_MESSAGE>
[Message] timestamp=2026-09-01T14:21:18Z sender=1087e694-8f51-4123-bece-b90b159086b0 priority=MESSAGE_PRIORITY_HIGH content=### setup-sdlc

**Current Footprint:** 710 lines (40.7 KB / ~10,000 tokens)  
**Estimated Reduction:** ~380–430 lines (~55–60% reduction down to ~280–320 lines) without loss of functionality.

---

#### 1. Offload Inline Sub-Wizards to Resources (Saves ~190 lines)
* **Delegate Workspace Setup (`Step 3.workspace`, Lines 410–516, ~107 lines):** All other complex content setup modules (`setup-dimensions`, `setup-pr-template`, `setup-guardrails`, `setup-pr-labels`, `setup-openspec`) are modularized under `@resources/setup-*.md`. The 107-line workspace worktree wizard is embedded directly in `SKILL.md`. Moving it to `@resources/setup-workspace.md` (via `delegatedTo: 'setup-workspace'`) cleans up the main dispatch loop and aligns with existing architectural conventions.
* **Delegate / Unify Pattern Builders (`Step 3.commit` & `Step 3.pr`, Lines 326–409, ~84 lines):** These two sections repeat near-identical sequential question trees for commit message regex and PR title regex (`allowedTypes`, `allowedScopes`, `requiresBody`, `trailers`, `ticketPattern`, `custom`). Moving them to `@resources/setup-patterns.md` (or a dedicated builder resource) removes ~80 lines from the core skill.

---

#### 2. Offload Deterministic Logic to Scripts (Saves ~45 lines)
* **Deterministic Project Signal Scan (`Step 3.S`, Lines 534–558, ~25 lines):** Prompt explicitly specifies 14 separate glob patterns (manifests, frameworks, test dirs, CI configs, DB schemas, git logs). This can be executed deterministically in a single helper script (e.g., `scripts/skill/setup-scan.sh` or integrated into `prepare.sh`) returning a structured `scanSignals` JSON, eliminating manual LLM globbing and 25 lines of prompt text.
* **Unified Migration Execution (`Step 2`, L
<truncated 188 bytes>
lti-step script invocation and file-by-file `rm` orchestration in prompt instructions.

---

#### 3. Eliminate Redundancies & Overly Verbose Explanations (Saves ~110 lines)
* **Triple Flag Mapping Redundancy (Lines 21–35, 74–88, 106–107):** Direct-entry flag mappings (`--dimensions` → `--only review-dimensions`, `--pr-template` → `--only pr-template`, etc.) are documented in the Arguments table, repeated in Step 0 "Flag routing", and repeated again in Step 1 "Direct-entry flag bypass". Keep only the Arguments table or a single-line routing note.
* **Duplicate `needsMigration` Evaluation (Lines 176–181 vs Line 97):** `prepare.sh` (`skill/setup.js`) already evaluates and returns `needsMigration: true/false`. The 6-line bulleted breakdown re-explaining the internal code logic in prose is completely unnecessary.
* **Developer/Legacy Documentation (Lines 559–573, 15 lines):** The "Legacy section reference" table (mapping 3a–3h to section IDs) explicitly states it is "for anyone updating tests or docs". Internal maintenance tables should not live in runtime prompt context.
* **Repetitive Gotchas & DO NOTs (Lines 662–689, ~25 lines):** Most Gotchas duplicate instructions from earlier sections (`mode` requirement, developer-local ship config, migration conflicts, `writeProjectConfig` read-merge-write).

---

#### 4. Streamline Verbose Prompt Formatting (Saves ~60 lines)
* **Step 1 Menu Rendering & Parsing (Lines 102–170, 68 lines):** Breaks menu rendering into 4 long "Phases" with multiple ASCII templates and verbose parsing rules (range resolution, unioning locked rows, retry loops). Can be condensed into a concise template and 3 compact parsing bullet points (~20 lines).
* **Step 3.hooks & Init Explanations (Lines 518–533, Lines 600–613):** Condense the 16-line explanation for a single boolean flag (`agentIsolationGuard`) and prune deep internal explanations of `setup-init.js` (managed `.gitignore` sentinels, idempotent block replacement) which the script handles automatically.
</SYSTEM_MESSAGE>

---

The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.

<SYSTEM_MESSAGE>
[Message] timestamp=2026-09-01T14:21:19Z sender=c0213f43-e03a-4d5c-884a-0b3fd3dbc845 priority=MESSAGE_PRIORITY_HIGH content=### error-report-sdlc

#### 1. Current State & Token Footprint
- **`SKILL.md`**: 181 lines (~8.8 KB)
- **`resources/REFERENCE.md`**: 196 lines (~7.2 KB)
- **Problem**: Heavy dual-maintenance and token consumption. `SKILL.md` acts as a thin wrapper that references `REFERENCE.md` for almost every step ("follow Section X verbatim"), yet simultaneously duplicates large portions of the text, historical rationale (Issue #202), and orchestrator contracts.

---

#### 2. Key Optimization Opportunities

##### A. Eliminate Dual-File Redundancy (`SKILL.md` vs. `REFERENCE.md` vs. Agent Spec)
- **Redundant Reference Indirections**: Every step in `SKILL.md` tells the LLM to read `REFERENCE.md`, forcing an extra file read or duplicate prompt ingestion.
- **Orchestrator Duplication**: The 14-row template placeholder mapping in `REFERENCE.md` (Section 4) and the JSON schema explanation in `SKILL.md` (Step 4) are already fully specified in `agents/error-report-orchestrator.md`. They can be completely stripped from `SKILL.md` and `REFERENCE.md`.
- **Recommendation**: Inline the concise procedural steps directly into `SKILL.md` and eliminate or deprecate `REFERENCE.md`, saving ~200 lines across the skill bundle.

##### B. Remove Architectural Rationale & Historical Comments
- **Issue #202 Exposition**: The rationale for using `error-report-orchestrator` instead of skill frontmatter `model:` is explained across 3 separate places (Overview lines 20–24, Step 4 lines 84–90, DO NOT lines 169–171). The prompt only needs the actionable instruction: `Dispatch sdlc:error-report-orchestrator with model: gemini-3.8-flash-low`.
- **Token-Wasting HTML Comments**: Lines 11–14 contain an internal explanation of `disable-model-invocation: true` and `user-invocabl
<truncated 518 bytes>
t spawning issues.

##### D. Offload Multi-Step Bash Logic to Deterministic Scripts
1. **Pre-flight Checks (Section 2)**:
   - *Current*: LLM manually runs `gh auth status` and `git remote get-url origin`.
   - *Optimization*: Move pre-flight validation directly into `error-report-prepare.js` (which already probes git remote and branch). If `gh` is unauthenticated or repo remote is missing, the script can exit with code `3` (pre-flight failed / skip proposal), removing manual shell steps from the prompt.
2. **Issue Creation & Label Handling (Step 6 / Section 6)**:
   - *Current*: LLM executes `gh issue create`, catches missing-label errors, runs `gh label create` fallbacks, retries, and formats output.
   - *Optimization*: Offload to a helper script (e.g. `scripts/skill/error-report-create.js` or `submit_report.sh`) that takes the JSON proposal from the orchestrator, verifies labels, creates the issue, and outputs `{ issueNumber, url }`. Step 6 reduces to a single script invocation.

---

#### 3. Proposed Streamlined Flow & Line Savings

| Section | Current Lines | Proposed Lines | Change / Action |
|---|---|---|---|
| **Frontmatter & Overview** | 25 lines | ~10 lines | Remove comment, remove `model:`, condense intro |
| **Step 1 (Pre-flight & Prepare)** | 37 lines | ~10 lines | Combine classify & prepare script; pre-flight handled in JS |
| **Step 2 (Gate 1 - Offer)** | 14 lines | ~6 lines | Concise `AskUserQuestion` prompt |
| **Step 3 (Dispatch Orchestrator)** | 40 lines | ~12 lines | Remove Issue #202 rationale and redundant JSON schema |
| **Step 4 (Gate 2 - Review)** | 17 lines | ~8 lines | Concise review prompt & edit loop |
| **Step 5 (Create Issue & Report)** | 28 lines | ~8 lines | Single execution command delegating to deterministic script |
| **DO NOT & Cleanup** | 20 lines | ~6 lines | Keep only critical constraints (no direct user invocation, require consent) |
| **Total `SKILL.md`** | **181 lines** | **~60 lines** | **~67% reduction** (and eliminates need to load `REFERENCE.md`) |
</SYSTEM_MESSAGE>

---

The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.

<SYSTEM_MESSAGE>
[Message] timestamp=2026-09-01T14:21:22Z sender=289f5d04-620b-4dce-b141-798a6ba922fc priority=MESSAGE_PRIORITY_HIGH content=### review-sdlc

#### Current State
- **Size**: 255 lines (11,029 bytes)
- **Role**: Thin dispatcher that runs `prepare.sh` (`review.js`), invokes `sdlc:review-orchestrator`, prints the review output verbatim, prompts for PR posting/saving, and runs cleanup.

---

#### Key Opportunities to Reduce Size (Lines & Tokens)

1. **Step 3 & DO NOT Section: Eliminate 4x Repeated Negative Constraints & Spec Citations** (~35 lines)
   - **Redundancy**: Lines 93–96, 109–114, 116–126, and the global DO NOT section (lines 240–247) repeat the exact same instructions 4 times ("Do NOT summarize", "No truncation", "Do NOT collapse to placeholder", "Do NOT synthesize a table", "Do NOT skip the Read step").
   - **Spec Citations**: References to `R13`, `quality gate G5`, `G4` add cognitive/token overhead without execution value.
   - **Recommendation**: Replace with a concise 3-line instruction:
     ```markdown
     1. Display orchestrator summary.
     2. Parse `comment_file`, `pr`, `verdict`, `scope`, `branch`.
     3. Read `comment_file` and output full contents verbatim (no summarization or truncation).
     ```

2. **Step 1: Offload Dry-Run Formatting to `review.js`** (~25 lines)
   - **Redundancy & Conflict**: Step 0 says "Do NOT read the manifest file contents into main context", but Step 1 gives a 20-line markdown table template and tells the LLM to parse `manifest.plan_critique` using JS expressions.
   - **Legacy Bug**: Mentions a `trap` from Step 1 that no longer exists in inline bash.
   - **Recommendation**: Offload table formatting directly into `scripts/skill/review.js` (or a helper script) when `--dry-run` is passed, printing the review plan directly. The prompt only needs 2 lines: "If `--dry-run` was passed, display the output from Step 0 and stop."

3. **Step 4: Consolidate Duplicated Posting & Save Branches** (~40 lines)
   - **Duplication**: The `save` command (`BRANCH_SAFE=... mkdir -p .sdlc/reviews && cp ...`) and prompt options are duplicated 3 times across `PR exists`, `No PR (branch scope)`, and `No PR (local scope)`.
   - **Verbose Contracts**: Internal script contracts (`Contract (Input/Output)...`) and commentary (`SDLC_LINKS_OFFLINE=1 skips network...`, `issue #198`) are prompt bloat.
   - **Inconsistency**: Step 4 fails to pass `--file "$comment_file"` to `validate_links.sh` in the example invocation.
   - **Recommendation**: Unify the prompt options into a single decision matrix, or offload the link validation + posting / saving to a script (e.g. `scripts/post_comment.sh` and `scripts/save_review.sh`).

4. **Step 2: Streamline Orchestrator Dispatch & Internals** (~15 lines)
   - **Verbose Explanations**: Lines 76–80 describe orchestrator internal behaviors already declared in `agents/review-orchestrator.md`.
   - **Recommendation**: Retain only the dispatch parameters, expected outputs, and retry logic.

5. **Frontmatter & See Also** (~10 lines)
   - Compress `description` (avoid duplicating argument descriptions and extensive trigger lists).
   - Prune redundant DO NOT / See Also items already covered in step instructions.

---

#### Logic Offloadable to Scripts
- **Dry-run plan rendering**: Handle in `scripts/skill/review.js` or `scripts/prepare.sh`.
- **Review saving / posting**: Encapsulate `validate_links.sh` + `gh api` / `.sdlc/reviews` file copy into deterministic helper scripts so the LLM doesn't manage bash string substitutions and error branches.

---

#### Estimated Impact
- **Line Count**: ~255 lines $\rightarrow$ ~90–105 lines (**~60% reduction**)
- **Tokens**: Reduction of ~800–1,000 tokens per invocation while maintaining identical functionality and guardrails.
</SYSTEM_MESSAGE>

---

The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.

<SYSTEM_MESSAGE>
[Message] timestamp=2026-09-01T14:21:26Z sender=46e12883-3d16-4886-b8bc-bf863808c2a4 priority=MESSAGE_PRIORITY_HIGH content=### version-sdlc

#### 1. Overview & Baseline
- **Current Prompt Size**: 533 lines (~34.4 KB, ~8,500 tokens)
- **Model**: `gemini-3.8-flash-low`
- **Core Role**: Release orchestration (bump calculation, CHANGELOG generation, file editing, tagging, pushing, CI verification, and retagging).
- **Potential Reduction**: **~320 lines (~60% token reduction)** down to **~210 lines** without losing any functionality, safety gates, or release quality.

---

#### 2. Key Optimization Opportunities

##### A. Structural & Resource Offloading
1. **Extract Branch D (Retag Workflow) to Resource File (-85 lines)**
   - *Current state*: Branch A (`init`) and Branch C (`changelog-update`) are offloaded to `./resources/init-workflow.md` and `./resources/changelog-workflow.md`. However, Branch D (`retag`, lines 336–424) is fully written out inline with 4 detailed sub-steps (D1–D4).
   - *Opportunity*: Move Branch D to `./resources/retag-workflow.md` (read dynamically only when `flow === 'retag'`), matching the pattern of Branches A and C.

2. **Remove Educational & Background Documentation (-35 lines)**
   - *Current state*: Lines 489–510 contain *“Changelog Accuracy and Limitations”* and *“Mitigation: 4-Layer Defense”*, explaining squash-merge history limitations and human review philosophies.
   - *Opportunity*: Move this conceptual/human documentation to `docs/` or a reference guide. The runtime LLM prompt only needs operational directives.

3. **Deduplicate Repeated “Gotchas”, “Best Practices”, and “DO NOT” (-45 lines)**
   - *Current state*: Lines 438–489 repeat rules already enforced in the workflow steps:
     - Squash-merge tag orphan explanation is repeated **3 separate times** (lines 339–341, 480–482, 495–502).
 
<truncated 1905 bytes>
atic rollback/verification, reducing LLM token consumption and eliminating multi-turn bash tool loops.

7. **Use Deterministic Version-File Writer (`lib/version.js` `writeVersion`) (-20 lines)**
   - *Current state*: Step 8.1 provides extensive instructions and warnings to the LLM on using Edit vs Write tools, formatting TOML/JSON/YAML, and verifying line diffs.
   - *Observation*: `scripts/lib/version.js` already has an battle-tested `writeVersion(filePath, fileType, oldVersion, newVersion)` function handling exact formatting and indentation for all supported formats.
   - *Opportunity*: Expose a `--write-version` or script action in `version.js` to deterministically update the file on disk.

8. **Streamline Link Validator Sub-step & Developer Commentary (-20 lines)**
   - *Current state*: Step 8.3b (lines 276–292) includes verbose input/output contract tables for `validate_links.sh`. Lines 249–250 contain a developer design rationale note (*"Why config.changelog, not flags.changelog, here? ... Do not 'fix' this divergence"*).
   - *Opportunity*: Condense `validate_links.sh` execution to 3 lines and remove design-spec rationale.

---

#### 3. Summary of Estimated Line & Token Savings

| Optimization Area | Current Lines | Target Lines | Line Savings | Token Savings (Est.) |
|---|---|---|---|---|
| **Offload Branch D (`retag-workflow.md`)** | ~89 | ~4 | -85 lines | ~1,400 tokens |
| **Remove Background Docs & 4-Layer Defense** | ~35 | 0 | -35 lines | ~800 tokens |
| **Deduplicate Gotchas, DO NOT & Best Practices** | ~60 | ~15 | -45 lines | ~1,100 tokens |
| **Trim Redundant Bump Precedence Rules** | ~35 | ~5 | -30 lines | ~700 tokens |
| **Offload Atomic Retag & Version Write to Scripts** | ~45 | ~15 | -30 lines | ~600 tokens |
| **Streamline Contracts, Spec Rationale & Frontmatter** | ~40 | ~15 | -25 lines | ~500 tokens |
| **Cleanup Duplicate Headings & JSON Field Tables** | ~35 | ~15 | -20 lines | ~400 tokens |
| **Total** | **533** | **~210** | **-323 lines (-60%)** | **~5,500 tokens** |
</SYSTEM_MESSAGE>

---

The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.

<SYSTEM_MESSAGE>
[Message] timestamp=2026-09-01T14:21:26Z sender=8511e44e-a6d7-42b6-aec9-c4448b5e93af priority=MESSAGE_PRIORITY_HIGH content=### jira-sdlc

#### 1. Overview & Current Metrics
- **Current Size:** 623 lines (~41.0 KB, ~10,000 tokens).
- **Core Role:** Manages Jira issue lifecycle with metadata caching, ADF/Markdown formatting, payload critique/approval gates, and MCP telemetry.
- **Key Finding:** Substantial token and line bloat is caused by multi-section repetition (Quality Gates vs. DO vs. DO NOT vs. Gotchas), inline cache schemas/mapping tables duplicated in `resources/REFERENCE.md`, repetitive MCP failure telemetry blocks, and deterministic script logic explained in natural language.

---

#### 2. Key Opportunities for Prompt Reduction

##### A. Deduplicate Rule Lists (Quality Gates, DO, DO NOT, Gotchas)
- **Problem:** Rules are stated 3–5 times across the document (e.g., ADF comment format, cached `cloudId` invariants, Acceptance Criteria checklist syntax, template resolution, and approval token rules appear in Quality Gates [L516–535], DO [L538–546], DO NOT [L547–570], Gotchas [L571–600], and `resources/operations-reference.md`).
- **Solution:** Merge DO / DO NOT / Quality Gates into a single compact **Operational Rules & Quality Gates** table or checklist, and trim Gotchas to only non-obvious API edge cases not already covered in `resources/REFERENCE.md`.
- **Estimated Savings:** ~50–60 lines.

##### B. Consolidate MCP Failure Telemetry & Gated Dispatch Boilerplate
- **Problem:** The same 10–20 line pattern (`mcp_failure_*.sh` script invocation + `mcp-failure.js --analyze` + proposal parsing + user confirmation + `error-report-sdlc` dispatch) is repeated verbatim in 5 separate places:
  1. Step 2.7 Link verification (L384–409)
  2. Step 3 Hook block (L418–431)
  3. Step 3 CloudId authorization error (L432–452)
  4. Step 3 / Error Re
<truncated 1087 bytes>
bles
- **Problem:** Step 1 Phase 4 (L197–207) and Phase 6 (L271–287) inline a full field type mapping table and a 20-line JSON cache schema that already exist identically in `resources/REFERENCE.md` (Section 0 & Section 2).
- **Solution:** Keep Phase 1–6 instructions strictly focused on the MCP tool invocation steps and point to `resources/REFERENCE.md` for schema structures and type mappings.
- **Estimated Savings:** ~35–45 lines.

##### E. Remove Duplicate Error Recovery Table & Redundant Triggers
- **Problem:**
  - The Error Recovery table (L483–497) duplicates Section 5 of `resources/REFERENCE.md`.
  - The `description` frontmatter (L3), "When to Use This Skill" (L17–28), and Step 2 classification table (L309–321) repeat the same trigger operations three times.
  - "How This Skill Works" (L29–48) contains verbose narrative explanations of caching, tenant handling, and template rules that are re-explained in Steps 0, 1, and 2.5.
- **Solution:** Trim "When to Use" to a brief summary, reference `resources/REFERENCE.md` for error recovery actions, and condense narrative explanations into imperative rules.
- **Estimated Savings:** ~30–40 lines.

---

#### 3. Summary of Estimated Impact
| Optimization Area | Current Lines | Target Lines | Line Reduction | Token Savings (est.) |
|---|---|---|---|---|
| Rule Lists (Gates/DO/DO NOT/Gotchas) | 85 | 30 | ~55 lines | ~1,200 tokens |
| MCP Failure & Gated Dispatch Blocks | 85 | 20 | ~65 lines | ~1,400 tokens |
| `--init-templates` Logic Offloading | 38 | 6 | ~32 lines | ~700 tokens |
| Inline Cache Schema & Type Mappings | 45 | 10 | ~35 lines | ~800 tokens |
| Error Recovery & Intro/Trigger Deduplication | 60 | 25 | ~35 lines | ~750 tokens |
| **Total** | **623** | **~380–400** | **~220–240 lines (~36–40% reduction)** | **~4,800–5,000 tokens** |

No capabilities, quality gates (R17–R28), or error protections are lost; all procedural specifications are preserved or delegated to existing resource files and deterministic scripts.
</SYSTEM_MESSAGE>

---

The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.

<SYSTEM_MESSAGE>
[Message] timestamp=2026-09-01T14:21:29Z sender=d3beadff-9eb2-44df-b476-6c17cd361e30 priority=MESSAGE_PRIORITY_HIGH content=### plan-sdlc

#### 1. Executive Summary & Impact
`skills/plan-sdlc/SKILL.md` is currently **503 lines (38 KB)**. Approximately **40–50% of the prompt size (lines and tokens)** can be reduced without losing any planning capability, quality gates, or guardrail compliance by eliminating internal requirement lore, removing duplicate OpenSpec detection logic, consolidating script markers, and pruning repetitive parallel-call and contract boilerplates.

---

#### 2. Key Optimization Opportunities

##### A. Eliminate Internal Architecture Lore, Hook Explanations, and Requirement Tags (~60–80 lines)
- **Remove metadata & issue references**: The prompt is heavily annotated with internal implementation tags like `(implements R20, issue #285; consumed by hooks/stop-plan-integrity.js per R21)`, `(R35, Fixes #418)`, `(implements R22 single-touchpoint handoff)`, `(R34, KD6 placement — Fixes #417)`, `P14/P15/P16/P17`, etc. (over 25 instances). The LLM does not need internal ticket history or requirement traceability numbers.
- **Delete internal hook lifecycle explanations**: Lines 141–145 detail the 3-phase state-file lifecycle (`Prune-on-write`, `Consume-then-delete`, `GC orphan sweep`) specifically prefaced with *"callers do NOT need to implement directly — they are enforced inside skill/plan.js and hooks/stop-plan-integrity.js"*. This is background engine documentation that wastes context tokens.

##### B. Deduplicate Step 0 OpenSpec Pre-computation (~40–50 lines)
- **Current redundancy**: Step 0 runs 34 lines of manual bash/glob instructions (lines 29–62) to discover `openspec/config.yaml`, classify functional vs non-functional changes, inspect branch names, and read proposal files. Immediately afterward (line 90), it runs `prepar
<truncated 2029 bytes>
idate Repetitive Parallel Tool Call Directives (~15–20 lines)
- The instruction *"All Glob/Grep/Read calls MUST be issued in a SINGLE message as parallel tool calls"* is repeated almost verbatim in:
  - Context Optimization Constraints (line 19)
  - Step 1 Lightweight Scope (line 198)
  - Step 1 Error Fallback (line 203)
  - Step 1 Codebase Exploration (line 218)
  - Step 3 Fan-Out Dispatch (lines 255, 257)
  - Step 5 Reviewer Dispatch (line 346)
- Keeping this as a single unified rule under section 1 (Context Optimization Constraints) eliminates 5 duplicate reminder blocks.

##### F. Prune "Gotchas", "DO NOT", and Verbose Narrative Prose (~30–40 lines)
- **"Gotchas" section (lines 452–468)**: Explains concepts that are already enforced by orchestrator agents and templates (e.g., vague task descriptions, complexity classification drift, implicit dependencies, over/under decomposition).
- **"DO NOT" section (lines 438–451)**: Several items duplicate rules from the main steps (e.g. prompt at Step 0/Step 4, TodoWrite for lightweight plans, review loop skipping). Merge into a tight list of high-impact negative constraints.

---

#### 3. Summary of Estimated Reductions

| Area | Current Lines (Approx.) | Potential Savings | Action |
|---|---|---|---|
| Issue/PR/Req tags & hook lifecycle lore | ~80 lines | ~65 lines (80%) | Remove internal engine lore and ticket metadata |
| Step 0 OpenSpec detection logic | ~65 lines | ~45 lines (70%) | Offload completely to `prepare.sh` JSON output |
| Script contract boilerplate & duplicate markers | ~45 lines | ~30 lines (65%) | Consolidate marker calls, remove repeated contract text |
| Step 3 & Step 5 Fan-Out / Merge verbosity | ~110 lines | ~50 lines (45%) | Rely on subagent templates and concise merge rules |
| Parallelism rule repetitions | ~20 lines | ~15 lines (75%) | Define once in section 1 |
| Gotchas & DO NOT narrative | ~45 lines | ~25 lines (55%) | Condense into concise rules |
| **Total** | **~503 lines** | **~230 lines (~45% reduction)** | |
</SYSTEM_MESSAGE>

---

The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.

<SYSTEM_MESSAGE>
[Message] timestamp=2026-09-01T14:21:38Z sender=4a64ac76-a32a-4ad3-a31a-fb29ab698f8a priority=MESSAGE_PRIORITY_HIGH content=### harden-sdlc

#### 1. Current State & Metrics
* **File size**: 368 lines / ~17.7 KB (~4,400 tokens).
* **Current Model**: `gemini-3.8-flash-high`.
* **Primary Role**: Orchestrates pipeline failure hardening by preparing context, running `harden-orchestrator`, presenting proposals to user, validating/applying edits, and appending learning logs.

---

#### 2. Identified Redundancies & Verbosity

1. **R-Iteration-Write Contract Over-Duplication (~30 lines)**:
   * The rule to *"re-read target file before acting, write immediately before advancing to the next proposal, and hold no cross-proposal state"* is repeated across 4 separate locations: Step 5 intro (lines 159–164), Step 5a (line 188), Step 5b (lines 225–226), and DO NOT (lines 336–338).
2. **Duplicated `mcp-failure` / Pre-set Plugin-Defect Logic (~15 lines)**:
   * The exact condition and routing when `--from-issue` carries `mcp-failure` (skipping Step 3 orchestrator and jumping to Step 6) is explained in full in Step 0 (lines 41–46) and repeated verbatim in Step 2 (lines 92–96).
3. **Specification Lore & Architectural History (~25 lines)**:
   * Spec requirement citations (`R1–R19`, `C5–C10`, `R-iteration-write`, `Fixes #417`, `issue #288`, `issue #387`) and internal design rationales (e.g., lines 311–317 explaining *why* `plan-sdlc`'s G17 gate greps `log.md`, lines 356–357 explaining why `ship-sdlc` is not a caller) provide background context for plugin developers rather than actionable LLM runtime instructions.
4. **Repeated Manifest Context Prohibitions & Invariants (~15 lines)**:
   * Prohibitions against reading full manifest contents into main context and reminders that v1 is strengthen-only are repeated in Description, Step 1, Step 2, Step 5b, Step 5c,
<truncated 730 bytes>
nts directly to `prepare.sh`.
2. **Output Failure Summary Preview Directly from `prepare.sh`**:
   * *Current state*: Step 2 (24 lines) tells the LLM to selectively read partial fields (`failure.*`, `classification_hint`) from `MANIFEST_FILE` without loading the full manifest.
   * *Opportunity*: `prepare.sh` / `harden-prepare.js` can print the 5-line formatted preview directly to stdout, eliminating LLM JSON partial-parsing instructions.
3. **Deterministic Proposal Application & Validation (proposed: `harden-apply.js`)**:
   * *Current state*: Step 5a/5b (lines 187–240) requires the LLM to manually construct merged JSON in memory for config guardrails, patch review dimensions, run validator bash scripts, and handle `consolidate` ID lookups/merges.
   * *Discrepancy*: `validate_guardrails.sh` validates `.sdlc/config.json` on disk, creating a mismatch with the instruction to construct prospective JSON in memory before writing.
   * *Opportunity*: A single CLI helper (e.g., `node scripts/skill/harden-apply.js --target <file> --proposal '<json>'`) can deterministically validate, merge (`add`/`strengthen`/`consolidate`), and write disk changes atomically, returning clear pass/fail status to the agent.
4. **Deterministic Learning Capture Logging**:
   * *Current state*: Step 7 (38 lines) specifies complex multi-line text templating, directory creation, conditional inclusion of the `Dimensions:` line, and `AmbiguousOffer` enum mapping.
   * *Opportunity*: A lightweight command (`node scripts/skill/harden-log.js ...` or incorporating into `harden-apply.js`) eliminates formatting errors and cuts ~30 prompt lines.

---

#### 4. Summary & Projected Impact

| Metric | Current | Optimized Target | Reduction |
|---|---|---|---|
| **Lines** | 368 lines | ~120–140 lines | **~62–67%** |
| **Size / Tokens** | 17.7 KB (~4.4k tokens) | ~5.8–6.5 KB (~1.5k tokens) | **~65%** |
| **Execution Quality** | LLM manual JSON patching & schema checks | Deterministic script validation & atomic writes | **Higher reliability** |
</SYSTEM_MESSAGE>

---

The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.

<SYSTEM_MESSAGE>
[Message] timestamp=2026-09-01T14:21:44Z sender=37e697b2-ff42-47c3-a278-03cca3de5e99 priority=MESSAGE_PRIORITY_HIGH content=### verify-pipeline-sdlc

#### 1. Current State & Metrics
- **Current Size**: 87 lines (~4.5 KB / ~800 tokens).
- **Core Role**: Ingest CI failure logs (inline, file, or via GitHub PR checks), classify the failure type via deterministic heuristics, and either apply a minimal fix (`--auto` on actionable types) or output a proposal JSON.

---

#### 2. Key Optimization Opportunities

##### A. Offload Multi-Step Orchestration to a Single Prepare Script
- **Current Prompt Flow**: The LLM manually parses `--pr`/`--logs`, validates missing args (E1), chooses whether to read a local file or call `fetch_logs.sh`, checks `gh` authentication (E2), and pipes log text to `classify_logs.sh`.
- **Script Offloading**: Consolidate argument resolution, log extraction (file vs. PR check run), `gh` auth validation, and log classification into a single deterministic script (`scripts/prepare.sh` or `scripts/skill/verify-pipeline.js`).
- **Token Savings**: Eliminates ~25 lines of multi-step branching logic, pipe commands, and error-abort handling from the prompt.

##### B. Consolidate Verbose Routing & Repeated `--auto` Rules
- **Redundancy**: Lines 53–59 explain the `--auto` flag behavior three separate times across categories, in addition to mentioning it in the intro and argument hints.
- **Optimization**: Replace paragraphs with a concise 4-row decision matrix:
  | Category | `--auto` Action | Non-`--auto` Action |
  | :--- | :--- | :--- |
  | `lint`, `test-failure`, `type-error` | Apply minimal fix via `Edit` tool | Emit `proposal` |
  | `build-error`, `dependency`, `infra`, `unknown` | Emit `proposal` | Emit `proposal` |

##### C. Strip Spec/Test Traceability Tags
- **Redundant Noise**: The prompt is sprinkled with internal requirement/error markers
<truncated 826 bytes>
nes.

---

#### 3. Proposed Streamlined Structure (~38 lines, ~55% reduction)

```markdown
---
name: verify-pipeline-sdlc
description: "Analyze failed CI runs on a PR; apply minimal fixes or emit a proposal. Triggers on: analyze CI failure, fix failing checks, post-PR CI verification, verify-pipeline."
user-invocable: true
argument-hint: "[--pr <number>] [--logs <path-or-string>] [--auto]"
model: gemini-3.8-flash-medium
---

# Verify Pipeline (SDLC)

Announce: "I'm using verify-pipeline-sdlc (sdlc v{sdlc_version})." (omit version if absent).

## Step 1: Prepare & Classify
Run the prepare scripts to resolve logs and classify the failure:
```shell
node "<PLUGIN_ROOT>/scripts/util/fetch-logs.js" --pr-number <N>
node "<PLUGIN_ROOT>/scripts/skill/verify-pipeline-sdlc-classify.js" --logs-file "$LOGS_FILE"
```
Output schema: `{"status":"ok","category":"<cat>","logs":"<text>","actionable":true|false}` or `{"status":"abort","reason":"<msg>"}`.
If status is `abort`, output the JSON verbatim and exit.

## Step 2: Fix or Propose
- **Actionable (`lint`, `test-failure`, `type-error`) + `--auto`**: Apply minimal fix using the `Edit` tool. Do NOT refactor or add abstractions.
- **Non-actionable (`build-error`, `dependency`, `infra`, `unknown`) OR no `--auto`**: Do not edit files; formulate a diagnosis and proposal.
- **Prohibitions**: Never run `git commit`, `git push`, or modify files outside project root.

## Step 3: Verdict
Emit exactly one single-line JSON to stdout (all progress/logs go to stderr):
```json
{"status":"fix-applied","filesChanged":["path/a"],"summary":"<summary>"}
{"status":"proposal","summary":"<diagnosis>","suggestedPatch":"<diff-or-prose>"}
{"status":"abort","reason":"<reason>"}
```
```

---

#### 4. Summary of Impact
- **Lines**: Reduced from 87 to ~38 lines (**~56% reduction**).
- **Tokens**: Reduced from ~800 tokens to ~350 tokens (**~55% reduction**).
- **Quality & Robustness**: Enhanced by offloading shell piping, arg edge cases, and `gh` auth checks into a deterministic helper script while keeping LLM focus squarely on diagnosing logs and applying targeted code edits.
</SYSTEM_MESSAGE>

---



