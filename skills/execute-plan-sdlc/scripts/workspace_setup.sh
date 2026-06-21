#!/usr/bin/env bash

# Exit immediately if a command exits with a non-zero status
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDLC_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SDLC_LIB="$SDLC_ROOT/scripts/lib"

if [ ! -f "$SDLC_LIB/config.js" ]; then
  echo '{"status": "error", "error": "Could not locate scripts/lib/config.js"}'
  exit 2
fi

WORKSPACE_MODE_FLAG=""
LOGICAL_TYPE=""
DERIVED_SLUG=""
BRANCH_NAME=""

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --workspace-flag) WORKSPACE_MODE_FLAG="$2"; shift ;;
    --logical-type) LOGICAL_TYPE="$2"; shift ;;
    --derived-slug) DERIVED_SLUG="$2"; shift ;;
    --branch-name) BRANCH_NAME="$2"; shift ;;
    *) echo "Unknown parameter passed: $1" >&2; exit 1 ;;
  esac
  shift
done

# 1. Resolve workspace mode
if [ -z "$WORKSPACE_MODE_FLAG" ]; then
  WORKSPACE_MODE=$(node -e "
    const {readSection,resolveSdlcRoot}=require('$SDLC_LIB/config');
    const ws=readSection(resolveSdlcRoot(),'workspace')||{};
    process.stdout.write(ws.mode||'');
  " 2>/dev/null || echo "")
else
  WORKSPACE_MODE="$WORKSPACE_MODE_FLAG"
fi

# 2. Resolve branch name
if [ -n "$BRANCH_NAME" ]; then
  EXECUTE_BRANCH="$BRANCH_NAME"
else
  EXECUTE_BRANCH=$(LOGICAL_TYPE="$LOGICAL_TYPE" DERIVED_SLUG="$DERIVED_SLUG" node -e "
    const {resolveBranchName}=require('$SDLC_LIB/branch-name');
    const {readSection,resolveSdlcRoot}=require('$SDLC_LIB/config');
    const cfg=(readSection(resolveSdlcRoot(),'workspace')||{}).branch||{};
    process.stdout.write(resolveBranchName({
      type: process.env.LOGICAL_TYPE || 'feature',
      slug: process.env.DERIVED_SLUG || 'feature-branch',
      config: cfg
    }));
  " 2>/dev/null || echo "")
fi

# 3. Branch/worktree creation
WORKTREE_PATH=""
if [ "$WORKSPACE_MODE" = "branch" ] && [ -n "$EXECUTE_BRANCH" ]; then
  git checkout "$EXECUTE_BRANCH" >/dev/null 2>&1 || git checkout -b "$EXECUTE_BRANCH" >/dev/null 2>&1
elif [ "$WORKSPACE_MODE" = "worktree" ] && [ -n "$EXECUTE_BRANCH" ]; then
  WORKTREE_CREATE_SCRIPT="$SDLC_ROOT/scripts/util/worktree-create.js"
  if [ ! -f "$WORKTREE_CREATE_SCRIPT" ] && [ -f "$SDLC_ROOT/plugins/lift-sdlc/scripts/util/worktree-create.js" ]; then
    WORKTREE_CREATE_SCRIPT="$SDLC_ROOT/plugins/lift-sdlc/scripts/util/worktree-create.js"
  fi
  if [ ! -f "$WORKTREE_CREATE_SCRIPT" ]; then
    echo '{"status": "error", "error": "Could not locate scripts/util/worktree-create.js"}'
    exit 2
  fi
  result=$(node "$WORKTREE_CREATE_SCRIPT" --name "$EXECUTE_BRANCH" 2>/dev/null || true)
  if [ -n "$result" ]; then
    WORKTREE_PATH=$(echo "$result" | node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).path||'')}catch(_){}")
    EXECUTE_BRANCH=$(echo "$result" | node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).branch||'')}catch(_){}")
  fi
fi

echo "{\"status\": \"success\", \"executeBranch\": \"$EXECUTE_BRANCH\", \"worktreePath\": \"$WORKTREE_PATH\"}"
