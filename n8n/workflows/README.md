# n8n Workflows

本目錄存放可匯入 n8n 的 workflow 範本（JSON 匯出格式）。

## 檔案

| 檔案 | 說明 |
|------|------|
| [pipeline-skeleton.json](./pipeline-skeleton.json) | 主要骨架 workflow：手動觸發 → 選擇專案 → 執行 run-project.sh → 顯示結果 |

## 如何匯入

1. 啟動 n8n：
   ```bash
   docker compose --profile n8n up -d
   ```
2. 開啟 <http://localhost:5678>（預設帳密在 `.env` 的 `N8N_USER` / `N8N_PASSWORD`）
3. 右上角選單 → **Import from File** → 選擇本目錄下的 `.json`

## workflow 架構說明

```
[Manual Trigger]
      │
      ▼
[Set Project Vars]    ← 指定要跑哪個專案、哪些測試
      │
      ▼
[Execute Command]     ← 呼叫 /workspace/scripts/run-project.sh
      │
      ▼
[Parse Output]        ← (選)解析報告、通知
```

## 擴充方向

- **排程**：將 Manual Trigger 換成 Schedule Trigger（每天凌晨 3 點跑）
- **通知**：串接 Email / Slack / LINE Notify 在失敗時提醒
- **多專案**：用 Split In Batches 遍歷 `projects.registry.yml`
- **報告彙整**：用 Read/Write Files 節點把 reports 寄出
