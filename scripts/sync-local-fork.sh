#!/usr/bin/env bash
set -euo pipefail

# Sync a local customization branch with the latest upstream changes while
# preserving your local commits (privacy + provider customizations) on top.
#
# Defaults can be overridden via env vars:
#   UPSTREAM_REMOTE=upstream
#   UPSTREAM_URL=https://github.com/jolliai/jolliai.git
#   BASE_BRANCH=main
#   CUSTOM_BRANCH=local-privacy-azure
#   RUN_CHECKS=1
#   RUN_PRIVACY_AUDIT=1

UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
UPSTREAM_URL="${UPSTREAM_URL:-https://github.com/jolliai/jolliai.git}"
BASE_BRANCH="${BASE_BRANCH:-main}"
CUSTOM_BRANCH="${CUSTOM_BRANCH:-local-privacy-azure}"
RUN_CHECKS="${RUN_CHECKS:-1}"
RUN_PRIVACY_AUDIT="${RUN_PRIVACY_AUDIT:-1}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Error: run this script inside a git repository." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash changes first." >&2
  exit 1
fi

# Remember conflict resolutions between rebases.
git config rerere.enabled true
git config rerere.autoupdate true

if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  echo "Adding remote '$UPSTREAM_REMOTE' -> $UPSTREAM_URL"
  git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"
fi

echo "Fetching $UPSTREAM_REMOTE..."
git fetch "$UPSTREAM_REMOTE" --tags

if git show-ref --verify --quiet "refs/heads/$CUSTOM_BRANCH"; then
  git checkout "$CUSTOM_BRANCH"
else
  echo "Creating branch '$CUSTOM_BRANCH' from $UPSTREAM_REMOTE/$BASE_BRANCH"
  git checkout -b "$CUSTOM_BRANCH" "$UPSTREAM_REMOTE/$BASE_BRANCH"
fi

echo "Rebasing $CUSTOM_BRANCH onto $UPSTREAM_REMOTE/$BASE_BRANCH..."
git rebase "$UPSTREAM_REMOTE/$BASE_BRANCH"

if [[ "$RUN_CHECKS" == "1" ]]; then
  if [[ -d "cli" ]]; then
    echo "Running checks: npm -w cli run typecheck"
    npm -w cli run typecheck
  fi
fi

if [[ "$RUN_PRIVACY_AUDIT" == "1" ]]; then
  if [[ -x "scripts/privacy-audit.sh" ]]; then
    echo "Running privacy audit: ./scripts/privacy-audit.sh"
    ./scripts/privacy-audit.sh
  else
    echo "Warning: scripts/privacy-audit.sh not found or not executable; skipping privacy audit." >&2
  fi
fi

echo "Done. Your custom branch is now updated on top of latest upstream."
echo "Tip: if you keep a fork remote, push with: git push <fork-remote> $CUSTOM_BRANCH --force-with-lease"
