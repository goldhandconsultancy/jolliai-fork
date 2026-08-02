#!/usr/bin/env bash
set -euo pipefail

# Lightweight privacy regression gate for the local fork.
# Fails the build when telemetry wiring or unexpected hardcoded outbound hosts appear.

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

TARGET_DIR="${PRIVACY_AUDIT_TARGET_DIR:-cli/src}"
EXTRA_ALLOWED_HOSTS="${PRIVACY_AUDIT_EXTRA_ALLOWED_HOSTS:-}"

# Hosts that are currently expected in source strings for this fork.
BASE_ALLOWED_HOSTS=(
  "127.0.0.1"
  "localhost"
  "anthropic.com"
  "api.anthropic.com"
  "atlassian.net"
  "docs.zoom.us"
  "git-scm.com"
  "github.com"
  "jolli.ai"
  "jolli.cloud"
  "jolli.dev"
  "jolli-local.me"
  "slack.com"
  "openai.azure.com"
)

if [[ -n "$EXTRA_ALLOWED_HOSTS" ]]; then
  IFS=',' read -r -a EXTRA <<< "$EXTRA_ALLOWED_HOSTS"
  for h in "${EXTRA[@]}"; do
    h_trimmed="$(echo "$h" | xargs)"
    [[ -n "$h_trimmed" ]] && BASE_ALLOWED_HOSTS+=("$h_trimmed")
  done
fi

allow_host() {
  local host="$1"
  for allowed in "${BASE_ALLOWED_HOSTS[@]}"; do
    if [[ "$host" == "$allowed" ]] || [[ "$host" == *".$allowed" ]]; then
      return 0
    fi
  done
  return 1
}

fail() {
  echo "[privacy-audit] FAIL: $1" >&2
  exit 1
}

echo "[privacy-audit] checking telemetry wiring..."

# Ensure telemetry startup + hooks are not wired from CLI/API entry points.
grep -q 'TelemetryStartup' cli/src/Cli.ts && fail "TelemetryStartup import present in cli/src/Cli.ts"
grep -q 'TelemetryCommandHook' cli/src/Cli.ts && fail "TelemetryCommandHook import present in cli/src/Cli.ts"
grep -q 'registerTelemetryCommand' cli/src/Api.ts && fail "registerTelemetryCommand still wired in cli/src/Api.ts"
grep -q 'installCommandTelemetryHooks' cli/src/Api.ts && fail "installCommandTelemetryHooks still wired in cli/src/Api.ts"

# Ensure the telemetry backend endpoint is not reintroduced outside the
# dedicated telemetry modules (which may remain in source but are unwired).
if grep -RIn --exclude='*.test.ts' --exclude='*.md' --exclude='Telemetry*.ts' '/api/telemetry/events' "$TARGET_DIR" >/dev/null 2>&1; then
  fail "Telemetry endpoint reference found in source ($TARGET_DIR)"
fi

echo "[privacy-audit] checking hardcoded outbound hosts..."

HOSTS=()
while IFS= read -r line; do
  content="$(echo "$line" | cut -d: -f3-)"
  trimmed="$(echo "$content" | sed -E 's/^[[:space:]]+//')"

  # Ignore URLs that only appear in comments/docs inside source files.
  case "$trimmed" in
    //*) continue ;;
    '/*'*) continue ;;
    \**) continue ;;
  esac

  while IFS= read -r host; do
    HOSTS+=("$host")
  done < <(
    echo "$content" \
      | grep -oE 'https?://[A-Za-z0-9._-]+' \
      | sed -E 's#https?://##' \
      | awk -F'/' '{print tolower($1)}' \
      | awk -F':' '{print $1}'
  )
done < <(
  grep -RInE 'https?://[A-Za-z0-9._-]+' "$TARGET_DIR" \
    --exclude='*.test.ts' \
    --exclude='*.md' \
    --exclude='Telemetry*.ts' \
    --exclude-dir='assets' \
    --exclude-dir='definitions'
)

for host in "${HOSTS[@]}"; do
  [[ -z "$host" ]] && continue
  # Skip single-label tokens (e.g. regex fragments like "https://app\\.asana\\.com")
  # while still checking localhost and loopback explicitly.
  if [[ "$host" != "localhost" && "$host" != "127.0.0.1" && "$host" != *.* ]]; then
    continue
  fi
  if ! allow_host "$host"; then
    fail "Unexpected hardcoded host detected: $host"
  fi
done

echo "[privacy-audit] OK"
