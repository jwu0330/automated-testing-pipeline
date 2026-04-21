#!/bin/bash
# ════════════════════════════════════════════════════════════════
# run-project.sh — 對指定專案執行測試（schema v2）
#
# 用法：
#   bash scripts/run-project.sh <name> [scope]
#
# scope:
#   all (預設) | ssl | security | stress | static | unit | e2e
#   nuclei | lighthouse | monkey | trivy | links | summary
#
# 設計原則：
#   - testing.yml 只需 4 個必填欄位（name / target_url / local_path / php_version）
#   - 其他測試開關走自動偵測，testing.yml 只寫「要覆寫」的部分
#   - local_path 為空 → 只跑 URL-based 測試（ssl/security/stress）
#   - 原始工具輸出放 reports/<name>/raw/；summarize.js 會產生統一 report.md
# ════════════════════════════════════════════════════════════════
set -euo pipefail

NAME="${1:-}"
SCOPE="${2:-all}"

if [ -z "$NAME" ]; then
    echo "用法：bash scripts/run-project.sh <name> [all|ssl|security|stress|static|unit|e2e|nuclei|lighthouse|monkey|trivy|links|summary]"
    exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REGISTRY="$ROOT/projects.registry.yml"
command -v yq &>/dev/null || { echo "❌ 需要 yq（Go 版）"; exit 1; }
[ -f "$REGISTRY" ] || { echo "❌ 找不到 $REGISTRY，請先 register-project.sh"; exit 1; }

# ─── 從 registry 找到 testing.yml ───
REG_PATH=$(yq -r ".projects.${NAME}.path // \"\"" "$REGISTRY")
if [ -z "$REG_PATH" ] || [ "$REG_PATH" = "null" ]; then
    echo "❌ 專案未註冊：$NAME"
    echo "   已註冊："
    yq -r '.projects | keys | .[]' "$REGISTRY" 2>/dev/null | sed 's/^/     - /' || echo "     (無)"
    exit 1
fi

TESTING_YML="$REG_PATH/.testing/testing.yml"
[ -f "$TESTING_YML" ] || { echo "❌ $TESTING_YML 不存在"; exit 1; }

# ─── 讀 schema v2 四必填欄位 ────────────────────────────────
SCHEMA_VERSION=$(yq -r '.schema_version // 1' "$TESTING_YML")
TARGET_URL=$(yq -r '.project.target_url // ""' "$TESTING_YML")
LOCAL_PATH=$(yq -r '.project.local_path // ""' "$TESTING_YML")
PHP_VERSION=$(yq -r '.project.php_version // "8.1"' "$TESTING_YML")

# v1 back-compat：若 testing.yml 沒寫 local_path，fallback 到 registry 的 path
if [ -z "$LOCAL_PATH" ] || [ "$LOCAL_PATH" = "null" ]; then
    LOCAL_PATH="$REG_PATH"
    [ "$SCHEMA_VERSION" = "1" ] && echo "  ℹ️  schema v1 偵測到，local_path 從 registry 補上：$LOCAL_PATH"
fi
# 再次檢查：設為空字串表示「只跑網路測試」
if [ -z "$LOCAL_PATH" ] || [ "$LOCAL_PATH" = '""' ]; then
    PROJECT_PATH=""
    LOCAL_MODE=false
else
    PROJECT_PATH="$LOCAL_PATH"
    [ -d "$PROJECT_PATH" ] || { echo "❌ local_path 不存在：$PROJECT_PATH"; exit 1; }
    LOCAL_MODE=true
fi

[ -n "$TARGET_URL" ] || { echo "❌ testing.yml 必填：project.target_url"; exit 1; }

# ─── 載入專案 .env（若有）────────────────────────────────────
PROJECT_ENV=""
if [ -n "$PROJECT_PATH" ] && [ -f "$PROJECT_PATH/.testing/.env" ]; then
    PROJECT_ENV="$PROJECT_PATH/.testing/.env"
    echo "  ✓ 載入 env：$PROJECT_ENV"
    set -a
    # shellcheck disable=SC1090
    source "$PROJECT_ENV"
    set +a
fi

export TARGET_URL PROJECT_NAME="$NAME"

# ─── reports 目錄（raw/ 放原始輸出）─────────────────────────
REPORTS_DIR="$ROOT/reports/$NAME"
REPORTS_RAW="$REPORTS_DIR/raw"
mkdir -p "$REPORTS_RAW"

# Docker 內部看到的 raw 路徑（所有工具寫這裡）
export REPORTS_RAW_DIR="$REPORTS_RAW"

