#!/bin/bash
# ════════════════════════════════════════════════════════════════
# build-newman-image.sh — 建置 Newman docker 映像
#
# 用法：
#   bash scripts/build-newman-image.sh
#
# ════════════════════════════════════════════════════════════════
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

IMAGE_NAME="testing-pipeline-newman"
IMAGE_TAG="latest"

echo "╔════════════════════════════════════════════╗"
echo "║  Build Newman Docker Image"
echo "║  $IMAGE_NAME:$IMAGE_TAG"
echo "╚════════════════════════════════════════════╝"

if docker image inspect "$IMAGE_NAME:$IMAGE_TAG" >/dev/null 2>&1; then
    echo "  ✓ 映像已存在：$IMAGE_NAME:$IMAGE_TAG"
    exit 0
fi

echo ""
echo "  建置中..."
docker build \
    -t "$IMAGE_NAME:$IMAGE_TAG" \
    -f tests/api/Dockerfile \
    tests/api/

echo "  ✓ 建置完成"
docker image inspect "$IMAGE_NAME:$IMAGE_TAG" | grep -A 3 '"RepoTags"'
