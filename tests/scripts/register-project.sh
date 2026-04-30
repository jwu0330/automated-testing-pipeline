#!/bin/bash
# ════════════════════════════════════════════════════════════════
# register-project.sh — 註冊新專案到測試流水線
#
# 用法：
#   bash tests/scripts/register-project.sh <name> <absolute-path>
#
# 範例：
#   bash tests/scripts/register-project.sh babydodofun /mnt/e/cwe網站/b12/babydodofun
# ════════════════════════════════════════════════════════════════
set -euo pipefail

NAME="${1:-}"
PROJECT_PATH="${2:-}"

if [ -z "$NAME" ] || [ -z "$PROJECT_PATH" ]; then
    echo "用法：bash tests/scripts/register-project.sh <name> <absolute-path>"
    echo "範例：bash tests/scripts/register-project.sh babydodofun /mnt/e/cwe網站/b12/babydodofun"
    exit 1
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REGISTRY="$ROOT/projects.registry.yml"

# 自動補齊 yq（host 只需要 Docker）
source "$ROOT/tests/scripts/lib/bootstrap.sh"

# ─── 驗證專案路徑 ───
if [ ! -d "$PROJECT_PATH" ]; then
    echo "❌ 路徑不存在：$PROJECT_PATH"
    exit 1
fi

if [ ! -d "$PROJECT_PATH/.testing" ]; then
    echo "⚠️  警告：$PROJECT_PATH/.testing 不存在"
    echo "    請依 docs/project-convention.md 建立 .testing/ 資料夾"
    echo ""
fi

if [ ! -f "$PROJECT_PATH/.testing/testing.yml" ]; then
    echo "⚠️  警告：$PROJECT_PATH/.testing/testing.yml 不存在"
    echo "    請先從範本建立："
    echo "      mkdir -p \"$PROJECT_PATH/.testing\""
    echo "      cp $ROOT/tests/scripts/testing-yml-template.yml \"$PROJECT_PATH/.testing/testing.yml\""
    echo ""
fi

if [ ! -f "$PROJECT_PATH/.testing/.env.example" ]; then
    echo "💡 提示：尚無 .testing/.env.example（env 協議）"
    echo "    若需要登入測試或其他敏感變數，請複製範本："
    echo "      cp $ROOT/tests/scripts/env.example \"$PROJECT_PATH/.testing/.env.example\""
    echo "      cp \"$PROJECT_PATH/.testing/.env.example\" \"$PROJECT_PATH/.testing/.env\""
    echo ""
fi

# ─── 初始化 registry ───
if [ ! -f "$REGISTRY" ]; then
    cat > "$REGISTRY" <<EOF
schema_version: 1
projects: {}
EOF
    echo "✓ 建立 $REGISTRY"
fi

# ─── 寫入 registry ───
yq -i ".projects.${NAME}.path = \"${PROJECT_PATH}\"" "$REGISTRY"
yq -i ".projects.${NAME}.registered_at = \"$(date -Iseconds)\"" "$REGISTRY"

echo ""
echo "✅ 已註冊：$NAME"
echo "   Path:         $PROJECT_PATH"
echo "   Registry:     $REGISTRY"
echo ""
echo "下一步："
echo "   bash tests/scripts/run-project.sh $NAME"
