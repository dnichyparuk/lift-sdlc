#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Post-version ancestry HARD GATE (R-post-version-ancestry, fixes #349)
VERIFY_SCRIPT="$SDLC_ROOT/scripts/util/verify-tag-ancestry.js"
[ ! -f "$VERIFY_SCRIPT" ] && { echo "ERROR: Could not locate scripts/util/verify-tag-ancestry.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }
[ -z "$VERIFY_SCRIPT" ] && [ -f "plugins/lift-sdlc/scripts/util/verify-tag-ancestry.js" ] && VERIFY_SCRIPT="plugins/lift-sdlc/scripts/util/verify-tag-ancestry.js"
if [ -z "$VERIFY_SCRIPT" ]; then
  echo "WARNING: verify-tag-ancestry.js not found — post-version ancestry check skipped." >&2
fi
if [ -n "$VERIFY_SCRIPT" ] && [ -n "$NEW_TAG" ] && [ -n "$EXECUTE_BRANCH" ]; then
  node "$VERIFY_SCRIPT" --tag "$NEW_TAG" --branch "$EXECUTE_BRANCH" --remote origin
  ANCESTRY_EXIT=$?
  if [ "$ANCESTRY_EXIT" -ne 0 ]; then
    echo "Pipeline halted: tag $NEW_TAG is not an ancestor of $EXECUTE_BRANCH." >&2
    echo "Remediation: delete the tag (git push origin :refs/tags/$NEW_TAG; git tag -d $NEW_TAG) and re-run version step on the correct branch." >&2
    exit 1
  fi
fi
