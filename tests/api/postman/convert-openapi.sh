#!/bin/bash
# ════════════════════════════════════════════════════════════════
# convert-openapi.sh — 把 OpenAPI 規格轉成 Postman collection
#
# 用法（在 testing-pipeline-newman 容器內）：
#   convert-openapi.sh <openapi-spec> <output-collection>
#
# 範例：
#   docker run --rm \
#     -v "$openapi_path:/workspace/openapi.yaml:ro" \
#     -v "$out_dir:/out" \
#     --entrypoint /workspace/convert-openapi.sh \
#     testing-pipeline-newman \
#     /workspace/openapi.yaml /out/generated.postman_collection.json
# ════════════════════════════════════════════════════════════════
set -euo pipefail

SPEC="${1:-}"
OUT="${2:-}"

if [ -z "$SPEC" ] || [ -z "$OUT" ]; then
    echo "用法：convert-openapi.sh <openapi-spec> <output-collection>"
    exit 1
fi

if [ ! -f "$SPEC" ]; then
    echo "❌ OpenAPI 規格不存在：$SPEC"
    exit 1
fi

echo "  ▶ OpenAPI → Postman collection"
echo "    源：$SPEC"
echo "    目標：$OUT"

# -p（pretty）讓輸出 JSON 可讀
# -O folderStrategy=Tags：依 OpenAPI tag 分資料夾
# -O requestParametersResolution=Example：用規格裡的 example 當測試資料
# -O exampleParametersResolution=Example：response example 也走 example
# -O includeAuthInfoInExample=true：把 security 設定帶進每個 request
openapi2postmanv2 \
    -s "$SPEC" \
    -o "$OUT" \
    -p \
    -O folderStrategy=Tags \
    -O requestParametersResolution=Example \
    -O exampleParametersResolution=Example \
    -O includeAuthInfoInExample=true

if [ ! -s "$OUT" ]; then
    echo "❌ 轉換失敗，輸出檔為空"
    exit 1
fi

echo "  ✓ 轉換完成"
