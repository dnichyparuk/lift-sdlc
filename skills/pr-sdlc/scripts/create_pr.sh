#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

ERR_FILE=$(mktemp)
gh pr create "$@" 2> "$ERR_FILE"
GH_EXIT=$?
if [ "$GH_EXIT" -ne 0 ]; then
  RECOVER_SCRIPT="$SDLC_ROOT/scripts/skill/pr-recover-gh-account.js"
  [ ! -f "$RECOVER_SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/pr-recover-gh-account.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }
  [ -z "$RECOVER_SCRIPT" ] && [ -f "plugins/lift-sdlc/scripts/skill/pr-recover-gh-account.js" ] && RECOVER_SCRIPT="plugins/lift-sdlc/scripts/skill/pr-recover-gh-account.js"
  if [ -n "$RECOVER_SCRIPT" ]; then
    RECOVER_JSON=$(node "$RECOVER_SCRIPT" --error-file "$ERR_FILE")
    echo "$RECOVER_JSON"
  else
    echo "Warning: pr-recover-gh-account.js not found — skipping account-switch recovery"
  fi
fi
rm -f "$ERR_FILE"
exit "$GH_EXIT"
