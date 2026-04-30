#!/bin/sh
# ════════════════════════════════════════════════════════════════
# run-zap.sh — ZAP baseline 包裝；有 TARGET_COOKIE 就走「帶 cookie」掃描
#
# 為什麼要包：docker-compose 的 command: 直接寫 zap-baseline.py 時，
# 「條件加 cookie 注入」的 shell 引號會炸（ZAP 的 -z 參數本身要再帶引號）。
# 把組裝邏輯放在一個 sh script 裡，compose 端只負責給環境變數。
#
# ENV：
#   TARGET_URL     必填
#   TARGET_COOKIE  選填；非空時注入 ZAP replacer 加上 Cookie 標頭
# ════════════════════════════════════════════════════════════════
set -e

if [ -z "${TARGET_URL:-}" ]; then
  echo "❌ TARGET_URL 未設" >&2
  exit 2
fi

ARGS="-t $TARGET_URL -r zap-report.html -J zap-report.json -l WARN"

if [ -n "${TARGET_COOKIE:-}" ]; then
  echo "▶ ZAP：偵測到 TARGET_COOKIE → 啟用 replacer 注入 Cookie 標頭"
  # ZAP 的 replacer 規則需要透過 -config 一條條設。matchtype=REQ_HEADER 表示對
  # 「請求標頭」做替換；regex=false 表示 matchstr=Cookie 是字面匹配；replacement
  # 就是要塞進去的整段 cookie 值。description 只是給人看的標籤。
  ARGS="$ARGS -z \"-config replacer.full_list(0).description=auth-cookie -config replacer.full_list(0).enabled=true -config replacer.full_list(0).matchtype=REQ_HEADER -config replacer.full_list(0).matchstr=Cookie -config replacer.full_list(0).regex=false -config replacer.full_list(0).replacement=$TARGET_COOKIE -config replacer.full_list(0).initiators=\""
else
  echo "ℹ️  ZAP：無 TARGET_COOKIE → 跑未認證 baseline 掃描"
fi

# eval 是這裡必要的：ARGS 內含已經組好的引號群，不能直接 $ARGS 展開掉
eval zap-baseline.py "$ARGS"
