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
[Manual Trigger]
      │
      ▼
[01 Init - Set Project Vars]   ← projectName（registry key）
      │
      ▼
[02 … 13 各 scope]             ← scripts/run-project.sh <name> <scope>
      │
      ▼
[16 Report → 15 Parse]         ← summarize --json 與 Code 節點
```

## 擴充方向

- **排程**：將 Manual Trigger 換成 Schedule Trigger（每天凌晨 3 點跑）
- **通知**：串接 Email / Slack / LINE Notify 在失敗時提醒
- **多專案**：用 Split In Batches 遍歷 `projects.registry.yml`
- **報告彙整**：用 Read/Write Files 節點把 reports 寄出
