#!/bin/bash
# ═══════════════════════════════════════════════════
# testssl.sh — SSL/TLS 安全檢測
# ═══════════════════════════════════════════════════

set -euo pipefail

TARGET="${TARGET_URL:-https://xcity.babydodofun.com}"
REPORT_DIR="/workspace/reports"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

echo "=========================================="
echo " SSL/TLS 檢測"
echo " 目標: ${TARGET}"
echo " 時間: $(date)"
echo "=========================================="

# 確保報告目錄存在
mkdir -p "${REPORT_DIR}"

# 執行 testssl.sh
/opt/testssl.sh/testssl.sh \
    --html "${REPORT_DIR}/testssl-${TIMESTAMP}.html" \
    --jsonfile "${REPORT_DIR}/testssl-${TIMESTAMP}.json" \
    --severity LOW \
    --fast \
    "${TARGET}"

echo ""
echo "=========================================="
echo " 完成！報告已輸出至 reports/"
echo "=========================================="
