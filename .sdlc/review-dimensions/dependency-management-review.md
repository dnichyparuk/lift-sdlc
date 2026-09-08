---
name: dependency-management-review
description: "Reviews package.json/package-lock.json changes for lockfile consistency, version pinning, and unnecessary additions"
triggers:
  - "package.json"
  - "package-lock.json"
severity: medium
model: gemini-3.8-flash-medium
---

# Dependency Management Review

Review dependency changes for consistency and necessity. This repo is an Antigravity plugin
distributed to other users' machines, not an app with a controlled deploy environment — it
deliberately bootstrapped its test infrastructure on `node:test` (built into Node.js) to add
**zero** new runtime/dev dependencies. New dependencies should be treated as a real cost, not
a default choice.

## Checklist

- [ ] `package-lock.json` is updated consistently with any `package.json` change (no
      divergence)
- [ ] A new dependency is genuinely necessary — check whether the same need can be met with
      a Node.js built-in (as `node:test`/`node:assert` already are for this repo) before
      adding a package
- [ ] New dependencies are pinned to an exact or narrow version range, not `*` or `latest`
- [ ] No packages added that are deprecated, unmaintained, or have known CVEs
- [ ] Dev-only tooling (like `eslint`) stays in `devDependencies`, not a production
      dependency list
- [ ] `engines.node` in `package.json` stays consistent with any feature actually used
      (e.g. don't rely on a Node API newer than the declared minimum)
- [ ] License of any new dependency is compatible with this project's license

## Severity Guide

| Finding | Severity |
|---------|----------|
| Package with a known critical CVE added | critical |
| Lockfile diverges from manifest | high |
| Deprecated/unmaintained package added with a built-in Node.js alternative available | high |
| Unintended major version bump in lockfile | medium |
| Dev dependency placed in production dependency list | medium |
| `*` or `latest` version specifier | medium |
| `engines.node` doesn't cover an API actually used in the change | medium |
