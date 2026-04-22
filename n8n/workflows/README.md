# n8n Workflows

本目錄存放可匯入 n8n 的 workflow 範本（JSON 匯出格式）。

## 檔案

| 檔案 | 說明 |
|------|------|
| [pipeline-skeleton.json](./pipeline-skeleton.json) | 主要骨架 workflow：Form 手動觸發 → 輸入 projectName → 執行 run-project.sh → 失敗時 Email 通知 |
| [manual-ssl-test.json](./manual-ssl-test.json) | 輕量單項：只跑 SSL/TLS 檢測，用於快速驗證某站憑證狀況 |

## 如何匯入

1. 啟動 n8n：
   ```bash
   docker compose --profile n8n up -d
   ```
2. 開啟 <http://localhost:5678>（預設帳密在 `.env` 的 `N8N_USER` / `N8N_PASSWORD`）
3. 右上角選單 → **Import from File** → 選擇本目錄下的 `.json`

### CLI 匯入（建議，會 in-place 更新）

JSON 內建了 workflow `id`（`oNnWI3Ohcxh0ptqX`），從 CLI 匯入會**覆寫既有 workflow** 而非建新的：

```bash
docker cp n8n/workflows/pipeline-skeleton.json n8n:/tmp/pipeline.json
docker exec n8n n8n import:workflow --input=/tmp/pipeline.json
```

若遇到「同名節點被改成 `...1`、`...2` 後綴」的狀況，代表舊 workflow 節點跟新 JSON 合併了——不要用 `delete:workflow`（n8n CLI 沒有這指令）。解法：
1. 確認 JSON 有 top-level `id` 欄位（我們的已經有）
2. 重跑上面 CLI 匯入，n8n 會用 id 匹配覆蓋整份
3. 若 id 改過名或對不上，就從 GUI 刪掉 workflow 再匯入

## workflow 架構說明

```
[Form Trigger] ← 輸入 projectName + notifyEmail（選填）
      │
      ▼
[01 Init - Set Project Vars]
      │
      ▼
[02 Precheck]  ← 失敗立即中止（onError: stopWorkflow）
      │
      ├──→ 路線 A（A1 Static → A2 Unit → A3 API → A4 DB）
      ├──→ 路線 B（B1 SSL → B2 ZAP → B3 Nuclei → B4 Trivy → B5 Load → B6 Auth）
      └──→ 路線 C（C1 E2E → C2 Visual → C3 Browser → C4 Lighthouse → C5 Links → C6 Monkey）
                      ↓
            [Report - Generate Scorecard]
                      ↓
            [Report - Parse Results]
                      ↓
            [Notify - Should Send?]  ← 有填 email 且失敗 → Email Send
                      ↓
            [Notify - Send Email]
```

## 觸發方式

**只有手動觸發**（不做自動排程）。在 n8n GUI 按 **Execute workflow**，會彈出 Form：
- `projectName`（必填）：`projects.registry.yml` 的 key
- `notifyEmail`（選填）：失敗（`parseError` 或 `overallScore < 80`）時寄信通知

要啟用 Email 通知，還需要兩步：
1. `.env` 設 `SMTP_FROM=your@domain`，重啟 n8n（見 `docker compose restart n8n`）
2. n8n GUI → **Credentials** → 新增 **SMTP** credential → 到 `Notify - Send Email` 節點選綁定

## 失敗處理

- **Precheck 失敗** → 整條流水線立即中止，不跑後續 20 分鐘
- **個別 scope 失敗**（`onError: continueRegularOutput`）→ 繼續跑其他，分數反映在 scorecard
- **overallScore < 80 或 parseError** → 若有填 notifyEmail，自動寄信
- **SMTP 沒綁 credential** → Email 節點會失敗但不影響主流程（`onError: continueRegularOutput`）

## 擴充方向

- **多專案**：用 Split In Batches 遍歷 `projects.registry.yml`，一次跑所有
- **報告彙整**：用 Read/Write Files 節點把 `reports/<name>/report.md` 作附件寄出
- **Webhook 觸發**：若日後要接 CI/CD，可加 Webhook Trigger 節點並列上去（目前刻意不做）
