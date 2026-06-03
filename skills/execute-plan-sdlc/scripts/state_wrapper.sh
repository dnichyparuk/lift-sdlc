#!/usr/bin/env bash

# Exit immediately if a command exits with a non-zero status
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

SCRIPT="$SDLC_ROOT/scripts/state/execute.js"
if [ ! -f "$SCRIPT" ] && [ -f "$SDLC_ROOT/plugins/sdlc-utilities/scripts/state/execute.js" ]; then
  SCRIPT="$SDLC_ROOT/plugins/sdlc-utilities/scripts/state/execute.js"
fi

if [ ! -f "$SCRIPT" ]; then
  echo "ERROR: Could not locate scripts/state/execute.js" >&2
  exit 2
fi

node "$SCRIPT" "$@"
