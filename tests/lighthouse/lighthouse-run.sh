#!/bin/bash
# Lighthouse runner for performance, accessibility, best-practices, and SEO.
# If auth discovery produced same-job login artifacts, run Lighthouse against
# authenticated paths and attach the short-lived Cookie header to those checks.
set -euo pipefail

TARGET="${TARGET_URL:-https://example.com}"
TARGET="${TARGET%/}"
PRESET="${LIGHTHOUSE_PRESET:-desktop}"
REPORT_DIR="/reports"

mkdir -p "$REPORT_DIR"
rm -f "$REPORT_DIR"/lighthouse-*.report.* "$REPORT_DIR/lighthouse-manifest.json" 2>/dev/null || true

if [ "${LIGHTHOUSE_USE_AUTH_DISCOVERY:-1}" != "0" ] && [ -s "$REPORT_DIR/auth-paths.txt" ]; then
  echo "Using auth discovery pages for Lighthouse"
  LIGHTHOUSE_PAGES_JSON=$(node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const paths = fs.readFileSync(file, "utf8").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    process.stdout.write(JSON.stringify(paths.slice(0, 12).map(path => ({ path, auth: true }))));
  ' "$REPORT_DIR/auth-paths.txt")
  export LIGHTHOUSE_PAGES_JSON
fi

COOKIE_HEADER=""
if [ -s "$REPORT_DIR/auth-cookie-header.txt" ]; then
  COOKIE_HEADER="$(cat "$REPORT_DIR/auth-cookie-header.txt")"
fi

PAGES_TSV=$(node -e '
  const json = process.env.LIGHTHOUSE_PAGES_JSON || "";
  let arr = [];
  if (json) {
    try { arr = JSON.parse(json); } catch (e) { console.error("PAGES_JSON parse fail:", e.message); }
  }
  if (!Array.isArray(arr) || !arr.length) {
    const legacy = (process.env.LIGHTHOUSE_PAGES || "/").trim().split(/\s+/);
    arr = legacy.map(p => ({ path: p, auth: false }));
  }
  for (const p of arr) {
    const pagePath = (typeof p === "string") ? p : (p.path || "/");
    const auth = (typeof p === "object" && p && !!p.auth) ? "1" : "0";
    process.stdout.write(pagePath + "\t" + auth + "\n");
  }
')

echo "──────────────────────────────"
echo " Lighthouse"
echo " Target: $TARGET"
echo " Preset: $PRESET"
if [ -n "$COOKIE_HEADER" ]; then
  echo " Cookie: same-job authenticated header available"
else
  echo " Cookie: none"
fi
echo "──────────────────────────────"
echo "$PAGES_TSV" | grep -c $'\t' >/dev/null 2>&1 || { echo "No Lighthouse pages"; exit 0; }

i=0
while IFS=$'\t' read -r page auth; do
  [ -z "$page" ] && continue
  i=$((i + 1))
  slug=$(echo "$page" | sed 's|[^A-Za-z0-9]|_|g; s|^_*||; s|_*$||')
  [ -z "$slug" ] && slug="home"
  slug=$(echo "$slug" | head -c 40)

  url="${TARGET}${page}"
  out_base="$REPORT_DIR/lighthouse-${i}-${slug}"
  echo ""
  echo "[$i] $url"

  extra_headers_json=""
  if [ "$auth" = "1" ] && [ -n "$COOKIE_HEADER" ]; then
    extra_headers_json=$(node -e 'process.stdout.write(JSON.stringify({ Cookie: process.argv[1] }))' "$COOKIE_HEADER")
  fi

  set +e
  if [ -n "$extra_headers_json" ]; then
    lighthouse "$url" \
      --chrome-flags="$CHROME_FLAGS" \
      --preset="$PRESET" \
      --extra-headers="$extra_headers_json" \
      --output=json \
      --output=html \
      --output-path="$out_base" \
      --only-categories=performance,accessibility,best-practices,seo \
      --quiet \
      --no-update-notifier
    rc=$?
  else
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
  fi
  set -e
  if [ $rc -ne 0 ]; then
    echo "  (lighthouse exit $rc)"
  fi
done <<< "$PAGES_TSV"

export PAGES_TSV_INLINE="$PAGES_TSV"
node <<'NODE_EOF'
const fs = require('fs');
const path = require('path');
const dir = '/reports';

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
    console.error('parse fail:', f, e.message);
  }
}
fs.writeFileSync(path.join(dir, 'lighthouse-manifest.json'), JSON.stringify(manifest, null, 2));
console.log('manifest:', manifest.length, 'pages -> /reports/lighthouse-manifest.json');
NODE_EOF

echo ""
echo "Done"
