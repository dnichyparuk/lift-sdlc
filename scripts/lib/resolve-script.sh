#!/usr/bin/env sh
# resolve-script.sh — canonical find-then-fallback resolver for sibling plugin scripts.
# Usage: resolve_script <script-name> <path-pattern> <local-fallback>
# Echoes the resolved absolute path, or empty string on failure.
#
# Source this file once at the start of a SKILL.md bash block, then call
# resolve_script for each script you need to locate.
#
# Example:
#   RESOLVER=$(find ~/.gemini/config/plugins -name "resolve-script.sh" -path "*/sdlc*/scripts/lib/resolve-script.sh" 2>/dev/null | sort -V | tail -1)
#   [ -z "$RESOLVER" ] && [ -f "plugins/lift-sdlc/scripts/lib/resolve-script.sh" ] && RESOLVER="plugins/lift-sdlc/scripts/lib/resolve-script.sh"
#   [ -n "$RESOLVER" ] && . "$RESOLVER"
#   SCRIPT=$(resolve_script "harden-prepare.js" "*/sdlc*/scripts/skill/harden-prepare.js" "plugins/lift-sdlc/scripts/skill/harden-prepare.js")

resolve_script() {
  local name="$1" pattern="$2" local_path="$3" found
  found=$(find ~/.gemini/config/plugins -name "$name" -path "$pattern" 2>/dev/null | sort -V | tail -1)
  [ -z "$found" ] && [ -f "$local_path" ] && found="$local_path"
  printf '%s\n' "$found"
}
