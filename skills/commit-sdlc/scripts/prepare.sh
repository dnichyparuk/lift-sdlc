#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

SCRIPT="$SDLC_ROOT/scripts/skill/commit.js"
[ ! -f "$SCRIPT" ] && { echo "ERROR: Could not locate scripts/skill/commit.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }

COMMIT_CONTEXT_FILE=$(node "$SCRIPT" --output-file $ARGUMENTS)
EXIT_CODE=$?
# so it survives across separate Bash tool invocations. Error-path manifests still write to
# os.tmpdir() via writeOutput. Explicit `rm -f "$COMMIT_CONTEXT_FILE"` at each exit path
# handles both cases.

echo "COMMIT_CONTEXT_FILE: $COMMIT_CONTEXT_FILE"
echo "STATUS: $EXIT_CODE"

