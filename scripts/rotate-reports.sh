#!/bin/bash
# ════════════════════════════════════════════════════════════════
# rotate-reports.sh — reports 目錄輪替
#
# 用法：
#   bash scripts/rotate-reports.sh <project-name> [keep_days]
#
# 行為：
#   - reports/<project-name>/archive/ 保留最近 N 天（預設 30），舊的刪
#   - 把當前 reports/<project-name>/raw/ 裡修改時間超過 keep_days 的檔搬進
#     archive/YYYY-MM.tar.gz（逐月一包）
#   - 若該月 archive 已存在，重新打包覆蓋（冪等）
#
# 由 run-project.sh 在每次開跑前呼叫；也可手動跑。
# ════════════════════════════════════════════════════════════════
set -euo pipefail

NAME="${1:-}"
KEEP_DAYS="${2:-30}"

if [ -z "$NAME" ]; then
    echo "用法：bash scripts/rotate-reports.sh <project-name> [keep_days=30]"
    exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPORT_DIR="$ROOT/reports/$NAME"
ARCHIVE_DIR="$REPORT_DIR/archive"

[ -d "$REPORT_DIR" ] || { echo "  ℹ️  $REPORT_DIR 不存在，跳過輪替"; exit 0; }
mkdir -p "$ARCHIVE_DIR"

# 1. 把超過 KEEP_DAYS 的檔，按「修改月份」分組打包進 archive
#    find -mtime +N = 超過 N 天
mapfile -t OLD_FILES < <(find "$REPORT_DIR" -maxdepth 2 -type f -mtime +"$KEEP_DAYS" \
    ! -path "$ARCHIVE_DIR/*" ! -name '.gitkeep' 2>/dev/null || true)

if [ "${#OLD_FILES[@]}" -gt 0 ]; then
    # 依檔案修改日的 YYYY-MM 分組
    declare -A GROUPS
    for f in "${OLD_FILES[@]}"; do
        ym=$(date -r "$f" +%Y-%m 2>/dev/null || echo "unknown")
        GROUPS["$ym"]+="$f"$'\n'
    done
    for ym in "${!GROUPS[@]}"; do
        tarball="$ARCHIVE_DIR/${ym}.tar.gz"
        tmpfile=$(mktemp)
        echo "${GROUPS[$ym]}" | sed '/^$/d' > "$tmpfile"
        # 用相對路徑打包（-C REPORT_DIR），避免絕對路徑汙染 tarball
        tar -czf "$tarball" -C "$REPORT_DIR" -T <(sed "s|^$REPORT_DIR/||" "$tmpfile") 2>/dev/null
        # 成功打包後刪原檔
        xargs -a "$tmpfile" rm -f
        rm -f "$tmpfile"
        echo "  📦 已打包 $ym 的 $(echo "${GROUPS[$ym]}" | sed '/^$/d' | wc -l) 個檔 → archive/${ym}.tar.gz"
    done
fi

# 2. 刪掉 archive 裡超過 365 天的 tar.gz（年度輪替）
find "$ARCHIVE_DIR" -type f -name '*.tar.gz' -mtime +365 -delete 2>/dev/null || true

echo "  ✓ reports 輪替完成（保留 ${KEEP_DAYS} 天內原檔，超過則進 archive/）"
