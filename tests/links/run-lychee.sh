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

# 累加所有 auth header，cookie-based 與 token-based 系統都支援
AUTH_ARGS=""
if [ -s /reports/auth-cookie-header.txt ]; then
  COOKIE_HEADER="$(cat /reports/auth-cookie-header.txt)"
  if [ -n "$COOKIE_HEADER" ]; then
    echo "Lychee: using same-job authenticated Cookie header"
    AUTH_ARGS="$AUTH_ARGS --header $(printf %q "Cookie: $COOKIE_HEADER")"
  fi
fi
if [ -s /reports/auth-extra-headers.txt ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    case "$line" in *:*) ;; *) continue ;; esac
    AUTH_ARGS="$AUTH_ARGS --header $(printf %q "$line")"
    echo "Lychee: forwarding header → ${line%%:*}"
  done < /reports/auth-extra-headers.txt
fi

eval exec lychee \
  --format json \
  --output /reports/lychee.json \
  --no-progress \
  --timeout "${LYCHEE_TIMEOUT:-15}" \
  --max-concurrency "${LYCHEE_MAX_CONCURRENCY:-4}" \
  $AUTH_ARGS \
  $(printf %q "$INPUT")
