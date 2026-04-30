#!/bin/sh
# run-nuclei.sh - Nuclei scanner wrapper.
# Uses same-job form-login artifacts when auth discovery produced them.
set -e

if [ -z "${TARGET_URL:-}" ]; then
  echo "TARGET_URL is required" >&2
  exit 2
fi

USE_AUTH_LIST=0
if [ -s /reports/auth-urls.txt ]; then
  echo "Nuclei: using authenticated URL list from auth discovery"
  USE_AUTH_LIST=1
fi

COOKIE_HEADER=""
if [ -s /reports/auth-cookie-header.txt ]; then
  COOKIE_HEADER="$(cat /reports/auth-cookie-header.txt)"
  if [ -n "$COOKIE_HEADER" ]; then
    echo "Nuclei: using same-job authenticated Cookie header"
  fi
fi

run_nuclei() {
  if [ "$USE_AUTH_LIST" = "1" ]; then
    nuclei -list /reports/auth-urls.txt "$@"
  else
    nuclei -target "$TARGET_URL" "$@"
  fi
}

if [ -n "$COOKIE_HEADER" ]; then
  run_nuclei \
    -H "Cookie: $COOKIE_HEADER" \
    -jsonl-export /reports/nuclei.jsonl \
    -severity "${NUCLEI_SEVERITY:-critical,high,medium}" \
    -rate-limit "${NUCLEI_RATE_LIMIT:-50}" \
    -stats-interval 10 \
    -no-color \
    -silent \
    || echo "nuclei exit $?"
else
  run_nuclei \
    -jsonl-export /reports/nuclei.jsonl \
    -severity "${NUCLEI_SEVERITY:-critical,high,medium}" \
    -rate-limit "${NUCLEI_RATE_LIMIT:-50}" \
    -stats-interval 10 \
    -no-color \
    -silent \
    || echo "nuclei exit $?"
fi
