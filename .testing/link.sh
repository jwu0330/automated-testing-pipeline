#!/bin/bash
# ════════════════════════════════════════════════════════════════
#  link.sh  —  把本專案連結到共用 pipeline，一鍵跑完所有 n8n 流程
#
#  【只能這麼做 / 一鍵指令】
#    bash .testing/link.sh            # 連結 + 跑全部測試
#    bash .testing/link.sh link       # 只連結，不跑
#    bash .testing/link.sh run        # 只跑（已連結過）
#
#  【尋找共用 pipeline 的順序】（三擇一即可）
#    1. 環境變數 PIPELINE_HOME
#    2. testing.yml 的 pipeline.home 欄位
#    3. 預設：/mnt/e/Code/github/automated-testing-pipeline
# ════════════════════════════════════════════════════════════════
set -euo pipefail

MODE="${1:-all}"

# ─── 位置 ─────────────────────────────────────────────────
KIT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$KIT_DIR/.." && pwd)"
TESTING_YML="$KIT_DIR/testing.yml"

[ -f "$TESTING_YML" ] || { echo "❌ 找不到 $TESTING_YML"; exit 1; }

# ─── 讀 testing.yml（用 yq 優先，沒有就 grep fallback）─────
read_yml() {
    local key="$1" default="${2:-}"
    if command -v yq &>/dev/null; then
        local v
        v=$(yq -r "$key // \"\"" "$TESTING_YML")
        [ -z "$v" ] || [ "$v" = "null" ] && echo "$default" || echo "$v"
    else
        # 簡易 fallback：只能讀單層 key: value
        local k="${key##*.}"
        grep -E "^\s*${k}:\s*" "$TESTING_YML" | head -1 | sed -E "s/^\s*${k}:\s*//; s/^\"//; s/\"$//; s/\s*#.*$//" || echo "$default"
    fi
}

PROJECT_NAME=$(read_yml '.project.name')
LOCAL_PATH=$(read_yml '.project.local_path')
[ -n "$PROJECT_NAME" ] && [ "$PROJECT_NAME" != "example_project" ] \
    || { echo "❌ 請先編輯 .testing/testing.yml，填入真實 project.name"; exit 1; }

# local_path 空或指向 .testing/.. 的 placeholder 時，用實際專案根目錄
if [ -z "$LOCAL_PATH" ] || [ "$LOCAL_PATH" = "/absolute/path/to/project" ]; then
    LOCAL_PATH="$PROJECT_ROOT"
fi

# ─── 找共用 pipeline ──────────────────────────────────────
PIPELINE_HOME="${PIPELINE_HOME:-$(read_yml '.pipeline.home' '/mnt/e/Code/github/automated-testing-pipeline')}"
[ -d "$PIPELINE_HOME" ] || {
    echo "❌ 找不到共用 pipeline：$PIPELINE_HOME"
    echo "   請設環境變數 PIPELINE_HOME，或在 testing.yml 寫 pipeline.home"
    exit 1
}
[ -f "$PIPELINE_HOME/scripts/run-project.sh" ] || {
    echo "❌ $PIPELINE_HOME 看起來不是正確的 pipeline（缺 scripts/run-project.sh）"
    exit 1
}

echo "╔════════════════════════════════════════════════════╗"
echo "║  專案：$PROJECT_NAME"
echo "║  路徑：$LOCAL_PATH"
echo "║  共用 pipeline：$PIPELINE_HOME"
echo "║  模式：$MODE"
echo "╚════════════════════════════════════════════════════╝"

# ─── Step 1. 註冊到共用 pipeline ──────────────────────────
do_link() {
    bash "$PIPELINE_HOME/scripts/register-project.sh" "$PROJECT_NAME" "$LOCAL_PATH"
}

# ─── Step 2. 確保共用 n8n 已啟動 ──────────────────────────
ensure_n8n() {
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -qw n8n; then
        echo "  ✓ 共用 n8n 已在執行"
        return 0
    fi
    echo "▶ 啟動共用 n8n（第一次會 build image）..."
    [ -f "$PIPELINE_HOME/.env" ] || {
        echo "  ⚠ pipeline 還沒建 .env，從 .env.example 建立..."
        cp "$PIPELINE_HOME/.env.example" "$PIPELINE_HOME/.env"
        echo "  ⚠ 請打開 $PIPELINE_HOME/.env 改 N8N_PASSWORD 後重跑"
        exit 1
    }
    (cd "$PIPELINE_HOME" && docker compose --profile n8n up -d --build)
}

# ─── Step 3. 跑完整 n8n 流程 ──────────────────────────────
do_run() {
    bash "$PIPELINE_HOME/scripts/run-project.sh" "$PROJECT_NAME" all
    echo ""
    echo "✅ 完成"
    echo "   報告：$PIPELINE_HOME/reports/$PROJECT_NAME/report.md"
    echo "   n8n GUI：http://localhost:5678"
}

case "$MODE" in
    link)
        do_link
        ensure_n8n
        echo ""
        echo "✅ 已連結，n8n GUI：http://localhost:5678"
        ;;
    run)
        do_run
        ;;
    all|*)
        do_link
        ensure_n8n
        do_run
        ;;
esac
