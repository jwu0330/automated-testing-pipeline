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
# 偵測 OS（Linux / macOS / Windows Git Bash）並下載對應 binary。
# Git Bash on Windows 跑 Linux ELF 會 "Exec format error"，所以要分平台。
ensure_yq() {
    local os_suffix arch_suffix bin_name="yq"
    case "$(uname -s)" in
        Linux)                os_suffix="linux" ;;
        Darwin)               os_suffix="darwin" ;;
        MINGW*|MSYS*|CYGWIN*) os_suffix="windows"; bin_name="yq.exe" ;;
        *) echo "❌ 不支援的 OS：$(uname -s)" >&2; return 1 ;;
    esac
    case "$(uname -m)" in
        x86_64|amd64)  arch_suffix="amd64" ;;
        aarch64|arm64) arch_suffix="arm64" ;;
        *) echo "❌ 不支援的架構：$(uname -m)" >&2; return 1 ;;
    esac

    # 清掉前一次跑錯平台留下的 binary（例如 Windows 環境裡的 Linux ELF yq）
    if [ "$os_suffix" = "windows" ] && [ -f "$PIPELINE_BIN/yq" ]; then
        rm -f "$PIPELINE_BIN/yq"
    fi

    if command -v yq >/dev/null 2>&1; then
        return 0
    fi

    local url="https://github.com/mikefarah/yq/releases/latest/download/yq_${os_suffix}_${arch_suffix}"
    [ "$os_suffix" = "windows" ] && url="${url}.exe"
    local target="$PIPELINE_BIN/$bin_name"

    echo "↓ 首次執行，下載 yq 到 $target …" >&2
    if command -v wget >/dev/null 2>&1; then
        wget -qO "$target" "$url" || { echo "❌ yq 下載失敗" >&2; return 1; }
    elif command -v curl >/dev/null 2>&1; then
        curl -fsSL -o "$target" "$url" || { echo "❌ yq 下載失敗" >&2; return 1; }
    else
        echo "❌ 系統缺少 wget/curl，無法自動下載 yq" >&2
        return 1
    fi
    chmod +x "$target"
    echo "✓ yq 已就位（$("$target" --version)）" >&2
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
    # 若 REPORTS_DIR 在 ROOT 底下，把宿主路徑翻譯成容器路徑
    local docker_reports_dir=""
    if [ -n "${REPORTS_DIR:-}" ]; then
        local rel="${REPORTS_DIR#$ROOT/}"
        if [ "$rel" != "$REPORTS_DIR" ]; then
            docker_reports_dir="/workspace/$rel"
        else
            docker_reports_dir="$REPORTS_DIR"
        fi
    fi
    docker run --rm -i \
        -v "$ROOT:/workspace" \
        -w /workspace \
        ${docker_reports_dir:+-e REPORTS_DIR="$docker_reports_dir"} \
        node:22-slim \
        node "$script_in_container" "$@"
}

ensure_yq
