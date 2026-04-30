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

# 收集所有 auth header — 同時支援 cookie-based 與 token-based 系統
AUTH_ARGS=""
if [ -s /reports/auth-cookie-header.txt ]; then
  COOKIE_HEADER="$(cat /reports/auth-cookie-header.txt)"
  if [ -n "$COOKIE_HEADER" ]; then
    echo "Nuclei: using same-job authenticated Cookie header"
    AUTH_ARGS="$AUTH_ARGS -H \"Cookie: $COOKIE_HEADER\""
  fi
fi
# auth-extra-headers.txt：每行 「Name: Value」 — Authorization / X-Admin-Token 等
if [ -s /reports/auth-extra-headers.txt ]; then
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    # 跳過註解與不含冒號的爛行
    case "$line" in \#*) continue ;; esac
    case "$line" in *:*) ;; *) continue ;; esac
    # shell 安全：用 printf %q 轉成可重新解析的字串
    AUTH_ARGS="$AUTH_ARGS -H $(printf %q "$line")"
    echo "Nuclei: forwarding header → ${line%%:*}"
  done < /reports/auth-extra-headers.txt
fi

run_nuclei() {
  if [ "$USE_AUTH_LIST" = "1" ]; then
    eval nuclei -list /reports/auth-urls.txt "$AUTH_ARGS" "$@"
  else
    eval nuclei -target "$TARGET_URL" "$AUTH_ARGS" "$@"
  fi
}

run_nuclei \
  -jsonl-export /reports/nuclei.jsonl \
  -severity "${NUCLEI_SEVERITY:-critical,high,medium}" \
  -rate-limit "${NUCLEI_RATE_LIMIT:-50}" \
  -stats-interval 10 \
  -no-color \
  -silent \
  || echo "nuclei exit $?"
