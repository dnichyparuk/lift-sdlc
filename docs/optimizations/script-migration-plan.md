# Legacy Script Migration Plan (Bash to Node.js)

## 1. Objective
*This modernization plan was spun out of the findings detailed in the [Skill Optimization Report](./skill-optimization-report.md).*

Migrate all existing `.sh` Bash wrapper scripts across the `lift-sdlc` plugin to pure Node.js (`.js`).

## 2. Rationale & Anti-Patterns
- **Cross-Platform Compatibility**: Bash scripts (`.sh`) using Unix utilities (`sed`, `/dev/null`) fail natively on Windows (PowerShell/CMD). Node.js abstracts OS pathing and execution environments, ensuring 100% native compatibility.
- **Performance (The "node -e" Hack)**: Many existing Bash scripts (e.g., `workspace_setup.sh`) rely on inline `node -e` hacks to parse configuration, spawning multiple Node subprocesses sequentially. Rewriting in Node allows direct `require()` imports, eliminating massive spawn overhead.
- **Native JSON Handling**: Node natively parses and validates JSON, replacing brittle `jq` or string-slicing hacks used to communicate with LLM payloads.

## 3. Implementation Phases

### Phase 1: Core Orchestrator Migration
*Target: Convert heavy orchestrator wrappers.*
- [x] Migrate `skills/ship-sdlc/scripts/*.sh` (e.g., `prepare.sh`, `workspace_setup.sh`, `todos_wrapper.sh`).
- [x] Migrate `skills/execute-plan-sdlc/scripts/*.sh`.

### Phase 2: Setup & Configuration Migration
*Target: Convert interactive and configuration scripts.*
- [x] Migrate `skills/setup-sdlc/scripts/*.sh`.
- [x] Migrate `skills/version-sdlc/scripts/*.sh`.

### Phase 3: Utility Skills Migration
*Target: Convert daily developer workflow scripts.*
- [x] Migrate `skills/commit-sdlc/scripts/*.sh`.
- [x] Migrate `skills/review-sdlc/scripts/*.sh`.
- [x] Migrate `skills/verify-pipeline-sdlc/scripts/*.sh`.

### Phase 4: Prompt Updates & Test Coverage
- [x] **Direct Invocation**: Update all `SKILL.md` files to invoke `node <script>.js` instead of the legacy bash wrappers, eliminating the Bash middleman entirely.
- [ ] **Test Mandate**: Ensure all migrated Node.js scripts are fully backed by unit tests to guarantee reliable git execution and JSON validation across OS boundaries.

