#!/bin/bash
# ════════════════════════════════════════════════════════════════
# bootstrap.sh — host 端自動補齊 yq / node
#
# 設計目標：host 只需要 Docker，其他一律自動處理。
#   - yq 缺：下載 vendored binary 到 <pipeline>/bin/yq（不需 sudo）
#   - node 缺：定義 node_run() 走 docker（node:22-slim）
#
# 使用方式（在其他 script 開頭）：
#   ROOT="$(cd "$(dirname "$0")/.." && pwd)"
#   source "$ROOT/scripts/lib/bootstrap.sh"
# ════════════════════════════════════════════════════════════════

# 呼叫端應已定義 ROOT；保險起見再算一次
if [ -z "${ROOT:-}" ]; then
    ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fi

PIPELINE_BIN="$ROOT/bin"
mkdir -p "$PIPELINE_BIN"
case ":$PATH:" in
    *":$PIPELINE_BIN:"*) ;;
    *) export PATH="$PIPELINE_BIN:$PATH" ;;
esac

# ─── 確保 yq ───
ensure_yq() {
    if command -v yq >/dev/null 2>&1; then
        return 0
    fi
    local arch_suffix
    case "$(uname -m)" in
        x86_64|amd64) arch_suffix="linux_amd64" ;;
        aarch64|arm64) arch_suffix="linux_arm64" ;;
        *) echo "❌ 不支援的架構：$(uname -m)" >&2; return 1 ;;
    esac
    echo "↓ 首次執行，下載 yq 到 $PIPELINE_BIN/yq …" >&2
    if command -v wget >/dev/null 2>&1; then
        wget -qO "$PIPELINE_BIN/yq" \
            "https://github.com/mikefarah/yq/releases/latest/download/yq_${arch_suffix}" \
            || { echo "❌ yq 下載失敗" >&2; return 1; }
    elif command -v curl >/dev/null 2>&1; then
        curl -fsSL -o "$PIPELINE_BIN/yq" \
            "https://github.com/mikefarah/yq/releases/latest/download/yq_${arch_suffix}" \
            || { echo "❌ yq 下載失敗" >&2; return 1; }
    else
        echo "❌ 系統缺少 wget/curl，無法自動下載 yq" >&2
        return 1
    fi
    chmod +x "$PIPELINE_BIN/yq"
    echo "✓ yq 已就位（$($PIPELINE_BIN/yq --version)）" >&2
}

# ─── node 包裝：本機有就直接跑，沒有就走 docker ───
# 用法：node_run <script.js> [args...]
node_run() {
    if command -v node >/dev/null 2>&1; then
        node "$@"
        return $?
    fi
    if ! command -v docker >/dev/null 2>&1; then
        echo "❌ 需要 node 或 docker（兩者擇一）" >&2
        return 1
    fi
    # 走 docker：mount 整個 pipeline root 進去
    local script="$1"
    shift
    local script_in_container="${script#$ROOT/}"
    docker run --rm -i \
        -v "$ROOT:/workspace" \
        -w /workspace \
        node:22-slim \
        node "$script_in_container" "$@"
}

ensure_yq
