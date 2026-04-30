#!/bin/sh
# run-zap.sh - OWASP ZAP baseline wrapper.
# Uses same-job form-login artifacts when auth discovery produced them.
set -e

if [ -z "${TARGET_URL:-}" ]; then
  echo "TARGET_URL is required" >&2
  exit 2
fi

SCAN_TARGET="$TARGET_URL"
if [ -s /zap/wrk/auth-urls.txt ]; then
  FIRST_AUTH_URL="$(grep -E '^https?://' /zap/wrk/auth-urls.txt | head -n 1 || true)"
  if [ -n "$FIRST_AUTH_URL" ]; then
    SCAN_TARGET="$FIRST_AUTH_URL"
  fi
fi

ZAP_OPTS=""
if [ -s /zap/wrk/auth-cookie-header.txt ]; then
  COOKIE_HEADER="$(cat /zap/wrk/auth-cookie-header.txt)"
  if [ -n "$COOKIE_HEADER" ]; then
    echo "ZAP: using same-job authenticated Cookie header"
    ZAP_OPTS="-config replacer.full_list(0).description=auth-cookie -config replacer.full_list(0).enabled=true -config replacer.full_list(0).matchtype=REQ_HEADER -config replacer.full_list(0).matchstr=Cookie -config replacer.full_list(0).replacement=$COOKIE_HEADER"
  fi
fi

if [ -n "$ZAP_OPTS" ]; then
  exec zap-baseline.py -t "$SCAN_TARGET" -r zap-report.html -J zap-report.json -l WARN -z "$ZAP_OPTS"
fi

exec zap-baseline.py -t "$SCAN_TARGET" -r zap-report.html -J zap-report.json -l WARN