echo "╔══════════════════════════════════════════════════╗"
echo "║  專案測試：$NAME"
echo "║  目標：    $TARGET_URL"
if $LOCAL_MODE; then
    echo "║  本地：    $PROJECT_PATH"
else
    echo "║  本地：    （未設定 → 只跑 URL-based 測試）"
fi
echo "║  PHP：     $PHP_VERSION"
echo "║  範圍：    $SCOPE"
echo "║  報告：    $REPORTS_DIR/"
echo "╚══════════════════════════════════════════════════╝"

# ─── 開關判斷：自動偵測 or 讀 testing.yml 覆寫 ───────────────
# 傳回：0=執行、1=略過
enabled() {
    local t="$1"
    local ov
    ov=$(yq -r ".tests.${t}.enabled // \"auto\"" "$TESTING_YML")
    case "$ov" in
        true)  return 0 ;;
        false) return 1 ;;
    esac
    # auto
    case "$t" in
        ssl)      [[ "$TARGET_URL" == https://* ]] ;;
        security) true ;;
        stress)   true ;;
        static)
            $LOCAL_MODE || return 1
            find "$PROJECT_PATH" -maxdepth 4 -name "*.php" \
                -not -path "*/vendor/*" -not -path "*/node_modules/*" \
                -not -path "*/.testing/*" -not -path "*/.git/*" 2>/dev/null \
                | head -1 | grep -q .
            ;;
        unit)
            $LOCAL_MODE && [ -f "$PROJECT_PATH/.testing/unit/phpunit.xml" ]
            ;;
        e2e)
            $LOCAL_MODE && [ -f "$PROJECT_PATH/.testing/e2e/package.json" ]
            ;;
        nuclei)     true ;;
        lighthouse) true ;;
        monkey)     true ;;
        trivy)      $LOCAL_MODE ;;
        links)      true ;;
    esac
}

# ─── 搬移工具原始輸出 → raw/ ────
move_report() {
    local glob="$1"
    # shellcheck disable=SC2086
    for f in $ROOT/reports/$glob; do
        [ -e "$f" ] || continue
        mv "$f" "$REPORTS_RAW/"
    done
}

# ─── testssl 歷史輪替（只留最近 3 份）────
prune_testssl() {
    local keep=3
    ls -1t "$REPORTS_RAW"/testssl-*.html 2>/dev/null | tail -n +$((keep+1)) | xargs -r rm -f
    ls -1t "$REPORTS_RAW"/testssl-*.json 2>/dev/null | tail -n +$((keep+1)) | xargs -r rm -f
}

# ─── 測試 1：SSL/TLS ───
run_ssl() {
    enabled ssl || { echo "⏭  SSL：略過"; return 0; }
    echo ""
    echo "▶ SSL/TLS 檢測 (testssl.sh)"
    echo "──────────────────────────────────────────"
    docker compose --profile ssl up --build --abort-on-container-exit || echo "  (testssl 結束碼 $?)"
    move_report 'testssl-*.html'
    move_report 'testssl-*.json'
    prune_testssl
}

# ─── 測試 2：OWASP ZAP ───
run_security() {
    enabled security || { echo "⏭  Security：略過"; return 0; }
    echo ""
    echo "▶ 資安掃描 (OWASP ZAP)"
    echo "──────────────────────────────────────────"
    docker compose --profile security up --abort-on-container-exit || echo "  (zap 結束碼 $?；2=發現警告)"
    move_report 'zap-report.html'
    move_report 'zap-report.json'
}

# ─── 測試 3：k6 壓力 ───
run_stress() {
    enabled stress || { echo "⏭  Stress：略過"; return 0; }
    echo ""
    echo "▶ 壓力測試 (k6)"
    echo "──────────────────────────────────────────"
    K6_VUS=$(yq -r '.tests.stress.vus // 10' "$TESTING_YML")
    K6_DURATION=$(yq -r '.tests.stress.duration // "30s"' "$TESTING_YML")
    export K6_VUS K6_DURATION
    docker compose --profile stress up --abort-on-container-exit || echo "  (k6 結束碼 $?)"
    move_report 'k6-*.json'
}

