#!/bin/bash
# ═══════════════════════════════════════════════════
# 一鍵執行全部測試
# 使用方式：bash scripts/run-all.sh
# ═══════════════════════════════════════════════════

set -euo pipefail
cd "$(dirname "$0")/.."

echo "╔═══════════════════════════════════════════╗"
echo "║   01 Init - Set Project Vars              ║"
echo "║   自動化測試流水線（精簡四步）             ║"
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

# ─── 與 run-project.sh all 對齊的命名（此腳本為子集）───
# ─── [1/4] 06 Security - SSL Scan ───
echo ""
echo "▶ [1/4] 06 Security - SSL Scan (testssl.sh)"
echo "────────────────────────────────────"
docker compose --profile ssl up --build --abort-on-container-exit
echo "✅ 06 Security - SSL Scan 完成"

# ─── [2/4] 09 Web - E2E Tests ───
echo ""
echo "▶ [2/4] 09 Web - E2E Tests (Playwright)"
echo "────────────────────────────────────"
docker compose --profile e2e up --abort-on-container-exit
echo "✅ 09 Web - E2E Tests 完成"

# ─── [3/4] 11 Security - ZAP ───
echo ""
echo "▶ [3/4] 11 Security - ZAP (OWASP ZAP)"
echo "────────────────────────────────────"
docker compose --profile security up --abort-on-container-exit
echo "✅ 11 Security - ZAP 完成"

# ─── [4/4] 12 Performance - Load Test ───
echo ""
echo "▶ [4/4] 12 Performance - Load Test (k6)"
echo "────────────────────────────────────"
docker compose --profile stress up --abort-on-container-exit
echo "✅ 12 Performance - Load Test 完成"

# ─── 總結 ───
echo ""
echo "╔═══════════════════════════════════════════╗"
echo "║   全部測試完成！                            ║"
echo "╚═══════════════════════════════════════════╝"
echo ""
echo "📋 報告位置："
ls -la reports/
