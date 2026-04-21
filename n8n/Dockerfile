FROM n8nio/n8n:latest

LABEL maintainer="babydodofun-dev"
LABEL description="n8n + docker-cli + yq for automated-testing-pipeline orchestration"

USER root

# 安裝：
#   docker-cli, docker-cli-compose — 在 workflow 中執行 docker compose
#   yq                              — 解析 testing.yml / projects.registry.yml
#   bash, curl                      — shell 腳本支援
RUN apk add --no-cache \
        docker-cli \
        docker-cli-compose \
        bash \
        curl \
    && curl -sSL \
        -o /usr/local/bin/yq \
        https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 \
    && chmod +x /usr/local/bin/yq \
    && yq --version

USER node
