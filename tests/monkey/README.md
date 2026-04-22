# Monkey Test — Gremlins.js via Playwright

透過 [gremlins.js](https://github.com/marmelab/gremlins.js) 執行「無腦亂打」模擬：
隨機點擊、打字、滾動、拉大小。專門抓 E2E spec 寫不到的 **未處理 JS 例外**。

## 工作原理

1. `run-project.sh <name> monkey` 以 `mcr.microsoft.com/playwright:v1.59.1-noble` 容器跑
2. bind mount 本目錄到容器，`npm ci` → `playwright test`
3. `gremlins.spec.ts` 對每個 `MONKEY_PAGES` 頁面：
   - 開頁 → 注入 gremlins.js → 放出攻擊
   - 監聽 `pageerror` / `console.error` / `requestfailed`
   - 有 `pageerror`（未捕獲例外）即失敗
4. 輸出 `/reports/monkey-report.json`（Playwright JSON reporter）
   + `monkey-html/index.html`（HTML 報告）

## 覆寫設定

於 `<project>/.testing/testing.yml`：

```yaml
tests:
  monkey:
    enabled: true
    pages: [/, /login.html]      # 預設 [/]
    attacks: 500                 # 總攻擊次數
    delay_ms: 10                 # 每次間隔（總耗時 ≈ attacks * delay_ms）
```

## 為什麼用 `pageerror` 當失敗條件

- `pageerror` = 頁面 JavaScript 未捕獲例外（真 bug）
- `console.error` = 應用程式主動 `console.error()`（常是第三方 SDK 噪音）
- `requestfailed` = 網路請求失敗（可能是取消、adblock，不一定是 bug）

只把 `pageerror` 當硬失敗；其他當資訊，附進 attachment 供人工檢視。

## 測試碼 vs. 配置碼

本骨架屬**骨架**——所有專案共用。若某專案需要登入後才能 monkey（例：後台），
複製整個 `tests/monkey/` 到 `<project>/.testing/monkey/`，在 spec 前面加登入步驟，
並在 `testing.yml` 加 `tests.monkey.custom: true`（未來擴充）。

目前預設模式：直接用 pipeline 骨架，只測公開頁面。
