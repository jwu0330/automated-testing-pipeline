#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# Lighthouse CI — Core Web Vitals / 可及性 / 最佳實踐 / SEO
#
# ENV:
#   TARGET_URL         目標站（必填，結尾不帶 /）
#   LIGHTHOUSE_PAGES   空白分隔的相對路徑清單（預設 "/"）
#   LIGHTHOUSE_PRESET  lighthouse 預設（desktop/mobile，預設 desktop）
#
# 輸出：
#   /reports/lighthouse-<n>-<slug>.report.json
#   /reports/lighthouse-<n>-<slug>.report.html
#   /reports/lighthouse-manifest.json    ★ summarize.js 解析這份
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

TARGET="${TARGET_URL:-https://example.com}"
TARGET="${TARGET%/}"
PAGES="${LIGHTHOUSE_PAGES:-/}"
PRESET="${LIGHTHOUSE_PRESET:-desktop}"
REPORT_DIR="/reports"

mkdir -p "$REPORT_DIR"
rm -f "$REPORT_DIR"/lighthouse-*.report.* "$REPORT_DIR/lighthouse-manifest.json" 2>/dev/null || true

echo "════════════════════════════════════════════"
echo " Lighthouse 前端品質檢測"
echo " 目標：$TARGET"
echo " 頁面：$PAGES"
echo " 預設：$PRESET"
echo "════════════════════════════════════════════"

i=0
for page in $PAGES; do
    i=$((i + 1))
    # slug 用於檔名：將 / 轉成 _、去頭尾 _
    slug=$(echo "$page" | sed 's|[^A-Za-z0-9]|_|g; s|^_*||; s|_*$||')
    [ -z "$slug" ] && slug="home"
    slug=$(echo "$slug" | head -c 40)

    url="${TARGET}${page}"
    out_base="$REPORT_DIR/lighthouse-${i}-${slug}"

    echo ""
    echo "[$i] $url"

    set +e
    lighthouse "$url" \
        --chrome-flags="$CHROME_FLAGS" \
        --preset="$PRESET" \
        --output=json \
        --output=html \
        --output-path="$out_base" \
        --only-categories=performance,accessibility,best-practices,seo \
        --quiet \
        --no-update-notifier
    rc=$?
    set -e
    if [ $rc -ne 0 ]; then
        echo "  (lighthouse 結束碼 $rc)"
    fi
done

# ─── 組 manifest.json（summarize.js 會讀）──────────────────
node <<'NODE_EOF'
const fs = require('fs');
const path = require('path');
const dir = '/reports';
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
        manifest.push({
            url: data.finalDisplayedUrl || data.finalUrl || data.requestedUrl,
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
        console.error(`parse fail: ${f} — ${e.message}`);
    }
}
fs.writeFileSync(path.join(dir, 'lighthouse-manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`manifest: ${manifest.length} pages → /reports/lighthouse-manifest.json`);
NODE_EOF

echo ""
echo "════════════════════════════════════════════"
echo " 完成"
echo "════════════════════════════════════════════"
