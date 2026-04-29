#!/bin/bash
# ════════════════════════════════════════════════════════════════
# run-project.sh — 對指定專案執行測試（schema v2）
#
# 用法：
#   bash scripts/run-project.sh <name> [scope]
#
# scope:
#   all (預設) | ssl | security | stress | static | e2e
#   nuclei | lighthouse | monkey | trivy | links | precheck | summary
#
# all 的執行序（直線；日後改平行仍沿用此編號／命名）：
#   02 Precheck → 03 Static → 05 Lychee → 06 SSL → 07 Trivy
#   → 08 Lighthouse → 09 E2E → 10 Nuclei → 11 ZAP → 12 Load → 13 Monkey
#   → 14–16 Report（summarize.js）
#
# 設計原則：
#   - testing.yml 只需 4 個必填欄位（name / target_url / local_path / php_version）
#   - 其他測試開關走自動偵測，testing.yml 只寫「要覆寫」的部分
#   - local_path 為空 → 只跑 URL-based 測試（ssl/security/stress）
#   - 單元測試由各專案自行管理（不歸 pipeline 跑）
#   - 原始工具輸出放 reports/<name>/raw/；summarize.js 會產生統一 report.md
# ════════════════════════════════════════════════════════════════
set -euo pipefail

NAME="${1:-}"
SCOPE="${2:-all}"

if [ -z "$NAME" ]; then
    echo "用法：bash scripts/run-project.sh <name> [scope]"
    echo ""
    echo "scope 可以是："
    echo "  Preset：all | remote-only | local-only"
    echo "  單一：  precheck | ssl | security | stress | static | e2e"
    echo "          api-test | auth-test | visual-test | browser-compat"
    echo "          nuclei | lighthouse | monkey | trivy | links | summary"
    echo "  多選：  以逗號分隔，例如 ssl,e2e,lighthouse"
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
# WARNINGS[]：收集所有前置檢查與 skip 訊息；收尾寫到 reports/<name>/warnings.txt
WARNINGS=()

# 再次檢查：設為空字串表示「只跑網路測試」
if [ -z "$LOCAL_PATH" ] || [ "$LOCAL_PATH" = '""' ]; then
    PROJECT_PATH=""
    LOCAL_MODE=false
else
    PROJECT_PATH="$LOCAL_PATH"
    if [ ! -d "$PROJECT_PATH" ]; then
        echo "⚠️  local_path 不存在：$PROJECT_PATH → 降級為 URL-only 模式（skip static/trivy）"
        WARNINGS+=("local_path 不存在：$PROJECT_PATH → 跳過 static/trivy")
        PROJECT_PATH=""
        LOCAL_MODE=false
    else
        LOCAL_MODE=true
    fi
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

# ─── 合併 n8n precheck 階段寫進來的 warnings（若有）──
if [ -f "$REPORTS_DIR/n8n-precheck-warnings.txt" ]; then
    while IFS= read -r line; do
        [ -n "$line" ] && WARNINGS+=("$line")
    done < "$REPORTS_DIR/n8n-precheck-warnings.txt"
    # 讀完就刪，避免下次殘留
    rm -f "$REPORTS_DIR/n8n-precheck-warnings.txt"
fi

# Docker 內部看到的 raw 路徑（所有工具寫這裡）
export REPORTS_RAW_DIR="$REPORTS_RAW"

# ─── 報告輪替：每次開跑前把超過 REPORTS_KEEP_DAYS 天的舊報告打包進 archive/
#     關閉方式：REPORTS_KEEP_DAYS=0（或 export REPORTS_NO_ROTATE=1）
if [ "${REPORTS_NO_ROTATE:-0}" != "1" ] && [ -x "$ROOT/scripts/rotate-reports.sh" ]; then
    bash "$ROOT/scripts/rotate-reports.sh" "$NAME" "${REPORTS_KEEP_DAYS:-30}" || true
fi

