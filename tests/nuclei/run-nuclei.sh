#!/bin/sh
# ════════════════════════════════════════════════════════════════
# run-nuclei.sh — Nuclei 包裝；有 TARGET_COOKIE 就把 Cookie 標頭注入掃描
#
# Nuclei 帶 session 的價值不高（多數 template 是未認證探測），但補上後至少
# 能多抓到「登入後才暴露的版本資訊洩漏」這類少數模板的 finding。
#
# ENV：
#   TARGET_URL          必填
#   TARGET_COOKIE       選填
#   NUCLEI_SEVERITY     預設 critical,high,medium
#   NUCLEI_RATE_LIMIT   預設 50
# ════════════════════════════════════════════════════════════════
set -e

if [ -z "${TARGET_URL:-}" ]; then
  echo "❌ TARGET_URL 未設" >&2
  exit 2
fi

ARGS="-target $TARGET_URL -jsonl-export /reports/nuclei.jsonl -severity ${NUCLEI_SEVERITY:-critical,high,medium} -rate-limit ${NUCLEI_RATE_LIMIT:-50} -stats-interval 10 -no-color -silent"

if [ -n "${TARGET_COOKIE:-}" ]; then
  echo "▶ Nuclei：偵測到 TARGET_COOKIE → 注入 Cookie 標頭"
  # 用 eval 因為 cookie 內可能含 = ; 等字元，引號要保留
  eval nuclei $ARGS -H \"Cookie: $TARGET_COOKIE\" || echo "nuclei exit $?"
else
  echo "ℹ️  Nuclei：無 TARGET_COOKIE → 匿名掃描"
  nuclei $ARGS || echo "nuclei exit $?"
fi
