# Appendix: Self-Learning Architecture Decision Records (ADR)

This document catalogs the critical architectural decisions, rejected paradigms, and security pivots established during the 15-cycle adversarial design phase of the `learn-sdlc` subsystem. 

Future maintainers **MUST NOT** revert these decisions without reading the corresponding failure impacts.

---

## 1. Storage Layer: The Changeset Paradigm
**Context:** How should distributed agents store pending learnings without breaking CI/CD?
* ❌ **Rejected (Single File / JSONL):** Appending to a single `log.jsonl` or `log.md` file guarantees unresolvable 3-way Git merge conflicts across parallel feature branches.
* ❌ **Rejected (Local SQLite DB):** Fails cross-platform filesystem locks (WSL2/9p, CIFS) and breaks the zero-dependency rule (Node 20 lacks built-in `node:sqlite`).
* ✅ **Adopted:** **Changeset Markdown Files.** Agents create independent, uniquely slugged `.md` files in `.sdlc/learnings/pending/`. Git easily tracks independent files across branches without merge conflicts.

## 2. Negative Cache: Semantic Signatures
**Context:** How does the system remember that a human maintainer rejected a proposed rule, preventing infinite re-suggestion?
* ❌ **Rejected (Cryptographic SHA-256 Hashes):** Natural language processing suffers from the "Hash Avalanche" effect. If an LLM changes one word in a previously rejected rule, the hash changes, bypassing the negative cache entirely.
* ✅ **Adopted:** **Semantic Signatures.** The LLM assigns a descriptive kebab-case string (e.g., `auth-layer-raw-sql`) to the invariant. Maintainers reject the *signature*, which is stored in `rejected_guardrails` in `config.json`.

## 3. Workflow Trigger: The Agentic Two-Phase Split
**Context:** When and how are pending learnings assimilated into global configurations?
* ❌ **Rejected (Inline `ship-sdlc` hook):** Running assimilation during standard feature shipping violates the `pre-tool-git-guard.js` safety hooks (blocking branch switches and force pushes mid-flight).
* ❌ **Rejected (Monolithic Synchronous Node Script):** A Node script cannot synchronously halt and yield to an LLM orchestrator agent. The script would finish executing before the AI had time to read the files and synthesize rules.
* ✅ **Adopted:** **Decoupled Prepare/Apply Phases.** `learn-prepare.js` creates a dynamic branch (`assimilation-<timestamp>`) and yields. The LLM Agent modifies configurations via its standard tools. `learn-apply.js` validates and pushes the final result.

## 4. Local Data Protection: Safe Git Rollbacks
**Context:** How should the system revert its state if validation (Fail-Open checks, Dimension logic) fails during the Apply phase?
* ❌ **Rejected (`git reset --hard HEAD` / `origin/main`):** If a human lead ran the assimilation script locally while active on a feature branch (e.g., `feat/auth`), a failure would execute a hard reset on their current branch. This catastrophic bug silently wipes out all uncommitted developer work.
* ✅ **Adopted:** **Workspace Snapshotting.** The script caches the user's active branch (`initialBranch`), explicitly cleans only the `.sdlc` directory, and immediately checks out the `initialBranch` in the `catch` block, ensuring total isolation from the developer's worktree.

## 5. Security: Fail-Open Regression Checks
**Context:** How do we ensure the LLM doesn't accidentally delete existing security guardrails when synthesizing new ones?
* ❌ **Rejected (Array Length Checks):** `if (postCount < preCount) throw Error`. An LLM could silently delete 5 critical `execute` rules and hallucinate 5 meaningless `plan` rules. The length check passes, resulting in critical data loss (Fail-Open vulnerability).
* ✅ **Adopted:** **Per-Section Set Containment.** The system extracts a `Set` of all rule IDs per-section before synthesis. After synthesis, it iterates over the original Set, proving mathematically that every pre-existing rule ID survived the LLM mutation.

## 6. Resolving Deadlocks: Manual Rejection (`learn-reject.js`)
**Context:** How does a maintainer reject an assimilation Pull Request?
* ❌ **Rejected (Automated GitHub Action Cron):** Scanning closed PRs to extract rejections causes infinite loops. GitHub forbids reopening PRs from the same branch name, and "stateless" crons spam duplicate PRs every hour if the root files aren't deleted.
* ✅ **Adopted:** **Explicit CLI Rejection.** Maintainers run `node scripts/skill/learn-reject.js <PR_NUMBER>`. The script parses the PR body, extracts the semantic signatures, updates the negative cache (`config.json`), deletes the pending files, commits the rejection, and crucially executes `gh pr close` to release the global concurrency lock.
