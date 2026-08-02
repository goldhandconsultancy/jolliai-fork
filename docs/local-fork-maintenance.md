# Local fork maintenance (privacy + Azure variant)

This repo can track upstream updates without losing your local customizations.

## One-time setup

1. Keep your custom work on a dedicated branch (example: local-privacy-azure).
2. Commit all local changes there.
3. Optional: add your own fork remote if you want to push the custom branch.

Examples:

- Create/switch custom branch:
  - git checkout -b local-privacy-azure
- Add fork remote (optional):
  - git remote add myfork https://github.com/<you>/jolliai.git

## Update flow (repeat whenever upstream publishes a new version)

Run from repo root:

- ./scripts/sync-local-fork.sh

What it does:

1. Verifies a clean working tree.
2. Ensures an upstream remote exists (defaults to jolliai/jolliai).
3. Fetches latest upstream tags/commits.
4. Checks out your custom branch.
5. Rebases your custom commits on top of upstream/main.
6. Runs cli typecheck by default.
7. Runs a privacy audit gate by default.

The privacy audit (`scripts/privacy-audit.sh`) fails when:

1. Telemetry wiring is reintroduced in CLI entry points.
2. The telemetry endpoint path appears in active source.
3. Unexpected hardcoded outbound hosts appear in source.

If conflicts happen during rebase:

1. Resolve conflicts.
2. git add <resolved-files>
3. git rebase --continue

The script enables git rerere locally, so repeated conflict patterns are auto-resolved in future updates.

## Useful overrides

You can override defaults without editing the script:

- UPSTREAM_REMOTE=upstream
- UPSTREAM_URL=https://github.com/jolliai/jolliai.git
- BASE_BRANCH=main
- CUSTOM_BRANCH=local-privacy-azure
- RUN_CHECKS=1
- RUN_PRIVACY_AUDIT=1

Example:

- CUSTOM_BRANCH=my-custom BASE_BRANCH=main ./scripts/sync-local-fork.sh

To allow additional expected hosts in your environment (without editing the script):

- PRIVACY_AUDIT_EXTRA_ALLOWED_HOSTS=my-internal.example.com ./scripts/sync-local-fork.sh

## Publishing custom branch

After a successful sync/rebase:

- git push myfork local-privacy-azure --force-with-lease

Use force-with-lease because rebase rewrites commit hashes safely.

## Convert existing history to memory now (not only new git triggers)

You can convert historical commits immediately:

- Single repository (all reachable commits):
  - ./scripts/backfill-existing-memory.sh --all
- Single repository (window):
  - ./scripts/backfill-existing-memory.sh --last 200
- Multiple repositories under one folder:
  - ./scripts/backfill-existing-memory.sh --projects-root ~/code --last 200

Useful options forwarded to `jolli backfill`:

- `--dry-run` (inspect first, no LLM call)
- `--min-confidence high|medium|low`
- `--format json`

Note: backfill uses git commit history plus local transcript attribution; results depend on what local transcripts are available per project.