# ─── 測試 4：PHPStan ───
run_static() {
    enabled static || { echo "⏭  Static：略過"; return 0; }
    echo ""
    echo "▶ 靜態分析 (PHPStan)"
    echo "──────────────────────────────────────────"
    local level config
    level=$(yq -r '.tests.static.level // 5' "$TESTING_YML")
    config="$ROOT/tests/static/phpstan.neon.dist"
    if [ -f "$PROJECT_PATH/.testing/static/phpstan.neon" ]; then
        config="$PROJECT_PATH/.testing/static/phpstan.neon"
        echo "  專案客製設定：$config"
    fi
    local env_args=()
    [ -n "$PROJECT_ENV" ] && env_args=(--env-file="$PROJECT_ENV")
    docker run --rm "${env_args[@]}" \
        -v "$PROJECT_PATH:/project:ro" \
        -v "$config:/phpstan.neon:ro" \
        -v "$REPORTS_RAW:/reports" \
        -w /project \
        ghcr.io/phpstan/phpstan:latest \
        analyse --level="$level" \
                --configuration=/phpstan.neon \
                --error-format=json \
                --no-progress \
        > "$REPORTS_RAW/phpstan.json" || true
    echo "  報告：$REPORTS_RAW/phpstan.json"
}

# ─── 測試 DB 生命週期：啟動 / 停止 test-mysql ────
DB_NET="atp-test-net"

