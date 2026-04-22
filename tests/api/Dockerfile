FROM node:22-slim

WORKDIR /workspace

RUN npm install -g newman@^6 --no-save

COPY postman/run-newman.sh /workspace/

RUN chmod +x /workspace/run-newman.sh

ENTRYPOINT ["/bin/bash", "/workspace/run-newman.sh"]
