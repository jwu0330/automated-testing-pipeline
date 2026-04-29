# Google Sheets 批次接入 — 欄位規範

> 用 Google Sheets 當「待測清單」餵給 n8n 通用模板 workflow。每列 = 一個專案。

## 建立試算表

1. Google Drive 新建試算表，命名 `testing-pipeline-batch`（名稱不強制，但建議統一）。
2. 第一列為 header，使用下表的欄位名稱（**底線、小寫**，不要用中文或空白）。
3. 把共享權限給予 n8n 使用的 Google 帳號（讀取權限即可）。
4. 在 n8n GUI 打開 `Testing Pipeline — Universal Template` workflow，把 `00b Google Sheets Trigger (stub)` 節點換成 `Google Sheets → Read Rows`，綁定 OAuth credential 並指向這份試算表。

## 欄位表

| 欄位名 | 必填 | 對應 | 說明 |
|---|---|---|---|
| `project_name` | ✅ | `testing.yml:project.name` + registry key | 英數底線（例 `babydodofun`）；同名會覆寫上次設定 |
| `target_url` | ✅ | `testing.yml:project.target_url` | `https://...`；缺則該列直接拒絕（n8n Precheck 節點 throw） |
| `local_path` | | `testing.yml:project.local_path` | 絕對路徑；空或不存在 → skip `static / trivy`，並記錄 warning |
| `php_version` | | `testing.yml:project.php_version` | 非 PHP 專案留空即走預設 `8.1` |
| `scopes` | ✅ | `run-project.sh` 第 2 參數 | 逗號分隔 scope 或 preset（`ALL` / `REMOTE_ONLY` / `LOCAL_ONLY`） |
| `admin_username` | | `.env:ADMIN_USERNAME` | 缺 → api-test / auth-test 身分可能不完整 |
| `admin_password` | | `.env:ADMIN_PASSWORD` | 同上 |
| `user1_username` | | `.env:USER1_USERNAME` | 多身分第 1 組 |
| `user1_password` | | `.env:USER1_PASSWORD` | |
| `user1_label` | | `.env:USER1_LABEL` | 報告檔名會帶此 label（例 `newman-junit-user1-line_signup.xml`） |
| `user2_username` ~ `user5_username` | | `.env:USER[2-5]_USERNAME` | 同樣規則，最多 5 組 |
| `user2_password` ~ `user5_password` | | `.env:USER[2-5]_PASSWORD` | |
| `user2_label` ~ `user5_label` | | `.env:USER[2-5]_LABEL` | |
| `e2e_username` | | `.env:E2E_USERNAME` | 給 Playwright 登入用 |
| `e2e_password` | | `.env:E2E_PASSWORD` | 缺則 e2e 降級為未登入流程，並記 warning |
| `notify_email` | | 該列失敗通知 | `parseError` / `overallScore<80` / `warnings≠[]` 才寄；留空則該列不通知 |
| `enabled` | | 批次過濾 | `false` / 空 → 跳過此列（預設 `true`）|
| `notes` | | 純註記 | 不影響執行，給人看的 |

## Scope 可選值

**Preset**（由 n8n `01 Normalize Input` 展開為具體 scope 清單）：
- `ALL`：全部 14+ 種測試
- `REMOTE_ONLY`：僅遠端測試（`precheck, ssl, security, nuclei, stress, lighthouse, links, monkey`）
- `LOCAL_ONLY`：僅本地測試（`static, trivy`）

**單項**：`precheck, static, api-test, auth-test, ssl, security, nuclei, trivy, stress, e2e, visual-test, browser-compat, lighthouse, links, monkey, summary`

**組合範例**：`ssl,e2e,lighthouse` / `REMOTE_ONLY` / `static,trivy`

## 範例列

| project_name | target_url | local_path | php_version | scopes | admin_username | admin_password | e2e_username | e2e_password | notify_email | enabled | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| babydodofun | https://xcity.babydodofun.com | /mnt/e/cwe/b12/babydodofun | 8.1 | ALL | admin001 | @admin001 | admin001 | @admin001 | qa@example.com | true | 全測 |
| landingpage | https://landing.example.com | | | REMOTE_ONLY | | | | | | true | 純 URL |
| legacy_site | https://legacy.example.com | /srv/legacy | 7.4 | static,trivy,ssl | root | secret | | | dev@example.com | true | 只驗本地 + SSL |
| disabled_row | https://skip.example.com | | | ALL | | | | | | false | 先關掉 |

## 執行策略

- `02 SplitInBatches (batchSize=1)` 節點：**逐一序列**跑，避免 Docker 資源搶佔與目標站壓力堆疊。
- `01.5 Filter enabled` 節點：`enabled=false` 的列直接過濾掉，不進批次迴圈。
- `11 Aggregate Batch Summary`：SplitInBatches 完成後產出 Markdown 總結表；若 `$env.BATCH_NOTIFY_EMAIL` 有設，會寄一份到該信箱。

## 權限與安全

- **Sheet 權限**：n8n OAuth 帳號用 **讀者** 權限即可；不建議設編輯者，避免 workflow bug 回寫亂資料。
- **帳密處理**：Sheet 存的帳密會被 `01 Normalize Input` 組成 base64 `.env` 內容，由 `write-project-config.sh` 寫到 `<local_path>/.testing/.env`（或 ephemeral 目錄）。
  - 敏感值請評估風險；建議用 Google Workspace + 最小共享權限。
  - 若需要更強隔離，把帳密改放 n8n Credentials，Sheet 只存識別碼，在 Normalize 節點查 credential store 組裝。

## FAQ

**Q：Sheet 改了之後會自動跑嗎？**
不會。這個 workflow 的 Sheets trigger 只在手動 Execute 時讀一次；要定時跑請在 n8n 另外加 Cron 節點，或沿用「手動觸發」的操作習慣。

**Q：`local_path` 是宿主路徑還是 n8n 容器內路徑？**
是**宿主路徑**。n8n 容器已 mount `/mnt/e` 整個分區，因此 `run-project.sh` 在容器內能看到宿主的 `/mnt/e/...`。非 `/mnt/e` 路徑請另外加 compose volume。

**Q：同一個 project_name 出現多列會發生什麼？**
後一列會覆寫前一列的 `testing.yml` / `.env`，且 reports 目錄共用。建議 project_name 保持唯一；若真要「一個站、多種情境」，在 name 加尾綴（例 `babydodofun_admin` / `babydodofun_user1`）。

**Q：批次中某列炸掉會影響後續嗎？**
不會。`03 Precheck & Warning` 的 `throw` 只讓該 item 失敗；SplitInBatches 繼續下一列。`executeCommand` 節點設 `onError: continueRegularOutput`，shell 非零結束碼也不會中斷批次。
