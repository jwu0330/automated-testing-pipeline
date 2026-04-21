# Lychee 連結檢查

[lychee](https://github.com/lycheeverse/lychee)：超快的連結檢查器（Rust）。驗證網站所有 `<a>` / `<img>` / `<script>` 的 URL 是否可達。

## 工作原理

1. `run-project.sh <name> links` 觸發 `docker compose --profile links`
2. 直接用官方 image `lycheeverse/lychee:latest`
3. 從 `target_url` 開始爬（深度由 `tests.links.max_depth` 控制）
4. 輸出 `/reports/lychee.json`（結構化 JSON：stats + 錯誤清單）
5. `summarize.js` 呈現「壞連結數 / 總連結數」+ 失敗 URL 清單

## 覆寫設定

於 `<project>/.testing/testing.yml`：

```yaml
tests:
  links:
    enabled: true
    max_depth: 1               # 0=只檢查 target_url 本頁；1=向下一層
    timeout: 15                # 單一連結逾時秒數
    max_concurrency: 4
    exclude:                   # 要跳過的 URL 正則（陣列）
      - "^https://www\\.facebook\\.com"
      - "^mailto:"
```

## 注意

- `max_depth: 0` = 只檢查 `target_url` 這一頁上的連結，不遞迴。
- 外部連結太多時建議設 `max_concurrency: 2` 避免被 rate limit。
- 社群網站（FB / IG / Twitter）常回 403/429 擋爬蟲，建議放 `exclude`。
