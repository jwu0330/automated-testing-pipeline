#!/bin/bash
# ═══════════════════════════════════════════════════
# testssl.sh — SSL/TLS 安全檢測
# ═══════════════════════════════════════════════════

set -euo pipefail

TARGET="${TARGET_URL:?TARGET_URL 環境變數必填；此腳本只應由 run-project.sh 或 docker-compose（TARGET_URL 已 export）呼叫}"
REPORT_DIR="/workspace/reports"

echo "=========================================="
echo " SSL/TLS 檢測"
echo " 目標: ${TARGET}"
echo " 時間: $(date)"
echo "=========================================="

# 確保報告目錄存在
mkdir -p "${REPORT_DIR}"

# 固定檔名，每次覆蓋；歷史趨勢由 history.jsonl 維護
# testssl 的 --append 對既有檔會 append，不是覆蓋；所以先刪
rm -f "${REPORT_DIR}/testssl.html" "${REPORT_DIR}/testssl.json"

/opt/testssl.sh/testssl.sh \
    --htmlfile "${REPORT_DIR}/testssl.html" \
    --jsonfile "${REPORT_DIR}/testssl.json" \
    --severity LOW \
    "${TARGET}"

echo ""
echo "=========================================="
echo " 完成！報告已輸出至 reports/"
echo "=========================================="
