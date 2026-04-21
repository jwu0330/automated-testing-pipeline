#!/bin/bash
# ════════════════════════════════════════════════════════════════
# run-project.sh — 對指定專案執行測試
#
# 用法：
#   bash scripts/run-project.sh <name> [test-type]
#
# test-type:
#   all (預設) | ssl | security | stress | static | unit | e2e
# ════════════════════════════════════════════════════════════════
set -euo pipefail

NAME="${1:-}"
SCOPE="${2:-all}"

if [ -z "$NAME" ]; then
    echo "用法：bash scripts/run-project.sh <name> [all|ssl|security|stress|static|unit|e2e]"
    exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REGISTRY="$ROOT/projects.registry.yml"

# ─── 前置檢查 ───
if ! command -v yq &> /dev/null; then
    echo "❌ 需要 yq（Go 版）；請先安裝。"
    exit 1
fi

if [ ! -f "$REGISTRY" ]; then
    echo "❌ 找不到 $REGISTRY，請先執行 register-project.sh"
    exit 1
fi

# ─── 讀取專案設定 ───
PROJECT_PATH=$(yq -r ".projects.${NAME}.path // \"null\"" "$REGISTRY")
if [ "$PROJECT_PATH" = "null" ] || [ -z "$PROJECT_PATH" ]; then
    echo "❌ 專案未註冊：$NAME"
    echo "   已註冊的專案："
    yq -r '.projects | keys | .[]' "$REGISTRY" 2>/dev/null | sed 's/^/     - /' || echo "     (無)"
    exit 1
fi

TESTING_YML="$PROJECT_PATH/.testing/testing.yml"
if [ ! -f "$TESTING_YML" ]; then
    echo "❌ $TESTING_YML 不存在"
    echo "   請從範本建立："
    echo "     cp $ROOT/scripts/testing-yml-template.yml \"$TESTING_YML\""
    exit 1
fi

# ─── 匯出環境變數給 docker compose ───
TARGET_URL=$(yq -r '.project.target_url' "$TESTING_YML")
export TARGET_URL
export PROJECT_NAME="$NAME"

# ─── 載入專案敏感變數（env 協議）───
# 規範：各客戶專案在 .testing/.env 提供敏感資訊（gitignore）
# 流水線會 source 後透過 shell env 傳遞給 docker compose 與 docker run
PROJECT_ENV="$PROJECT_PATH/.testing/.env"
if [ -f "$PROJECT_ENV" ]; then
    echo "  ✓ 載入專案 env：$PROJECT_ENV"
    set -a
    # shellcheck disable=SC1090
    source "$PROJECT_ENV"
    set +a
elif [ -f "$PROJECT_PATH/.testing/.env.example" ]; then
    echo "  ⚠️  .testing/.env 不存在（有 .env.example 範本）"
    echo "      如需登入/敏感變數，請先：cp \"$PROJECT_PATH/.testing/.env.example\" \"$PROJECT_PATH/.testing/.env\" 並填值"
fi

REPORTS_DIR="$ROOT/reports/$NAME"
mkdir -p "$REPORTS_DIR"

echo "╔══════════════════════════════════════════════════╗"
echo "║  專案測試：$NAME"
echo "║  目標：   $TARGET_URL"
echo "║  範圍：   $SCOPE"
echo "║  路徑：   $PROJECT_PATH"
echo "║  報告：   $REPORTS_DIR"
echo "╚══════════════════════════════════════════════════╝"

