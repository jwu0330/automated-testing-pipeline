FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        ca-certificates \
        fonts-liberation \
        fonts-noto-cjk \
        dumb-init \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g lighthouse@12

ENV CHROME_PATH=/usr/bin/chromium
ENV CHROME_FLAGS="--headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu"

WORKDIR /work
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["/bin/bash", "/work/lighthouse-run.sh"]
