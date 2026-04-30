#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Lighthouse CI — Core Web Vitals / 可及性 / 最佳實踐 / SEO
#
# ENV:
#   TARGET_URL                目標站（必填，結尾不帶 /）
#   LIGHTHOUSE_PAGES_JSON     JSON 陣列：[{"path":"/", "auth":false}, ...]
#                             auth=true 的頁會帶 TARGET_COOKIE 進去
#   LIGHTHOUSE_PAGES          舊格式 fallback：空白分隔的相對路徑
#                             （只有 LIGHTHOUSE_PAGES_JSON 沒給時才用）
#   LIGHTHOUSE_PRESET         desktop / mobile（預設 desktop）
#   TARGET_COOKIE             有的話，auth=true 的頁注入 Cookie 標頭
#
# 為什麼吃 JSON：舊版每頁只有 path 字串，無法表達「這頁要登入」。新版
# 改吃 JSON 物件陣列。run-project.sh 會把 testing.yml 的 pages 正規化
# 成 [{path, auth}] 形式（字串 → {path, auth:false}）。
#
# 輸出：
#   /reports/lighthouse-<n>-<slug>.report.json
#   /reports/lighthouse-<n>-<slug>.report.html
#   /reports/lighthouse-manifest.json    ★ summarize.js 解析這份
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

TARGET="${TARGET_URL:-https://example.com}"
TARGET="${TARGET%/}"
PRESET="${LIGHTHOUSE_PRESET:-desktop}"
REPORT_DIR="/reports"

mkdir -p "$REPORT_DIR"
rm -f "$REPORT_DIR"/lighthouse-*.report.* "$REPORT_DIR/lighthouse-manifest.json" 2>/dev/null || true

# ─── 把 PAGES_JSON 正規化成 path|auth 一行一頁的列表 ─────────
# 用 node 處理：bash 解析 JSON 太脆。輸出格式：每行 "path<TAB>auth"
PAGES_TSV=$(node -e '
  const json = process.env.LIGHTHOUSE_PAGES_JSON || "";
  let arr = [];
  if (json) {
    try { arr = JSON.parse(json); } catch (e) { console.error("PAGES_JSON parse fail:", e.message); }
  }
  if (!Array.isArray(arr) || !arr.length) {
    // fallback 到舊格式
    const legacy = (process.env.LIGHTHOUSE_PAGES || "/").trim().split(/\s+/);
    arr = legacy.map(p => ({ path: p, auth: false }));
  }
  for (const p of arr) {
    const path = (typeof p === "string") ? p : (p.path || "/");
    const auth = (typeof p === "object" && p && !!p.auth) ? "1" : "0";
    process.stdout.write(path + "\t" + auth + "\n");
  }
')

echo "════════════════════════════════════════════"
echo " Lighthouse 前端品質檢測"
echo " 目標：$TARGET"
echo " 預設：$PRESET"
echo " Cookie：$([ -n "${TARGET_COOKIE:-}" ] && echo '有（auth 頁會帶上）' || echo '無')"
echo "════════════════════════════════════════════"
echo "$PAGES_TSV" | grep -c $'\t' >/dev/null 2>&1 || { echo "  ⚠️  無頁面可掃"; exit 0; }

i=0
while IFS=$'\t' read -r page auth; do
    [ -z "$page" ] && continue
    i=$((i + 1))
    slug=$(echo "$page" | sed 's|[^A-Za-z0-9]|_|g; s|^_*||; s|_*$||')
    [ -z "$slug" ] && slug="home"
    slug=$(echo "$slug" | head -c 40)

    url="${TARGET}${page}"
    out_base="$REPORT_DIR/lighthouse-${i}-${slug}"

    auth_label=""
    extra_args=()
    if [ "$auth" = "1" ]; then
        auth_label=" 🔒"
        if [ -n "${TARGET_COOKIE:-}" ]; then
            extra_args=(--extra-headers "{\"Cookie\":\"${TARGET_COOKIE}\"}")
        else
            echo "  ⚠️  $page 標記 auth=true 但 TARGET_COOKIE 為空 → 此頁可能被導去登入頁"
        fi
    fi

    echo ""
    echo "[$i]${auth_label} $url"

    set +e
    lighthouse "$url" \
        --chrome-flags="$CHROME_FLAGS" \
        --preset="$PRESET" \
        --output=json \
        --output=html \
        --output-path="$out_base" \
        --only-categories=performance,accessibility,best-practices,seo \
        --quiet \
        --no-update-notifier \
        "${extra_args[@]}"
    rc=$?
    set -e
    if [ $rc -ne 0 ]; then
        echo "  (lighthouse 結束碼 $rc)"
    fi
done <<< "$PAGES_TSV"

# ─── 組 manifest.json（summarize.js 會讀）──────────────────
# 每頁額外帶 auth flag（從 PAGES_TSV 對應）讓 summarize 在報告標 🔒
# heredoc 用單引號版本（'NODE_EOF'）避免 bash 對 $ 反引號做插值；TSV 從 env 帶進去
export PAGES_TSV_INLINE="$PAGES_TSV"
node <<'NODE_EOF'
const fs = require('fs');
const path = require('path');
const dir = '/reports';

// 先把 path → auth 建表（從 env 帶進來的 TSV）
const authByPath = {};
const pagesTsv = process.env.PAGES_TSV_INLINE || '';
for (const ln of pagesTsv.split('\n')) {
    const [p, a] = ln.split('\t');
    if (p) authByPath[p] = a === '1';
}

const files = fs.readdirSync(dir)
    .filter(f => /^lighthouse-\d+-.*\.report\.json$/.test(f))
    .sort();

const manifest = [];
for (const f of files) {
    try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
        const cat = data.categories || {};
        const aud = data.audits || {};
        const pick = (k) => aud[k]?.numericValue ?? null;
        const url = data.finalDisplayedUrl || data.finalUrl || data.requestedUrl;
        let pathOnly = url;
        try {
            const u = new URL(url);
            pathOnly = u.pathname + (u.search || '');
        } catch {}
        // auth 比對：完整 path（含 query）或只比對 pathname
        const authMatch = !!authByPath[pathOnly] || !!authByPath[pathOnly.split('?')[0]];
        manifest.push({
            url,
            path: pathOnly,
            auth: authMatch,
            fetchTime: data.fetchTime,
            scores: {
                performance: Math.round((cat.performance?.score ?? 0) * 100),
                accessibility: Math.round((cat.accessibility?.score ?? 0) * 100),
                best_practices: Math.round((cat['best-practices']?.score ?? 0) * 100),
                seo: Math.round((cat.seo?.score ?? 0) * 100),
            },
            metrics: {
                lcp_ms: pick('largest-contentful-paint'),
                fcp_ms: pick('first-contentful-paint'),
                tbt_ms: pick('total-blocking-time'),
                cls: pick('cumulative-layout-shift'),
                si_ms: pick('speed-index'),
                tti_ms: pick('interactive'),
            },
            report_json: f,
            report_html: f.replace('.report.json', '.report.html'),
        });
    } catch (e) {
        console.error('parse fail:', f, '—', e.message);
    }
}
fs.writeFileSync(path.join(dir, 'lighthouse-manifest.json'), JSON.stringify(manifest, null, 2));
console.log('manifest:', manifest.length, 'pages → /reports/lighthouse-manifest.json');
NODE_EOF

echo ""
echo "════════════════════════════════════════════"
echo " 完成"
echo "════════════════════════════════════════════"
