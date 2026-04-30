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

# ZAP replacer: 為每個要注入的 header 占用一個 index（0, 1, 2 ...）
ZAP_OPTS=""
REPLACER_IDX=0
add_replacer() {
  local name="$1"
  local value="$2"
  local desc="$3"
  [ -z "$value" ] && return 0
  ZAP_OPTS="$ZAP_OPTS -config replacer.full_list(${REPLACER_IDX}).description=${desc}"
  ZAP_OPTS="$ZAP_OPTS -config replacer.full_list(${REPLACER_IDX}).enabled=true"
  ZAP_OPTS="$ZAP_OPTS -config replacer.full_list(${REPLACER_IDX}).matchtype=REQ_HEADER"
  ZAP_OPTS="$ZAP_OPTS -config replacer.full_list(${REPLACER_IDX}).matchstr=${name}"
  ZAP_OPTS="$ZAP_OPTS -config replacer.full_list(${REPLACER_IDX}).replacement=${value}"
  REPLACER_IDX=$((REPLACER_IDX + 1))
}

if [ -s /zap/wrk/auth-cookie-header.txt ]; then
  COOKIE_HEADER="$(cat /zap/wrk/auth-cookie-header.txt)"
  if [ -n "$COOKIE_HEADER" ]; then
    echo "ZAP: injecting same-job Cookie header"
    add_replacer "Cookie" "$COOKIE_HEADER" "auth-cookie"
  fi
fi

# auth-extra-headers.txt：每行一個 「Name: Value」，全部塞成 replacer
if [ -s /zap/wrk/auth-extra-headers.txt ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    case "$line" in \#*) continue ;; esac
    case "$line" in *:*) ;; *) continue ;; esac
    name="${line%%:*}"
    value="${line#*:}"
    # 去頭尾空白
    name="$(echo "$name" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    value="$(echo "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [ -z "$name" ] && continue
    [ -z "$value" ] && continue
    echo "ZAP: injecting header → $name"
    add_replacer "$name" "$value" "auth-${name}"
  done < /zap/wrk/auth-extra-headers.txt
fi

if [ -n "$ZAP_OPTS" ]; then
  exec zap-baseline.py -t "$SCAN_TARGET" -r zap-report.html -J zap-report.json -l WARN -z "$ZAP_OPTS"
fi

exec zap-baseline.py -t "$SCAN_TARGET" -r zap-report.html -J zap-report.json -l WARN
