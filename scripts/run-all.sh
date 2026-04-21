#!/bin/bash
# ═══════════════════════════════════════════════════
# 一鍵執行全部測試
# 使用方式：bash scripts/run-all.sh
# ═══════════════════════════════════════════════════

set -euo pipefail
cd "$(dirname "$0")/.."

echo "╔═══════════════════════════════════════════╗"
echo "║   自動化測試流水線 — babydodofun           ║"
echo "║   $(date)                                  ║"
echo "╚═══════════════════════════════════════════╝"
echo ""

# 檢查 .env
if [ ! -f .env ]; then
    echo "❌ 找不到 .env 檔案，請先執行："
    echo "   cp .env.example .env"
    exit 1
fi

# 建立報告目錄
mkdir -p reports

# ─── 第 1 步：SSL/TLS 檢測 ───
echo ""
echo "▶ [1/4] SSL/TLS 檢測 (testssl.sh)"
echo "────────────────────────────────────"
docker compose --profile ssl up --build --abort-on-container-exit
echo "✅ SSL 檢測完成"

# ─── 第 2 步：資安掃描 ───
echo ""
echo "▶ [2/4] 資安掃描 (OWASP ZAP)"
echo "────────────────────────────────────"
docker compose --profile security up --abort-on-container-exit
echo "✅ 資安掃描完成"

# ─── 第 3 步：壓力測試 ───
echo ""
echo "▶ [3/4] 壓力測試 (k6)"
echo "────────────────────────────────────"
docker compose --profile stress up --abort-on-container-exit
echo "✅ 壓力測試完成"

# ─── 第 4 步：E2E 測試 ───
echo ""
echo "▶ [4/4] E2E 測試 (Playwright)"
echo "────────────────────────────────────"
docker compose --profile e2e up --abort-on-container-exit
echo "✅ E2E 測試完成"

# ─── 總結 ───
echo ""
echo "╔═══════════════════════════════════════════╗"
echo "║   全部測試完成！                            ║"
echo "╚═══════════════════════════════════════════╝"
echo ""
echo "📋 報告位置："
ls -la reports/
