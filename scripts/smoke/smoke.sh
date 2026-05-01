#!/usr/bin/env bash
#
# Post-deploy smoke test for the Tarmoto backend.
#
# Usage: scripts/smoke/smoke.sh <base-url>
#   <base-url>   Backend root, e.g. https://api.staging.tarmoto.app
#                Trailing slash is fine; the script normalises.
#
# Exits 0 on success, non-zero on failure. Designed to be run by:
#   - .github/workflows/backend-deploy.yml after the ECS deploy
#     stabilises.
#   - operators following docs/process/runbook.md "production deploy"
#     to verify a manual rollback or a hotfix.
#
# Keep this fast — under 30s on a healthy stack. The full E2E suite
# is the companion-e2e workflow; this is just the "is the lights on"
# probe.

set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "usage: $0 <base-url>" >&2
  exit 64
fi

BASE_URL="${1%/}"
RETRIES="${SMOKE_RETRIES:-6}"
SLEEP_SECS="${SMOKE_SLEEP:-5}"

# A request helper: curl with sane defaults, retry on transient
# 5xx / connection failures.
http_check() {
  local path="$1"
  local expected_status="${2:-200}"
  local match_regex="${3:-}"

  local url="${BASE_URL}${path}"
  local attempt=1
  local status body

  while [ "$attempt" -le "$RETRIES" ]; do
    body="$(mktemp)"
    status=$(curl --silent --show-error --output "$body" --write-out "%{http_code}" \
                  --max-time 10 \
                  -H "user-agent: tarmoto-smoke/1" \
                  "$url" || echo "000")

    if [ "$status" = "$expected_status" ]; then
      if [ -n "$match_regex" ] && ! grep -Eq "$match_regex" "$body"; then
        echo "[smoke] ${path}: status $status but body did not match /${match_regex}/"
        head -c 400 "$body"; echo
        rm -f "$body"
        return 1
      fi
      echo "[smoke] ${path}: ok ($status)"
      rm -f "$body"
      return 0
    fi

    echo "[smoke] ${path}: attempt $attempt got $status (want $expected_status), retrying in ${SLEEP_SECS}s"
    rm -f "$body"
    sleep "$SLEEP_SECS"
    attempt=$((attempt + 1))
  done

  echo "[smoke] ${path}: failed after $RETRIES attempts (last status $status)" >&2
  return 1
}

echo "[smoke] Target: ${BASE_URL}"

# Liveness — must succeed without DB/Redis. See app.controller.ts.
http_check "/api/v1/healthz" 200 '"status"\s*:\s*"ok"'

# Jobs health — exercises BullMQ + Redis. The workflow runs this
# after ECS service is stable, so any 5xx here is a real regression
# (probably config drift between Secrets Manager and the task def).
http_check "/api/v1/jobs/health" 200 '"queues"'

# Public auth probe: the login endpoint must respond at all (we
# don't actually try to authenticate). Expect a 4xx (not 5xx) on a
# bare GET — what we want is "the route exists and isn't 502".
# The endpoint typically rejects GET with 405 Method Not Allowed.
attempt_status=$(curl --silent --output /dev/null --max-time 10 \
                      --write-out "%{http_code}" \
                      "${BASE_URL}/api/v1/auth/login" || echo "000")
if [[ "$attempt_status" =~ ^(2|4)[0-9][0-9]$ ]]; then
  echo "[smoke] /api/v1/auth/login: route reachable ($attempt_status)"
else
  echo "[smoke] /api/v1/auth/login: unexpected status $attempt_status" >&2
  exit 1
fi

echo "[smoke] All checks passed."
