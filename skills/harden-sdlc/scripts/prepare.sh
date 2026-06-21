#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

SCRIPT="$SDLC_ROOT/scripts/skill/harden-prepare.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/harden-prepare.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }

MANIFEST_FILE=$(node "$SCRIPT" \
  ${FAILURE_TEXT:+--failure-text "$FAILURE_TEXT"} \
  ${FROM_ISSUE:+--from-issue "$FROM_ISSUE"} \
  --skill "$SKILL_NAME" \
  --step "$STEP_NAME" \
  --operation "$OPERATION" \
  --exit-code "$EXIT_CODE_ARG" \
  --error-type "$ERROR_TYPE" \
  --user-intent "$USER_INTENT" \
  --args-string "$ARGS_STRING" \
  --output-file)
EXIT_CODE_PREPARE=$?
# we do not attempt `rm -f ""` on a failed script invocation.

echo "MANIFEST_FILE: $MANIFEST_FILE"