#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

LINKS_LIB="$SDLC_ROOT/scripts/lib/links.js"
[ ! -f "$LINKS_LIB" ] && { echo "ERROR: Could not locate scripts/lib/links.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }
  [ -z "$LINKS_LIB" ] && [ -f "plugins/lift-sdlc/scripts/lib/links.js" ] && LINKS_LIB="plugins/lift-sdlc/scripts/lib/links.js"
  [ -z "$LINKS_LIB" ] && { echo "ERROR: Could not locate scripts/lib/links.js. Is the Lift-SDLC plugin installed?" >&2; exit 2; }
  target_file="${comment_file:-$1}"
  if [ "$target_file" = "--file" ] && [ -n "$2" ]; then
    target_file="$2"
  fi
  node "$LINKS_LIB" --file "$target_file" --json
  LINK_EXIT=$?
