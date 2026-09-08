---
applyTo: "scripts/**/*.js,skills/**/*.js,hooks/**/*.js"
---
# code-quality-review — Review Instructions

Reviews Node.js CLI scripts for clarity, error handling, and adherence to this repo's parseArgs/writeOutput conventions

Default severity: medium

## Checklist

- Function and variable names are clear and intention-revealing
- Functions do one thing (single responsibility)
- Error cases are handled explicitly — no silent failures
- CLI argument parsing follows the established manual `parseArgs(argv)` pattern (a `for` loop over `argv.slice(2)` with if/else-if string comparisons) rather than introducing a new CLI-parsing library or ad-hoc regex parsing
- Output follows `scripts/lib/output.js`'s `writeOutput()` contract — JSON payloads are written to a temp file with only the file path printed to stdout (never raw JSON on stdout); small one-shot values may use the streaming `writeJsonLine()`/`emitText()` alternative, but the two conventions should not be mixed within one script
- Exit codes follow the repo convention: `0` success, `1` user-facing validation error, `2` unexpected crash, `3` branch-guard violation (ship.js only) — a script should not invent a new exit-code meaning
- `.sdlc/` access goes through `resolveSdlcRoot()` (`scripts/lib/config.js`), not a hand-rolled path join, so worktree/main-repo resolution stays consistent
- No magic numbers or strings (use named constants)
- No dead code or commented-out code blocks
- Async operations handle errors (try/catch or `.catch()`)
- No obvious resource leaks (unclosed file handles, event listeners)
- Consistent style with surrounding code (CommonJS `require()`, no mixed ESM)

## Severity Guide

| Finding | Severity |
|---------|----------|
| Silent error swallowing / lost error context | high |
| Raw JSON printed to stdout instead of the `writeOutput()` file-path contract | high |
| Wrong/invented exit code diverging from the 0/1/2/3 convention | medium |
| Hand-rolled `.sdlc/` path resolution instead of `resolveSdlcRoot()` | medium |
| Inconsistent/misleading naming that could cause bugs | medium |
| Dead code | low |
| Magic number without explanation | low |
| Commented-out code blocks | info |

## Note

In Claude Code reviews, files matching these patterns are excluded: **/*.test.*, **/node_modules/**.
Copilot path-specific instructions do not support exclusion patterns — use judgment
when findings apply to these files.