start_test_db() {
    echo "  ▶ 啟動測試 DB（mysql:8.0, tmpfs）..."
    docker compose --profile unit-db up -d test-mysql
    # 等到 root 認證真的 ready（healthcheck 會在 socket 開啟時就 pass，但
    # MYSQL_ROOT_PASSWORD 的 user 初始化稍晚完成，用真實 SELECT 驗證才可靠）
    local tries=45
    until docker compose exec -T test-mysql mysql -uroot -ptest -e "SELECT 1" >/dev/null 2>&1; do
        tries=$((tries-1))
        [ $tries -le 0 ] && { echo "  ❌ test-mysql auth timeout"; return 1; }
        sleep 1
    done
    echo "  ✓ test-mysql ready（auth OK）"
    # 載入 schema（若專案有 database/init.sql）
    if [ -f "$PROJECT_PATH/database/init.sql" ]; then
        echo "  載入 schema：database/init.sql"
        docker compose exec -T test-mysql mysql -uroot -ptest test < "$PROJECT_PATH/database/init.sql" || echo "  (init.sql 載入有警告)"
    fi
    # 載入 fixtures（.testing/unit/fixtures/*.sql）
    local loaded=0
    for f in "$PROJECT_PATH/.testing/unit/fixtures"/*.sql; do
        [ -e "$f" ] || continue
        echo "  載入 fixture：$(basename "$f")"
        docker compose exec -T test-mysql mysql -uroot -ptest test < "$f"
        loaded=$((loaded+1))
    done
    if [ $loaded -eq 0 ]; then
        echo "  （無 fixtures 檔）"
    fi
}

stop_test_db() {
    echo "  ▶ 關閉測試 DB..."
    docker compose --profile unit-db down -v >/dev/null 2>&1 || true
}

# ─── 測試 5：PHPUnit（可選 DB）────
run_unit() {
    enabled unit || { echo "⏭  Unit：略過（無 .testing/unit/phpunit.xml）"; return 0; }
    echo ""
    echo "▶ 單元測試 (PHPUnit + pcov)"
    echo "──────────────────────────────────────────"
    local image="testing-pipeline-phpunit:php${PHP_VERSION}"
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        echo "  首次建置 $image..."
        docker build --build-arg PHP_VERSION="$PHP_VERSION" -t "$image" "$ROOT/tests/unit/"
    fi

    # 偵測是否要 DB：有 fixtures 或 testing.yml 明示
    local use_db=false
    if ls "$PROJECT_PATH/.testing/unit/fixtures"/*.sql >/dev/null 2>&1; then
        use_db=true
    fi
    local db_ov
    db_ov=$(yq -r '.tests.unit.use_db // ""' "$TESTING_YML")
    [ "$db_ov" = "true" ]  && use_db=true
    [ "$db_ov" = "false" ] && use_db=false

    local db_args=()
    local env_args=()
    [ -n "$PROJECT_ENV" ] && env_args=(--env-file="$PROJECT_ENV")

    if $use_db; then
        start_test_db
        db_args=(
            --network="$DB_NET"
            -e TEST_DB_HOST=test-mysql
            -e TEST_DB_PORT=3306
            -e TEST_DB_NAME=test
            -e TEST_DB_USER=root
            -e TEST_DB_PASSWORD=test
        )
    fi

    docker run --rm "${env_args[@]}" "${db_args[@]}" \
        -v "$PROJECT_PATH:/project" \
        -v "$REPORTS_RAW:/reports" \
        "$image" \
            --log-junit=/reports/phpunit.xml \
            --coverage-html=/reports/coverage \
            --coverage-clover=/reports/phpunit-clover.xml \
            --coverage-text=/reports/phpunit-coverage.txt \
        || echo "  (phpunit 結束碼 $?)"

    $use_db && stop_test_db

    echo "  報告：$REPORTS_RAW/phpunit.xml、$REPORTS_RAW/coverage/index.html"
}

# ─── 測試 6：Playwright E2E ───
run_e2e() {
    enabled e2e || { echo "⏭  E2E：略過（無 .testing/e2e/package.json）"; return 0; }
    echo ""
    echo "▶ E2E 測試 (Playwright)"
    echo "──────────────────────────────────────────"
    local env_args=()
    [ -n "$PROJECT_ENV" ] && env_args=(--env-file="$PROJECT_ENV")
    docker run --rm "${env_args[@]}" \
        -e TARGET_URL="$TARGET_URL" \
        -v "$PROJECT_PATH/.testing/e2e:/e2e" \
        -v "$REPORTS_RAW:/reports" \
        -w /e2e \
        mcr.microsoft.com/playwright:v1.52.0-noble \
        sh -c '
            if [ -f package-lock.json ]; then
                npm ci --no-audit --no-fund
            else
                npm install --no-audit --no-fund
            fi && \
            npx playwright test
        ' \
        || echo "  (playwright 結束碼 $?)"
    echo "  報告：$REPORTS_RAW/playwright/index.html"
}

# ─── 測試 7：Nuclei（深層資安）────
run_nuclei() {
    enabled nuclei || { echo "⏭  Nuclei：略過"; return 0; }
    echo ""
    echo "▶ 深層資安掃描 (Nuclei)"
    echo "──────────────────────────────────────────"
    NUCLEI_SEVERITY=$(yq -r '.tests.nuclei.severity // "critical,high,medium"' "$TESTING_YML")
    NUCLEI_RATE_LIMIT=$(yq -r '.tests.nuclei.rate_limit // 50' "$TESTING_YML")
    export NUCLEI_SEVERITY NUCLEI_RATE_LIMIT
    rm -f "$ROOT/reports/nuclei.jsonl" 2>/dev/null || true
    docker compose --profile nuclei up --abort-on-container-exit || echo "  (nuclei 結束碼 $?)"
    move_report 'nuclei.jsonl'
    echo "  報告：$REPORTS_RAW/nuclei.jsonl"
}

# ─── 測試 8：Lighthouse（前端品質）────
run_lighthouse() {
    enabled lighthouse || { echo "⏭  Lighthouse：略過"; return 0; }
    echo ""
    echo "▶ 前端品質檢測 (Lighthouse)"
    echo "──────────────────────────────────────────"
    local pages
    pages=$(yq -r '(.tests.lighthouse.pages // ["/"]) | join(" ")' "$TESTING_YML")
    LIGHTHOUSE_PAGES="$pages"
    LIGHTHOUSE_PRESET=$(yq -r '.tests.lighthouse.preset // "desktop"' "$TESTING_YML")
    export LIGHTHOUSE_PAGES LIGHTHOUSE_PRESET
    # 清理舊 lighthouse 報告（只留本次）
    rm -f "$ROOT/reports"/lighthouse-*.report.* "$ROOT/reports/lighthouse-manifest.json" 2>/dev/null || true
    docker compose --profile lighthouse up --build --abort-on-container-exit || echo "  (lighthouse 結束碼 $?)"
    move_report 'lighthouse-*.report.html'
    move_report 'lighthouse-*.report.json'
    move_report 'lighthouse-manifest.json'
    echo "  報告：$REPORTS_RAW/lighthouse-manifest.json"
}

# ─── 測試 9：Monkey（Gremlins.js via Playwright）────
run_monkey() {
    enabled monkey || { echo "⏭  Monkey：略過"; return 0; }
    echo ""
    echo "▶ 互動探測 (Monkey — Gremlins.js)"
    echo "──────────────────────────────────────────"
    local pages attacks delay
    pages=$(yq -r '(.tests.monkey.pages // ["/"]) | join(",")' "$TESTING_YML")
    attacks=$(yq -r '.tests.monkey.attacks // 500' "$TESTING_YML")
    delay=$(yq -r '.tests.monkey.delay_ms // 10' "$TESTING_YML")
    local env_args=()
    [ -n "$PROJECT_ENV" ] && env_args=(--env-file="$PROJECT_ENV")
    # 清舊報告
    rm -f "$ROOT/reports/monkey-report.json" 2>/dev/null || true
    rm -rf "$ROOT/reports/monkey-html" 2>/dev/null || true
    docker run --rm "${env_args[@]}" \
        -e TARGET_URL="$TARGET_URL" \
        -e MONKEY_PAGES="$pages" \
        -e MONKEY_ATTACKS="$attacks" \
        -e MONKEY_DELAY_MS="$delay" \
        -v "$ROOT/tests/monkey:/monkey" \
        -v "$ROOT/reports:/reports" \
        -w /monkey \
        mcr.microsoft.com/playwright:v1.52.0-noble \
        sh -c '
            if [ -f package-lock.json ]; then
                npm ci --no-audit --no-fund
            else
                npm install --no-audit --no-fund
            fi && \
            npx playwright test
        ' \
        || echo "  (monkey 結束碼 $?)"
    move_report 'monkey-report.json'
    # monkey-html 是目錄，需另外搬
    if [ -d "$ROOT/reports/monkey-html" ]; then
        rm -rf "$REPORTS_RAW/monkey-html"
        mv "$ROOT/reports/monkey-html" "$REPORTS_RAW/"
    fi
    echo "  報告：$REPORTS_RAW/monkey-report.json、$REPORTS_RAW/monkey-html/index.html"
}

# ─── 測試 10：Trivy（供應鏈）────
run_trivy() {
    enabled trivy || { echo "⏭  Trivy：略過（需 local_path）"; return 0; }
    echo ""
    echo "▶ 供應鏈掃描 (Trivy fs)"
    echo "──────────────────────────────────────────"
    local severity scanners
    severity=$(yq -r '.tests.trivy.severity // "CRITICAL,HIGH,MEDIUM"' "$TESTING_YML")
    scanners=$(yq -r '.tests.trivy.scanners // "vuln,secret,misconfig"' "$TESTING_YML")
    # trivy 快取：避免每次重下 CVE DB
    local cache_vol="atp-trivy-cache"
    docker volume create "$cache_vol" >/dev/null 2>&1 || true
    docker run --rm \
        -v "$PROJECT_PATH:/src:ro" \
        -v "$REPORTS_RAW:/reports" \
        -v "${cache_vol}:/root/.cache/trivy" \
        aquasec/trivy:latest \
        fs /src \
            --scanners "$scanners" \
            --severity "$severity" \
            --format json \
            --output /reports/trivy-fs.json \
            --quiet \
        || echo "  (trivy 結束碼 $?)"
    echo "  報告：$REPORTS_RAW/trivy-fs.json"
}

# ─── 測試 11：Lychee（壞連結）────
run_links() {
    enabled links || { echo "⏭  Links：略過"; return 0; }
    echo ""
    echo "▶ 連結檢查 (Lychee)"
    echo "──────────────────────────────────────────"
    LYCHEE_TIMEOUT=$(yq -r '.tests.links.timeout // 15' "$TESTING_YML")
    LYCHEE_MAX_CONCURRENCY=$(yq -r '.tests.links.max_concurrency // 4' "$TESTING_YML")
    export LYCHEE_TIMEOUT LYCHEE_MAX_CONCURRENCY
    rm -f "$ROOT/reports/lychee.json" 2>/dev/null || true
    docker compose --profile links up --abort-on-container-exit || echo "  (lychee 結束碼 $?)"
    move_report 'lychee.json'
    echo "  報告：$REPORTS_RAW/lychee.json"
}

# ─── 產生評分卡 ────
run_summary() {
    echo ""
    echo "▶ 產生統一報告 (summarize.js)"
    echo "──────────────────────────────────────────"
    node "$ROOT/scripts/summarize.js" "$NAME"
}

# ─── Dispatch ────
case "$SCOPE" in
    all)
        run_ssl
        run_static
        run_trivy
        run_security
        run_nuclei
        run_stress
        run_lighthouse
        run_links
        run_unit
        run_e2e
        run_monkey
        run_summary
        ;;
    ssl)        run_ssl ;;
    security)   run_security ;;
    stress)     run_stress ;;
    static)     run_static ;;
    unit)       run_unit ;;
    e2e)        run_e2e ;;
    nuclei)     run_nuclei ;;
    lighthouse) run_lighthouse ;;
    monkey)     run_monkey ;;
    trivy)      run_trivy ;;
    links)      run_links ;;
    summary)    run_summary ;;
    *)
        echo "❌ 未知 scope：$SCOPE"
        echo "   可用：all | ssl | security | stress | static | unit | e2e | nuclei | lighthouse | monkey | trivy | links | summary"
        exit 1
        ;;
esac

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  測試完成"
echo "║  統一報告：$REPORTS_DIR/report.md"
echo "╚══════════════════════════════════════════════════╝"