# ─── helper：判斷測試是否啟用 ───
enabled() {
    [ "$(yq -r ".tests.${1}.enabled // false" "$TESTING_YML")" = "true" ]
}

# ─── 搬移檔案 helper（原地產出 → 專案子目錄）───
move_report() {
    local glob="$1"
    for f in $ROOT/reports/$glob; do
        [ -e "$f" ] || continue
        mv "$f" "$REPORTS_DIR/"
    done
}

# ─── 測試 1：SSL/TLS ───
run_ssl() {
    enabled ssl || { echo "⏭  SSL：已停用"; return 0; }
    echo ""
    echo "▶ SSL/TLS 檢測 (testssl.sh)"
    echo "──────────────────────────────────────────"
    docker compose --profile ssl up --build --abort-on-container-exit || echo "  (testssl 結束碼 $?)"
    move_report 'testssl-*.html'
    move_report 'testssl-*.json'
}

# ─── 測試 2：OWASP ZAP ───
# ZAP 會用不同 exit code 表達：0=乾淨、1=錯誤、2=發現警告
run_security() {
    enabled security || { echo "⏭  Security：已停用"; return 0; }
    echo ""
    echo "▶ 資安掃描 (OWASP ZAP)"
    echo "──────────────────────────────────────────"
    docker compose --profile security up --abort-on-container-exit || echo "  (zap 結束碼 $?；2=發現警告，非錯誤)"
    move_report 'zap-report.html'
}

# ─── 測試 3：k6 壓力測試 ───
# k6 未達效能門檻時回傳 99（非 0），仍要搬報告
run_stress() {
    enabled stress || { echo "⏭  Stress：已停用"; return 0; }
    echo ""
    echo "▶ 壓力測試 (k6)"
    echo "──────────────────────────────────────────"
    export K6_VUS=$(yq -r '.tests.stress.vus // 10' "$TESTING_YML")
    export K6_DURATION=$(yq -r '.tests.stress.duration // "30s"' "$TESTING_YML")
    docker compose --profile stress up --abort-on-container-exit || echo "  (k6 結束碼 $?；99=未達效能門檻)"
    move_report 'k6-*.json'
}

# ─── 測試 4：PHPStan 靜態分析 ───
run_static() {
    enabled static || { echo "⏭  Static：已停用"; return 0; }
    echo ""
    echo "▶ 靜態分析 (PHPStan)"
    echo "──────────────────────────────────────────"
    local level
    level=$(yq -r '.tests.static.level // 5' "$TESTING_YML")
    local config="$ROOT/tests/static/phpstan.neon.dist"
    if [ -f "$PROJECT_PATH/.testing/static/phpstan.neon" ]; then
        config="$PROJECT_PATH/.testing/static/phpstan.neon"
        echo "  使用專案客製設定：$config"
    else
        echo "  使用流水線預設設定：$config"
    fi
    local env_args=()
    [ -f "$PROJECT_ENV" ] && env_args=(--env-file="$PROJECT_ENV")
    docker run --rm "${env_args[@]}" \
        -v "$PROJECT_PATH:/project:ro" \
        -v "$config:/phpstan.neon:ro" \
        -v "$REPORTS_DIR:/reports" \
        -w /project \
        ghcr.io/phpstan/phpstan:latest \
        analyse \
            --level="$level" \
            --configuration=/phpstan.neon \
            --error-format=json \
            --no-progress \
            > "$REPORTS_DIR/phpstan.json" || true
    echo "  報告：$REPORTS_DIR/phpstan.json"
}

# ─── 測試 5：PHPUnit 單元測試 ───
run_unit() {
    enabled unit || { echo "⏭  Unit：已停用"; return 0; }
    if [ ! -d "$PROJECT_PATH/.testing/unit" ]; then
        echo "❌ Unit：$PROJECT_PATH/.testing/unit 不存在，跳過"
        return 0
    fi
    echo ""
    echo "▶ 單元測試 (PHPUnit)"
    echo "──────────────────────────────────────────"
    local php_ver
    php_ver=$(yq -r '.project.stack.php_version // "8.1"' "$TESTING_YML")
    local env_args=()
    [ -f "$PROJECT_ENV" ] && env_args=(--env-file="$PROJECT_ENV")
    docker run --rm "${env_args[@]}" \
        -v "$PROJECT_PATH:/project" \
        -v "$REPORTS_DIR:/reports" \
        -w /project/.testing/unit \
        "php:${php_ver}-cli" \
        sh -c '
            if [ ! -f /usr/local/bin/phpunit ]; then
                curl -sLo /usr/local/bin/phpunit https://phar.phpunit.de/phpunit.phar
                chmod +x /usr/local/bin/phpunit
            fi
            phpunit --log-junit /reports/phpunit.xml
        '
}

# ─── 測試 6：Playwright E2E ───
run_e2e() {
    enabled e2e || { echo "⏭  E2E：已停用"; return 0; }
    if [ ! -f "$PROJECT_PATH/.testing/e2e/package.json" ]; then
        echo "❌ E2E：找不到 $PROJECT_PATH/.testing/e2e/package.json，跳過"
        echo "   可參考流水線範本：$ROOT/tests/e2e/"
        return 0
    fi
    echo ""
    echo "▶ E2E 測試 (Playwright)"
    echo "──────────────────────────────────────────"
    local env_args=()
    [ -f "$PROJECT_ENV" ] && env_args=(--env-file="$PROJECT_ENV")
    docker run --rm "${env_args[@]}" \
        -e TARGET_URL="$TARGET_URL" \
        -v "$PROJECT_PATH/.testing/e2e:/e2e" \
        -v "$REPORTS_DIR:/reports" \
        -w /e2e \
        mcr.microsoft.com/playwright:v1.52.0-noble \
        sh -c 'npm ci --no-audit --no-fund && npx playwright test --reporter=html,list'
}

# ─── Dispatch ───
case "$SCOPE" in
    all)
        run_ssl
        run_static
        run_security
        run_stress
        run_unit
        run_e2e
        ;;
    ssl)      run_ssl ;;
    security) run_security ;;
    stress)   run_stress ;;
    static)   run_static ;;
    unit)     run_unit ;;
    e2e)      run_e2e ;;
    *)
        echo "❌ 未知測試類型：$SCOPE"
        echo "   可用：all | ssl | security | stress | static | unit | e2e"
        exit 1
        ;;
esac

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  測試完成"
echo "║  報告位置：$REPORTS_DIR"
echo "╚══════════════════════════════════════════════════╝"
ls -la "$REPORTS_DIR"
