# ════════════════════════════════════════════════════════════════
# n8n 測試總管理者 — 自訂映像
#
# n8nio/n8n:latest 是 Docker Hardened Image（無 apk/apt）
# 用 multi-stage 從 alpine 抓工具再 COPY 進去
# ════════════════════════════════════════════════════════════════

# ─── Stage 1：準備 bash / docker / docker-compose / yq 二進位 ───
FROM alpine:3.22 AS builder

ARG DOCKER_VERSION=28.1.1
ARG COMPOSE_VERSION=v2.33.1
ARG YQ_VERSION=v4.53.2

RUN apk add --no-cache curl tar bash

# docker / docker-compose / yq 工具（單檔可攜）
RUN curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_VERSION}.tgz" \
       | tar -xz -C /tmp \
    && mkdir -p /out/usr/local/bin /out/usr/local/lib/docker/cli-plugins \
    && mv /tmp/docker/docker /out/usr/local/bin/docker \
    && curl -fsSL -o /out/usr/local/lib/docker/cli-plugins/docker-compose \
       "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
    && curl -fsSL -o /out/usr/local/bin/yq \
       "https://github.com/mikefarah/yq/releases/download/${YQ_VERSION}/yq_linux_amd64" \
    && chmod +x /out/usr/local/bin/docker /out/usr/local/bin/yq /out/usr/local/lib/docker/cli-plugins/docker-compose

# bash + 相依 shared library（用 ldd 自動追蹤）
RUN mkdir -p /out/bin \
    && cp /bin/bash /out/bin/bash \
    && ldd /bin/bash \
       | awk '{for(i=1;i<=NF;i++) if ($i ~ /^\//) print $i}' \
       | sort -u \
       | while read lib; do \
           if [ -f "$lib" ]; then \
             mkdir -p "/out$(dirname "$lib")"; \
             cp -L "$lib" "/out$lib"; \
           fi; \
         done

# ─── Stage 2：疊到 n8n 映像 ───
FROM n8nio/n8n:latest

LABEL maintainer="babydodofun-dev"
LABEL description="n8n + bash + docker-cli + docker-compose + yq"

USER root

COPY --from=builder /out/ /

RUN bash --version | head -1 \
    && docker --version \
    && docker compose version \
    && yq --version

USER node
