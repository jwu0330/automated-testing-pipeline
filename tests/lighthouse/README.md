# Lighthouse 前端品質檢測

Google Lighthouse：量化前端**效能 / 可及性 (A11y) / 最佳實踐 / SEO** 四項分數，
加上 Core Web Vitals（LCP / FCP / CLS / TBT / SI / TTI）。

## 工作原理

1. `run-project.sh <name> lighthouse` 觸發 `docker compose --profile lighthouse`
2. 本目錄 `Dockerfile` 建置 `node:20-slim + chromium + lighthouse@12`
3. `lighthouse-run.sh` 對 `testing.yml` 的 `tests.lighthouse.pages` 逐頁跑
4. 每頁產出 `lighthouse-<i>-<slug>.report.{json,html}`
5. 最後組 `lighthouse-manifest.json` 供 `summarize.js` 解析

## 覆寫設定

於 `<project>/.testing/testing.yml`：

```yaml
tests:
  lighthouse:
    enabled: true              # 預設 true
    preset: desktop            # desktop | mobile
    pages: [/, /login.html]    # 預設 [/]
```
