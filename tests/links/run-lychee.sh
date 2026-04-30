#!/bin/sh
# ════════════════════════════════════════════════════════════════
# run-lychee.sh — Lychee 包裝；有 TARGET_COOKIE 就帶 Cookie 標頭爬連結
#
# 為什麼要包：lychee 的 --header 旗標可以重複，但 docker-compose 的 list 形式
# command 不容易做「條件加參數」。包成 script 之後，compose 只給 env，這裡
# 視 TARGET_COOKIE 是否存在動態組 args。
#
# ENV：
#   TARGET_URL              必填
#   TARGET_COOKIE           選填；非空就加 Cookie 標頭（後台連結才掃得到）
#   LYCHEE_TIMEOUT          選填，預設 15
#   LYCHEE_MAX_CONCURRENCY  選填，預設 4
# ════════════════════════════════════════════════════════════════
set -e

if [ -z "${TARGET_URL:-}" ]; then
  echo "❌ TARGET_URL 未設" >&2
  exit 2
fi

set -- \
  --format json \
  --output /reports/lychee.json \
  --no-progress \
  --timeout "${LYCHEE_TIMEOUT:-15}" \
  --max-concurrency "${LYCHEE_MAX_CONCURRENCY:-4}"

if [ -n "${TARGET_COOKIE:-}" ]; then
  echo "▶ Lychee：偵測到 TARGET_COOKIE → 帶 Cookie 標頭爬"
  set -- "$@" --header "Cookie: $TARGET_COOKIE"
else
  echo "ℹ️  Lychee：無 TARGET_COOKIE → 匿名爬"
fi

set -- "$@" "$TARGET_URL"

exec lychee "$@"
