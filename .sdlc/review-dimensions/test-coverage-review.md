---
name: test-coverage-review
description: "Reviews whether new or changed scripts/lib, scripts/util, and scripts/skill files have corresponding node:test coverage"
triggers:
  - "scripts/lib/**/*.js"
  - "scripts/util/**/*.js"
  - "scripts/skill/**/*.js"
  - "scripts/state/**/*.js"
skip-when:
  - "**/*.test.*"
  - "scripts/ci/**"
severity: medium
model: gemini-3.8-flash-medium
---

# Test Coverage Review

Review whether new or changed Node.js CLI/library code is accompanied by appropriate
`node:test` coverage. This repo bootstrapped its test suite (289 passing tests) as part of
migrating every legacy `.sh` wrapper to a tested Node.js module — the co-located test-file
convention should hold going forward, not regress to untested scripts.

## Checklist

- [ ] A new `scripts/lib/<name>.js` or `scripts/util/<name>.js` file has a co-located
      `scripts/lib/<name>.test.js` / `scripts/util/<name>.test.js` using `node:test` +
      `node:assert`
- [ ] `npm test` (`node --test 'scripts/**/*.test.js' 'skills/**/*.test.js'`) actually
      discovers the new test file — verify the file name matches the `*.test.js` glob and
      isn't nested somewhere the glob misses
- [ ] New functions/CLI flags have at least one test covering the happy path
- [ ] New error conditions have tests (invalid flags, missing files, malformed input) —
      this repo's `parseArgs`/`writeOutput` convention makes exit-code assertions cheap;
      use them
- [ ] Tests are meaningful — they assert on behavior (exit code, stdout file-path contents,
      stderr message), not just that the script ran without throwing
- [ ] Tests do not depend on real network/filesystem state outside `os.tmpdir()` or an
      explicitly-created scratch directory
- [ ] Regression tests added when fixing a bug in an existing script (this migration itself
      fixed several latent bugs — e.g. two scripts that resolved a target path but never
      invoked it — precisely because nothing had tested the actual invocation)

## Severity Guide

| Finding | Severity |
|---------|----------|
| New CLI script with zero test file | high |
| Bug fix with no regression test | high |
| Test file exists but doesn't match the `npm test` glob (silently never runs) | high |
| New flag/branch with no test | medium |
| Test only asserts exit code 0, ignores actual output contents | medium |
| Missing edge-case test (invalid flag, missing arg) | low |
