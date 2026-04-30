#!/bin/sh
# run-lychee.sh - Lychee link checker wrapper.
# Captured-state replay is intentionally unsupported; crawling runs anonymously.
set -e

if [ -z "${TARGET_URL:-}" ]; then
  echo "TARGET_URL is required" >&2
  exit 2
fi

exec lychee \
  --format json \
  --output /reports/lychee.json \
  --no-progress \
  --timeout "${LYCHEE_TIMEOUT:-15}" \
  --max-concurrency "${LYCHEE_MAX_CONCURRENCY:-4}" \
  "$TARGET_URL"