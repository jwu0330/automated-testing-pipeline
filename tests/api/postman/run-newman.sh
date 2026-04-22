#!/bin/bash
# ════════════════════════════════════════════════════════════════
# run-newman.sh — Newman CLI 測試執行器（單一身分）
#
# 用途：
#   對指定 Postman collection 執行一輪 API 測試；
#   每次執行代表「一個身分」（ADMIN 或 USER1..USER5），由外層迴圈多次呼叫。
#
# 身分注入（Newman --env-var）：
#   CURRENT_IDENTITY   身分標記（admin / user1 / user2 ...）
#   CURRENT_USERNAME   該身分帳號
#   CURRENT_PASSWORD   該身分密碼
#   CURRENT_LABEL      報告上顯示的標籤（如 line_signup；可空）
#
# Collection 可在 test script 用：
#   pm.variables.get('CURRENT_IDENTITY')   // "admin" | "user1"...
#   if (role === 'admin') { 驗 200 } else { 驗 401/403 }
#
# 用法：
#   COLLECTION_PATH=/workspace/collection.json \
#   CURRENT_IDENTITY=admin CURRENT_USERNAME=xxx CURRENT_PASSWORD=yyy \
#   bash run-newman.sh
# ════════════════════════════════════════════════════════════════
set -euo pipefail

COLLECTION_PATH="${COLLECTION_PATH:-${1:-}}"
REPORTS_RAW_DIR="${REPORTS_RAW_DIR:-.}"
BASE_URL="${TARGET_URL:-https://example.com}"

IDENTITY="${CURRENT_IDENTITY:-admin}"
USERNAME="${CURRENT_USERNAME:-}"
PASSWORD="${CURRENT_PASSWORD:-}"
LABEL="${CURRENT_LABEL:-}"

# 身分標記用於報告檔名（admin / user1-line_signup / user2 ...）
SUFFIX="$IDENTITY"
[ -n "$LABEL" ] && SUFFIX="${IDENTITY}-${LABEL}"

echo "╔═══════════════════════════════════════════╗"
echo "║  Newman — API / Auth 測試"
echo "║  身分：$IDENTITY${LABEL:+ ($LABEL)}"
echo "║  帳號：${USERNAME:-（未填）}"
echo "║  目標：$BASE_URL"
echo "╚═══════════════════════════════════════════╝"

# ─── 尋找 collection ─────────────────────────────────────────
if [ -z "$COLLECTION_PATH" ] || [ ! -f "$COLLECTION_PATH" ]; then
    COLLECTION_PATH=$(find /workspace/collections -name "*collection*.json" 2>/dev/null | head -1 || echo "")
fi
if [ -z "$COLLECTION_PATH" ] || [ ! -f "$COLLECTION_PATH" ]; then
    echo "❌ 找不到 Postman collection"
    exit 1
fi
echo "  Collection：$COLLECTION_PATH"

# ─── 帳密空 → 跳過（給 USER 身分用）──────────────────────────
if [ -z "$USERNAME" ] || [ -z "$PASSWORD" ]; then
    echo "  ⏭  身分 '$IDENTITY' 帳密未填，略過此輪"
    exit 0
fi

mkdir -p "$REPORTS_RAW_DIR"
TIMESTAMP=$(date +%s)

echo "  執行中..."
newman run "$COLLECTION_PATH" \
    --env-var "base_url=$BASE_URL" \
    --env-var "timestamp=$TIMESTAMP" \
    --env-var "CURRENT_IDENTITY=$IDENTITY" \
    --env-var "CURRENT_USERNAME=$USERNAME" \
    --env-var "CURRENT_PASSWORD=$PASSWORD" \
    --env-var "CURRENT_LABEL=$LABEL" \
    --reporters cli,json,junit \
    --reporter-json-export "$REPORTS_RAW_DIR/newman-${SUFFIX}.json" \
    --reporter-junit-export "$REPORTS_RAW_DIR/newman-junit-${SUFFIX}.xml" \
    --timeout 30000 \
    --timeout-request 10000 \
    || true

# ─── 給 summarize.js 用的「彙總」副本（最後一次 run 覆蓋）──
# summarize.js 目前讀 newman-junit.xml 單檔；保留一份最新結果給它看。
if [ -f "$REPORTS_RAW_DIR/newman-junit-${SUFFIX}.xml" ]; then
    cp "$REPORTS_RAW_DIR/newman-junit-${SUFFIX}.xml" "$REPORTS_RAW_DIR/newman-junit.xml"
    cp "$REPORTS_RAW_DIR/newman-${SUFFIX}.json"      "$REPORTS_RAW_DIR/newman.json" 2>/dev/null || true
    echo "  ✓ 報告：newman-junit-${SUFFIX}.xml"
    exit 0
else
    echo "❌ Newman 執行失敗，無報告"
    exit 1
fi
