#!/usr/bin/env bash
set -euo pipefail

# Backfill existing commit history into memory summaries.
# Supports one repo (default: current repo) or all git repos under a folder.
#
# Examples:
#   ./scripts/backfill-existing-memory.sh
#   ./scripts/backfill-existing-memory.sh --all --min-confidence medium
#   ./scripts/backfill-existing-memory.sh --projects-root ~/code --last 200
#
# Notes:
# - Backfill uses commit history + local transcript attribution.
# - It is not limited to new git triggers; this converts historical commits now.
# - This helper expects workspace dependencies to be installed.

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
PROJECTS_ROOT=""

ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --projects-root)
      PROJECTS_ROOT="$2"
      shift 2
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

run_backfill_repo() {
  local repo="$1"
  echo "[backfill] repo: $repo"
  (
    cd "$repo"
    npm -w cli run -s cli -- backfill "${ARGS[@]}"
  )
}

if [[ -z "$PROJECTS_ROOT" ]]; then
  if [[ -z "$ROOT" ]]; then
    echo "Error: not inside a git repo. Use --projects-root <folder> or run in a repo." >&2
    exit 1
  fi
  run_backfill_repo "$ROOT"
  exit 0
fi

if [[ ! -d "$PROJECTS_ROOT" ]]; then
  echo "Error: projects root does not exist: $PROJECTS_ROOT" >&2
  exit 1
fi

REPOS=()
while IFS= read -r repo; do
  REPOS+=("$repo")
done < <(find "$PROJECTS_ROOT" -type d -name .git -prune | sed 's#/.git$##' | sort)

if [[ ${#REPOS[@]} -eq 0 ]]; then
  echo "No git repos found under: $PROJECTS_ROOT"
  exit 0
fi

for repo in "${REPOS[@]}"; do
  run_backfill_repo "$repo"
done