echo "╔══════════════════════════════════════════════════╗"
echo "║  01 Init - Set Project Vars"
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
# 副作用：略過時 append 一條有可讀原因的 warning 到 WARNINGS[]
enabled() {
    local t="$1"
    local ov
    ov=$(yq -r ".tests.${t}.enabled // \"auto\"" "$TESTING_YML")
    case "$ov" in
        true)  return 0 ;;
        false)
            WARNINGS+=("$t：testing.yml 關閉（tests.$t.enabled=false）")
            return 1
            ;;
    esac
    # auto
    case "$t" in
        ssl)
            if [[ "$TARGET_URL" == https://* ]]; then
                return 0
            else
                WARNINGS+=("ssl：target_url 非 https，跳過 SSL 掃描")
                return 1
            fi
            ;;
        security)   return 0 ;;
        stress)     return 0 ;;
        static)
            if ! $LOCAL_MODE; then
                WARNINGS+=("static：local_path 未設/不存在，跳過 PHPStan")
                return 1
            fi
            if find "$PROJECT_PATH" -maxdepth 4 -name "*.php" \
                -not -path "*/vendor/*" -not -path "*/node_modules/*" \
                -not -path "*/.testing/*" -not -path "*/.git/*" 2>/dev/null \
                | head -1 | grep -q .; then
                return 0
            else
                WARNINGS+=("static：未偵測到 PHP 檔，跳過 PHPStan")
                return 1
            fi
            ;;
        e2e)
            if ! $LOCAL_MODE; then
                WARNINGS+=("e2e：local_path 未設/不存在，跳過 Playwright")
                return 1
            fi
            if [ ! -f "$PROJECT_PATH/.testing/e2e/package.json" ]; then
                WARNINGS+=("e2e：未偵測到 .testing/e2e/package.json，跳過 Playwright")
                return 1
            fi
            return 0
            ;;
        nuclei)     return 0 ;;
        lighthouse) return 0 ;;
        monkey)     return 0 ;;
        trivy)
            if ! $LOCAL_MODE; then
                WARNINGS+=("trivy：local_path 未設/不存在，跳過 Trivy")
                return 1
            fi
            return 0
            ;;
        links)      return 0 ;;
        api-test)
            # 防護機制：API 測試是「按需」啟用，不是每個系統都有 API 可測。
            # 偵測順序：① 現成 collection → ② 從 OpenAPI 自動產 collection → ③ 都沒有就靜靜跳過
            API_OPENAPI_RESOLVED=""
            # ① 專案已備好 Postman collection
            if [ -n "$PROJECT_PATH" ] && \
               ls "$PROJECT_PATH/.testing/api/collections/"*.postman_collection.json >/dev/null 2>&1; then
                if [ -z "${ADMIN_USERNAME:-}" ] || [ -z "${ADMIN_PASSWORD:-}" ]; then
                    WARNINGS+=("api-test：ADMIN_USERNAME/PASSWORD 未提供，API/Auth 測試身分可能不完整")
                fi
                return 0
            fi
            # ② testing.yml 指定 OpenAPI 路徑（絕對 or 相對 local_path）
            local openapi_yml
            openapi_yml=$(yq -r '.tests.api-test.openapi // ""' "$TESTING_YML")
            if [ -n "$openapi_yml" ] && [ "$openapi_yml" != "null" ]; then
                if [[ "$openapi_yml" != /* ]] && [ -n "$PROJECT_PATH" ]; then
                    openapi_yml="$PROJECT_PATH/$openapi_yml"
                fi
                if [ -f "$openapi_yml" ]; then
                    API_OPENAPI_RESOLVED="$openapi_yml"
                else
                    WARNINGS+=("api-test：testing.yml 指定的 openapi 路徑不存在：$openapi_yml → 跳過")
                    return 1
                fi
            fi
            # ③ 自動偵測 .testing/api/openapi.{yaml,yml,json}
            if [ -z "$API_OPENAPI_RESOLVED" ] && [ -n "$PROJECT_PATH" ]; then
                for ext in yaml yml json; do
                    if [ -f "$PROJECT_PATH/.testing/api/openapi.$ext" ]; then
                        API_OPENAPI_RESOLVED="$PROJECT_PATH/.testing/api/openapi.$ext"
                        break
                    fi
                done
            fi
            # 都沒有 → 安靜跳過（不是錯誤；不是每個系統都需要 API 測試）
            if [ -z "$API_OPENAPI_RESOLVED" ]; then
                WARNINGS+=("api-test：未提供 Postman collection 也未提供 OpenAPI 規格 → 跳過 API 測試")
                return 1
            fi
            if [ -z "${ADMIN_USERNAME:-}" ] || [ -z "${ADMIN_PASSWORD:-}" ]; then
                WARNINGS+=("api-test：ADMIN_USERNAME/PASSWORD 未提供，API/Auth 測試身分可能不完整")
            fi
            export API_OPENAPI_RESOLVED
            return 0
            ;;
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

# ─── 06 Security - SSL Scan ───
run_ssl() {
    enabled ssl || { echo "⏭  06 Security - SSL Scan：略過"; return 0; }
    echo ""
    echo "▶ 06 Security - SSL Scan (testssl.sh)"
    echo "──────────────────────────────────────────"
    docker compose --profile ssl up --build --abort-on-container-exit || echo "  (testssl 結束碼 $?)"
    move_report 'testssl-*.html'
    move_report 'testssl-*.json'
    prune_testssl
}

# ─── 11 Security - ZAP ───
run_security() {
    enabled security || { echo "⏭  11 Security - ZAP：略過"; return 0; }
    echo ""
    echo "▶ 11 Security - ZAP (OWASP ZAP)"
    echo "──────────────────────────────────────────"
    docker compose --profile security up --abort-on-container-exit || echo "  (zap 結束碼 $?；2=發現警告)"
    move_report 'zap-report.html'
    move_report 'zap-report.json'
}

# ─── 12 Performance - Load Test ───
run_stress() {
    enabled stress || { echo "⏭  12 Performance - Load Test：略過"; return 0; }
    echo ""
    echo "▶ 12 Performance - Load Test (k6)"
    echo "──────────────────────────────────────────"
    K6_VUS=$(yq -r '.tests.stress.vus // 10' "$TESTING_YML")
    K6_DURATION=$(yq -r '.tests.stress.duration // "30s"' "$TESTING_YML")
    export K6_VUS K6_DURATION
    docker compose --profile stress up --abort-on-container-exit || echo "  (k6 結束碼 $?)"
    move_report 'k6-*.json'
}

# ─── 03 Code - Static Analysis ───
run_static() {
    enabled static || { echo "⏭  03 Code - Static Analysis：略過"; return 0; }
    echo ""
    echo "▶ 03 Code - Static Analysis (PHPStan)"
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

# ─── 09 Web - E2E Tests ───
run_e2e() {
    enabled e2e || { echo "⏭  09 Web - E2E Tests：略過（無 .testing/e2e/package.json）"; return 0; }
    echo ""
    echo "▶ 09 Web - E2E Tests (Playwright)"
    echo "──────────────────────────────────────────"
    local env_args=()
    [ -n "$PROJECT_ENV" ] && env_args=(--env-file="$PROJECT_ENV")
    docker run --rm "${env_args[@]}" \
        -e TARGET_URL="$TARGET_URL" \
        -v "$PROJECT_PATH/.testing/e2e:/e2e" \
        -v "$REPORTS_RAW:/reports" \
        -w /e2e \
        mcr.microsoft.com/playwright:v1.59.1-noble \
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

# ─── 10 Security - Nuclei ───
run_nuclei() {
    enabled nuclei || { echo "⏭  10 Security - Nuclei：略過"; return 0; }
    echo ""
    echo "▶ 10 Security - Nuclei (Nuclei)"
    echo "──────────────────────────────────────────"
    NUCLEI_SEVERITY=$(yq -r '.tests.nuclei.severity // "critical,high,medium"' "$TESTING_YML")
    NUCLEI_RATE_LIMIT=$(yq -r '.tests.nuclei.rate_limit // 50' "$TESTING_YML")
    export NUCLEI_SEVERITY NUCLEI_RATE_LIMIT
    rm -f "$ROOT/reports/nuclei.jsonl" 2>/dev/null || true
    docker compose --profile nuclei up --abort-on-container-exit || echo "  (nuclei 結束碼 $?)"
    move_report 'nuclei.jsonl'
    echo "  報告：$REPORTS_RAW/nuclei.jsonl"
}

# ─── 08 Web - Lighthouse ───
run_lighthouse() {
    enabled lighthouse || { echo "⏭  08 Web - Lighthouse：略過"; return 0; }
    echo ""
    echo "▶ 08 Web - Lighthouse (Lighthouse)"
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

# ─── 13 Chaos - Monkey ───
run_monkey() {
    enabled monkey || { echo "⏭  13 Chaos - Monkey：略過"; return 0; }
    echo ""
    echo "▶ 13 Chaos - Monkey (Gremlins.js / Playwright)"
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
        mcr.microsoft.com/playwright:v1.59.1-noble \
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

# ─── 07 Security - Trivy ───
run_trivy() {
    enabled trivy || { echo "⏭  07 Security - Trivy：略過（需 local_path）"; return 0; }
    echo ""
    echo "▶ 07 Security - Trivy (Trivy fs)"
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

# ─── 05 Web - Link Check (Lychee) ───
run_links() {
    enabled links || { echo "⏭  05 Web - Link Check (Lychee)：略過"; return 0; }
    echo ""
    echo "▶ 05 Web - Link Check (Lychee)"
    echo "──────────────────────────────────────────"
    LYCHEE_TIMEOUT=$(yq -r '.tests.links.timeout // 15' "$TESTING_YML")
    LYCHEE_MAX_CONCURRENCY=$(yq -r '.tests.links.max_concurrency // 4' "$TESTING_YML")
    export LYCHEE_TIMEOUT LYCHEE_MAX_CONCURRENCY
    rm -f "$ROOT/reports/lychee.json" 2>/dev/null || true
    docker compose --profile links up --abort-on-container-exit || echo "  (lychee 結束碼 $?)"
    move_report 'lychee.json'
    echo "  報告：$REPORTS_RAW/lychee.json"
}

# ─── A3 / B6 API + Auth 測試（多身分迴圈）─────────────────
#   讀 .env 裡的 ADMIN_* / USER1_*..USER5_*，每個身分跑一輪
#   產出 newman-junit-admin.xml / newman-junit-user1-<label>.xml ...
#   全部 run 完後，最新一次會以 newman-junit.xml 名義存一份給 summarize.js 用
run_api_test() {
    enabled api-test || { echo "⏭  API / Auth 測試：略過（無 .testing/api/collections/*.json）"; return 0; }
    echo ""
    echo "▶ API / Auth 測試 (Newman, 多身分迴圈)"
    echo "──────────────────────────────────────────"

    # 尋找 collection：① 專案備好的 → ② 從 OpenAPI 即時轉換 → ③ pipeline 骨架（最後備援）
    local collection=""
    if [ -n "$PROJECT_PATH" ]; then
        collection=$(find "$PROJECT_PATH/.testing/api/collections" -name "*.postman_collection.json" 2>/dev/null | head -1 || echo "")
    fi

    if [ -z "$collection" ] && [ -n "${API_OPENAPI_RESOLVED:-}" ] && [ -f "$API_OPENAPI_RESOLVED" ]; then
        echo "  ▶ 偵測到 OpenAPI 規格 → 自動轉成 Postman collection"
        echo "    來源：$API_OPENAPI_RESOLVED"
        # 確保 newman + openapi-to-postmanv2 image 已建置
        if ! docker image inspect testing-pipeline-newman:latest >/dev/null 2>&1; then
            echo "    首次建置 testing-pipeline-newman..."
            bash "$ROOT/scripts/build-newman-image.sh" || true
        fi
        local gen_dir="$ROOT/.tmp-collections"
        mkdir -p "$gen_dir"
        local generated="$gen_dir/${NAME}.postman_collection.json"
        docker run --rm \
            -v "$API_OPENAPI_RESOLVED:/spec/openapi:ro" \
            -v "$gen_dir:/out" \
            --entrypoint /workspace/convert-openapi.sh \
            testing-pipeline-newman:latest \
            /spec/openapi /out/${NAME}.postman_collection.json \
            || { echo "  ❌ OpenAPI 轉換失敗，略過 API 測試"; return 0; }
        if [ -s "$generated" ]; then
            collection="$generated"
            echo "    產出：$collection"
        fi
    fi

    if [ -z "$collection" ]; then
        collection=$(find "$ROOT/tests/api/collections" -name "*.postman_collection.json" 2>/dev/null | head -1 || echo "")
    fi
    if [ -z "$collection" ] || [ ! -f "$collection" ]; then
        echo "  ⚠️  未找到 Postman collection，略過"
        return 0
    fi
    echo "  Collection：$collection"

    # 舊清單：跑前先砍掉上次殘留（避免 summarize.js 撿到舊檔）
    rm -f "$REPORTS_RAW"/newman-junit-*.xml \
          "$REPORTS_RAW"/newman-*.json      \
          "$REPORTS_RAW"/newman-junit.xml   \
          "$REPORTS_RAW"/newman.json 2>/dev/null || true

    local env_args=()
    [ -n "$PROJECT_ENV" ] && env_args=(--env-file="$PROJECT_ENV")

    # 身分清單：admin + user1..user5
    local identities=(admin user1 user2 user3 user4 user5)
    local ran=0 skipped=0

    for id in "${identities[@]}"; do
        local upper user_var pass_var label_var u p l
        upper=$(echo "$id" | tr '[:lower:]' '[:upper:]')   # admin → ADMIN
        user_var="${upper}_USERNAME"
        pass_var="${upper}_PASSWORD"
        label_var="${upper}_LABEL"
        u="${!user_var:-}"
        p="${!pass_var:-}"
        l="${!label_var:-}"

        if [ -z "$u" ] || [ -z "$p" ]; then
            echo "  ⏭  身分 $id：帳密未填，略過"
            skipped=$((skipped+1))
            continue
        fi

        echo ""
        echo "  ── 身分 $id${l:+ ($l)} ──"
        docker run --rm "${env_args[@]}" \
            -e TARGET_URL="$TARGET_URL" \
            -e REPORTS_RAW_DIR=/reports \
            -e CURRENT_IDENTITY="$id" \
            -e CURRENT_USERNAME="$u" \
            -e CURRENT_PASSWORD="$p" \
            -e CURRENT_LABEL="$l" \
            -e COLLECTION_PATH=/workspace/collection.json \
            -v "$collection:/workspace/collection.json:ro" \
            -v "$REPORTS_RAW:/reports" \
            -w /workspace \
            "testing-pipeline-newman" \
            || echo "  (newman 結束碼 $?)"
        ran=$((ran+1))
    done

    echo ""
    echo "  身分統計：執行 $ran 輪、略過 $skipped 輪"
    echo "  報告：$REPORTS_RAW/newman-junit-*.xml（每個身分一份）"
}

# ─── C2 Visual Comparison - 視覺迴歸（Playwright --grep C2）───
# 若專案的 .testing/e2e/tests/ 沒有 visual.spec.ts，自動 mount pipeline 的通用版
run_visual_test() {
    enabled e2e || { echo "⏭  C2 Visual Comparison：略過（需 .testing/e2e/package.json）"; return 0; }
    echo ""
    echo "▶ C2 Visual Comparison (Playwright --grep C2)"
    echo "──────────────────────────────────────────"
    local env_args=()
    [ -n "$PROJECT_ENV" ] && env_args=(--env-file="$PROJECT_ENV")

    # 若專案自己沒有 visual.spec.ts，將 pipeline 的通用版以 read-only 疊進去
    local extra_mount=()
    if [ ! -s "$PROJECT_PATH/.testing/e2e/tests/visual.spec.ts" ]; then
        echo "  ℹ️  專案無 visual.spec.ts（或為空檔）→ 使用 pipeline 通用版"
        extra_mount=(-v "$ROOT/tests/e2e/tests/visual.spec.ts:/e2e/tests/visual.spec.ts:ro")
    fi

    docker run --rm "${env_args[@]}" "${extra_mount[@]}" \
        -e TARGET_URL="$TARGET_URL" \
        -v "$PROJECT_PATH/.testing/e2e:/e2e" \
        -v "$REPORTS_RAW:/reports" \
        -w /e2e \
        mcr.microsoft.com/playwright:v1.59.1-noble \
        sh -c '
            if [ -f package-lock.json ]; then
                npm ci --no-audit --no-fund
            else
                npm install --no-audit --no-fund
            fi && \
            npx playwright test --grep "C2"
        ' \
        || echo "  (playwright --grep C2 結束碼 $?)"
    echo "  報告：$REPORTS_RAW/playwright/index.html"
}

# ─── C3 Browser Compatibility - 瀏覽器相容（Playwright --grep C3）───
# 強制使用 pipeline 的 playwright.config.ts（有三瀏覽器 projects），
# 覆蓋專案自己的 config（通常只有 chromium）
run_browser_compat() {
    enabled e2e || { echo "⏭  C3 Browser Compatibility：略過（需 .testing/e2e/package.json）"; return 0; }
    echo ""
    echo "▶ C3 Browser Compatibility (Playwright --grep C3, 三瀏覽器)"
    echo "──────────────────────────────────────────"
    local env_args=()
    [ -n "$PROJECT_ENV" ] && env_args=(--env-file="$PROJECT_ENV")

    local extra_mount=()
    # 強制疊入 pipeline 的 playwright.config.ts（含 chromium/firefox/webkit）
    extra_mount+=(-v "$ROOT/tests/e2e/playwright.config.ts:/e2e/playwright.config.ts:ro")
    # 若專案自己沒有 visual.spec.ts，也疊入通用版
    if [ ! -s "$PROJECT_PATH/.testing/e2e/tests/visual.spec.ts" ]; then
        echo "  ℹ️  專案無 visual.spec.ts（或為空檔）→ 使用 pipeline 通用版"
        extra_mount+=(-v "$ROOT/tests/e2e/tests/visual.spec.ts:/e2e/tests/visual.spec.ts:ro")
    fi

    docker run --rm "${env_args[@]}" "${extra_mount[@]}" \
        -e TARGET_URL="$TARGET_URL" \
        -v "$PROJECT_PATH/.testing/e2e:/e2e" \
        -v "$REPORTS_RAW:/reports" \
        -w /e2e \
        mcr.microsoft.com/playwright:v1.59.1-noble \
        sh -c '
            if [ -f package-lock.json ]; then
                npm ci --no-audit --no-fund
            else
                npm install --no-audit --no-fund
            fi && \
            npx playwright test --grep "C3"
        ' \
        || echo "  (playwright --grep C3 結束碼 $?)"
    echo "  報告：$REPORTS_RAW/playwright/index.html"
}

# ─── 02 Precheck - Health Check（日後接 Gate 1：首頁 200/302）───
run_precheck() {
    echo ""
    echo "▶ 02 Precheck - Health Check"
    echo "──────────────────────────────────────────"
    if command -v curl >/dev/null 2>&1; then
        local code
        code=$(curl -sS -o /dev/null -w "%{http_code}" -L --max-time 20 "$TARGET_URL" || echo "000")
        echo "  GET $TARGET_URL → HTTP $code"
    else
        echo "  （宿主未安裝 curl，略過 URL 探測）"
    fi
}

# ─── 14–16 Report（summarize.js：彙整／解析／評分卡）───
run_summary() {
    echo ""
    echo "▶ 14 Report - Collect Results"
    echo "▶ 15 Report - Parse Results"
    echo "▶ 16 Report - Generate Scorecard"
    echo "──────────────────────────────────────────"
    node "$ROOT/scripts/summarize.js" "$NAME"
}

# ─── Preset 展開：ALL / REMOTE_ONLY / LOCAL_ONLY → 具體 scope 列表 ────
ALL_SCOPES="precheck,static,api-test,links,ssl,trivy,lighthouse,e2e,nuclei,security,stress,monkey,summary"
REMOTE_SCOPES="precheck,ssl,security,nuclei,stress,lighthouse,links,monkey,summary"
LOCAL_SCOPES="static,trivy,summary"

expand_preset() {
    case "$1" in
        all|ALL)                echo "$ALL_SCOPES" ;;
        remote-only|REMOTE_ONLY) echo "$REMOTE_SCOPES" ;;
        local-only|LOCAL_ONLY)   echo "$LOCAL_SCOPES" ;;
        *)                      echo "$1" ;;
    esac
}

# ─── 執行單一 scope ────
run_scope() {
    case "$1" in
        precheck)       run_precheck ;;
        ssl)            run_ssl ;;
        security)       run_security ;;
        stress)         run_stress ;;
        static)         run_static ;;
        e2e)            run_e2e ;;
        api-test)       run_api_test ;;
        auth-test)      run_api_test ;;        # B6：共用 A3 的 Newman collection
        visual-test)    run_visual_test ;;     # C2：Playwright --grep C2
        browser-compat) run_browser_compat ;;  # C3：Playwright --grep C3
        nuclei)         run_nuclei ;;
        lighthouse)     run_lighthouse ;;
        monkey)         run_monkey ;;
        trivy)          run_trivy ;;
        links)          run_links ;;
        summary)        run_summary ;;
        "")             : ;;  # 空字串忽略
        *)
            echo "⚠️  未知 scope，略過：$1"
            WARNINGS+=("未知 scope：$1")
            ;;
    esac
}

# ─── Dispatch：支援 preset / 單一 scope / 逗號分隔多 scope ────
EXPANDED=$(expand_preset "$SCOPE")
IFS=',' read -ra SCOPE_LIST <<< "$EXPANDED"

# 去重：保持第一次出現順序，避免重跑
declare -A SEEN
FINAL_SCOPES=()
for s in "${SCOPE_LIST[@]}"; do
    s_trim="$(echo "$s" | xargs)"  # 去前後空白
    [ -z "$s_trim" ] && continue
    if [ -z "${SEEN[$s_trim]:-}" ]; then
        SEEN[$s_trim]=1
        FINAL_SCOPES+=("$s_trim")
    fi
done

echo ""
echo "  解析 scopes：${FINAL_SCOPES[*]}"

for s in "${FINAL_SCOPES[@]}"; do
    run_scope "$s"
done

# 確保每次都產報告：若最後一項不是 summary，補跑一次
LAST_SCOPE="${FINAL_SCOPES[-1]:-}"
if [ "$LAST_SCOPE" != "summary" ] && [ ${#FINAL_SCOPES[@]} -gt 0 ]; then
    # 已跑過 summary 就不重跑
    if [ -z "${SEEN[summary]:-}" ]; then
        run_summary
    fi
fi

# ─── 寫出 warnings.txt（供 summarize.js 讀取）───
if [ ${#WARNINGS[@]} -gt 0 ]; then
    printf '%s\n' "${WARNINGS[@]}" > "$REPORTS_DIR/warnings.txt"
    echo ""
    echo "  ⚠️  ${#WARNINGS[@]} 條前置檢查警告 → $REPORTS_DIR/warnings.txt"
else
    rm -f "$REPORTS_DIR/warnings.txt" 2>/dev/null || true
fi

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  測試完成"
echo "║  統一報告：$REPORTS_DIR/report.md"
echo "╚══════════════════════════════════════════════════╝"
