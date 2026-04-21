FROM ubuntu:24.04

LABEL maintainer="babydodofun-dev"
LABEL description="Automated testing pipeline for babydodofun"

# 避免互動式安裝提示
ENV DEBIAN_FRONTEND=noninteractive

# 安裝基礎工具
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    git \
    ca-certificates \
    jq \
    bsdmainutils \
    dnsutils \
    openssl \
    procps \
    && rm -rf /var/lib/apt/lists/*

# 安裝 testssl.sh
RUN git clone --depth 1 https://github.com/drwetter/testssl.sh.git /opt/testssl.sh

# 工作目錄
WORKDIR /workspace

# 預設入口
CMD ["/bin/bash"]
