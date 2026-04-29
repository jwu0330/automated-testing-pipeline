FROM node:22-slim

WORKDIR /workspace

# newman = Postman CLI；openapi-to-postmanv2 = OpenAPI → Postman collection 轉換器
RUN npm install -g newman@^6 openapi-to-postmanv2@^4 --no-save

COPY postman/run-newman.sh /workspace/
COPY postman/convert-openapi.sh /workspace/

RUN chmod +x /workspace/run-newman.sh /workspace/convert-openapi.sh

ENTRYPOINT ["/bin/bash", "/workspace/run-newman.sh"]
