#!/bin/sh
# run-lychee.sh - Lychee link checker wrapper.
# Uses same-job form-login artifacts when auth discovery produced them.
set -e

if [ -z "${TARGET_URL:-}" ]; then
  echo "TARGET_URL is required" >&2
  exit 2
fi

INPUT="$TARGET_URL"
if [ -s /reports/auth-urls.txt ]; then
  echo "Lychee: using authenticated URL list from auth discovery"
  INPUT="/reports/auth-urls.txt"
fi

COOKIE_HEADER=""
if [ -s /reports/auth-cookie-header.txt ]; then
  COOKIE_HEADER="$(cat /reports/auth-cookie-header.txt)"
  [ -n "$COOKIE_HEADER" ] && echo "Lychee: using same-job authenticated Cookie header"
fi

if [ -n "$COOKIE_HEADER" ]; then
  exec lychee \
    --format json \
    --output /reports/lychee.json \
    --no-progress \
    --timeout "${LYCHEE_TIMEOUT:-15}" \
    --max-concurrency "${LYCHEE_MAX_CONCURRENCY:-4}" \
    --header "Cookie: $COOKIE_HEADER" \
    "$INPUT"
fi

exec lychee \
  --format json \
  --output /reports/lychee.json \
  --no-progress \
  --timeout "${LYCHEE_TIMEOUT:-15}" \
  --max-concurrency "${LYCHEE_MAX_CONCURRENCY:-4}" \
  "$INPUT"
