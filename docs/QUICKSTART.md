# 快速上手 — 把你的專案接到這條測試流水線

> **目標讀者**：拿到這份 pipeline 想替自己的網站／API 加自動化測試的人。
> **時間**：第一次完整跑通約 15 分鐘（多數時間在等 Docker 拉 image）。

> **v0.5 這次有什麼新東西？**
> - **單元測試交還給專案自己管**：本 pipeline 只負責黑箱／行為測試（API、E2E、SSL、壓力、Lighthouse、視覺迴歸…）。
> - **API 測試只要丟 OpenAPI 路徑**：不必自己寫 Postman collection，pipeline 會自動轉。
> - **沒 API 的站不會被擋**：純前端／純內容站照樣跑其他測試。
>
> 詳細變更見 [v0.5 release notes](#附錄-a-v05-release-notes)。

---

## 一頁速覽

```
1. 一次性：在 pipeline 主機啟 n8n
2. 每個專案：複製 .testing/ 到專案根、填 4 行設定
3. (可選) API 測試：把 OpenAPI 規格放進 .testing/api/openapi.yaml
4. 跑：bash .testing/link.sh   或   bash scripts/run-project.sh <name>
5. 看：reports/<name>/report.md
```

---

## 0. 你需要什麼

| 工具 | 為什麼 | 安裝驗證 |
|---|---|---|
| Docker + Docker Compose v2 | 所有測試都在容器內跑 | `docker compose version` |
| WSL2（Windows）/ bash | 跑 `run-project.sh` 等 shell 腳本 | `bash --version` |
| `yq`（Go 版） | 讀 testing.yml | `yq --version` |
| node | 跑 `summarize.js` 產報告 | `node --version` |
| git | clone 本 repo | `git --version` |

WSL2 上的 `yq` 一行裝完：

```bash
wget -qO ~/.local/bin/yq https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64
chmod +x ~/.local/bin/yq
```

---

## 1. 一次性：把 pipeline 跑起來

```bash
# 1.1 clone 本 repo（建議放在沒中文的路徑）
git clone git@github.com:jwu0330/automated-testing-pipeline.git
cd automated-testing-pipeline

# 1.2 建立 .env
cp .env.example .env
# 編輯 .env 填 N8N_PASSWORD（n8n GUI 登入用）

# 1.3 啟 n8n（這步驟只在這台機器做一次；之後它會 unless-stopped 重開機自動起）
docker compose --profile n8n up -d --build
```

n8n GUI：<http://localhost:5678>，帳密就是 `.env` 裡那組。

> **n8n 不一定要用**：CLI 直接跑 `bash scripts/run-project.sh <name>` 就可以了。n8n 是給「想用 GUI / Google Sheets 排批次」的場景。

---

## 2. 把你的專案接上 pipeline

### 2.1 複製 `.testing/` kit 到你的專案

```bash
cp -r /path/to/automated-testing-pipeline/.testing /path/to/your-project/
cd /path/to/your-project
```

### 2.2 編輯 `.testing/testing.yml` 的 4 個必填欄位

```yaml
schema_version: 2

project:
  name: my_project                          # ① 識別名稱（英數底線；用於 reports/<name>/）
  target_url: https://my-project.com        # ② 線上測試目標
  local_path: /absolute/path/to/my-project  # ③ 原始碼絕對路徑；留 "" 只跑網路測試
  php_version: "8.1"                        # ④ 非 PHP 專案保留預設即可
```

### 2.3 一鍵跑

```bash
bash .testing/link.sh
```

`link.sh` 會：
1. 註冊專案到 pipeline
2. 確保 n8n 有起來
3. 跑 `run-project.sh <name> all`
4. 報告產到 `<pipeline>/reports/<name>/report.md`

---

## 3. （可選）API 測試：丟 OpenAPI 路徑就好

> 這是 v0.5 的新功能。**不必自己寫 Postman collection**。

### 3.1 三種來源（pipeline 依序偵測）

| 優先序 | 條件 | 做法 |
|---|---|---|
| ① | 你已有 Postman collection | 放 `.testing/api/collections/*.postman_collection.json` |
| ② | 你想明確指定 OpenAPI 路徑 | 在 `testing.yml` 加 `tests.api-test.openapi: <path>`（絕對 or 相對 `local_path`） |
| ③ | 你只想丟個檔案 | 命名為 `.testing/api/openapi.yaml` / `.yml` / `.json`，pipeline 自動找到 |
| 都無 | 純前端／無 API 的站 | **靜悄悄跳過 api-test，不擋整條流水線** |

### 3.2 範例：用 OpenAPI 自動產 collection

```bash
# 把 OpenAPI 放進專案
mkdir -p /path/to/your-project/.testing/api
cp /somewhere/your-openapi.yaml /path/to/your-project/.testing/api/openapi.yaml

# （可選）填多身分帳密做權限矩陣測試
cd /path/to/your-project/.testing
cp .env.example .env
# 編輯 .env，填 ADMIN_USERNAME / ADMIN_PASSWORD（必要）
# 想驗權限隔離的話再填 USER1_USERNAME / USER1_PASSWORD ...

# 跑
bash link.sh         # 跑全部
# 或只跑 API 測試
bash <pipeline>/scripts/run-project.sh <name> api-test
```

第一次會自動 build 一個 `testing-pipeline-newman` Docker image（內含 `newman` + `openapi-to-postmanv2`），約 1–2 分鐘。

### 3.3 它會做什麼

1. 把 OpenAPI 用 `openapi-to-postmanv2` 轉成 Postman collection（依 OpenAPI Tag 分資料夾，用 spec 裡的 `example` 當 request 範例值）
2. 對每個身分（admin + user1~user5，依 `.env` 填了哪幾組）跑一輪 collection
3. 每個身分產一份 `reports/<name>/raw/newman-junit-<id>.xml`

### 3.4 我有 API、但 OpenAPI 不齊？

兩條路：
- **手寫 Postman collection** 放 `.testing/api/collections/`（最手動）
- **先補一份簡單的 OpenAPI**：只要描述 endpoint 路徑、method、認證方式就能跑契約測試；business 細節後續再補。

---

## 4. 純前端／無 API 的站怎麼辦？

什麼都不用做。pipeline 看不到 OpenAPI 也看不到 collection 時：

- `api-test` / `auth-test` 自動跳過，**不視為錯誤**
- 報告會在「前置檢查警告」段標一行 `api-test：未提供 Postman collection 也未提供 OpenAPI 規格 → 跳過 API 測試`
- 其他測試（SSL / Security / Stress / Lighthouse / Lychee / Monkey / E2E …）照常跑

也就是說，**這條 pipeline 對「純內容站」也是 day-one 可用的**。

---

## 5. 看報告

執行完後：

```bash
<pipeline>/reports/<name>/
├── report.md         ★ 看這個就好（摘要 + 詳細）
├── report.json       結構化版本（n8n / CI 用）
├── history.jsonl     累計執行歷史
└── raw/              工具原始輸出
    ├── testssl-*.html / .json
    ├── zap-report.html / .json
    ├── k6-summary.json
    ├── newman-junit-admin.xml             API 測試：admin 身分
    ├── newman-junit-user1-line_signup.xml API 測試：user1 身分
    ├── playwright/index.html              E2E HTML 報告
    ├── nuclei.jsonl                       深層資安
    ├── lighthouse-*.report.html           前端品質
    ├── monkey-report.json                 Monkey 測試
    ├── trivy-fs.json                      供應鏈掃描
    └── lychee.json                        壞連結
```

`report.md` 開頭是評分卡（11 項測試的一行摘要），下面是每項的詳細與失敗清單。

---

## 6. 常見問題

**Q：我只想驗一個線上網站、沒有原始碼，可以嗎？**
可以。`testing.yml:project.local_path` 設 `""`（空字串），pipeline 會跑 SSL / Security / Stress / Lighthouse / Lychee / Monkey 等遠端測試，自動跳過 static / trivy 這些需要本地原始碼的。

**Q：單元測試呢？**
v0.5 起不在這條 pipeline 範圍內。請在你專案自己的測試資料夾（例 `tests/`）用 PHPUnit / Jest / pytest 等工具自己跑。本 pipeline 專注於黑箱／行為測試。

**Q：我中文路徑會炸嗎？**
盡量避免。Docker volume mount 跨 WSL ↔ Windows 偶爾出包。建議專案放純英數路徑。

**Q：`docker.sock` mount 安全嗎？**
n8n 容器掛了 host 的 `/var/run/docker.sock` + `/mnt/e`，**只適合單機開發環境**。要上雲或多租戶請改 sysbox / rootless docker，或把 `executeCommand` 拆到 sidecar。

**Q：怎麼只跑某一項？**

```bash
bash scripts/run-project.sh <name> ssl              # 只 SSL
bash scripts/run-project.sh <name> api-test          # 只 API
bash scripts/run-project.sh <name> ssl,e2e,api-test  # 多選逗號分隔
bash scripts/run-project.sh <name> REMOTE_ONLY       # preset：只跑遠端
bash scripts/run-project.sh <name> LOCAL_ONLY        # preset：只跑本地
```

完整 scope 列表見 [run-tests.md §3](./run-tests.md#3-執行通用測試)。

---

## 附錄 A：v0.5 release notes

### 移除

- **單元測試（PHPUnit）**：整批移除，包含 `tests/unit/`、`run_unit`、`test-mysql` 容器、`unit-db` profile、`atp-test-net` 網路。請改在專案自己的測試資料夾管理。
- **DB 整合測試（db-test）**：同樣移除。Pipeline 不再啟動 MySQL 容器、不再讀 `.testing/unit/fixtures/*.sql`。

### 新增

- **OpenAPI 自動轉 Postman collection**：偵測到 OpenAPI 規格時，pipeline 用 `openapi-to-postmanv2` 即時產 collection，餵給原本的多身分迴圈。轉換產物放 `.tmp-collections/<name>.postman_collection.json`（gitignore）。
- **API 測試三層偵測 + 安全跳過**：collection → testing.yml 指定的 OpenAPI 路徑 → `.testing/api/openapi.{yaml,yml,json}` → 都無就靜悄悄跳過（不報錯）。

### 變更

- `ALL_SCOPES` / `LOCAL_SCOPES` 不再含 `unit` / `db-test`。
- `summarize.js` 不再產 ⑤ 單元測試區塊（report.md / json / history 同步精簡）。
- n8n workflow `pipeline-skeleton.json` 移除 `10 Unit (PHPUnit)` / `12 DB-Test` 節點與連線。
- 文件全面同步：`README` / `.testing/README.md` / `testing.yml` / `testing-yml-template.yml` / `docs/run-tests.md` / `docs/project-convention.md` / `docs/google-sheets-schema.md`。

### 升級指南（從 v0.4）

1. **如果你之前在用 unit 或 db-test**：把 `.testing/unit/` 內的測試碼搬到專案自己的測試資料夾（例 `tests/`），改在專案自己的 CI 跑。`.testing/unit/fixtures/` 的 SQL 種子若要保留請自行管理。
2. **如果你想用新的 OpenAPI 流程**：把 OpenAPI 檔放成 `.testing/api/openapi.yaml`，刪掉舊的手寫 collection（也可以保留，pipeline 會優先用 collection）。
3. **如果你的 testing.yml 寫了 `tests.unit.*`**：可以全部刪掉，pipeline 已忽略。
4. **重 build n8n image**（這次 Dockerfile 沒改，但 newman image 換了 base）：`bash scripts/build-newman-image.sh`（首次跑 api-test 會自動觸發）。

### 對應 commit

- 移除單元測試：[`427db6d`](https://github.com/jwu0330/automated-testing-pipeline/commit/427db6d)
- API 測試 OpenAPI 機制：[`c8bb5b0`](https://github.com/jwu0330/automated-testing-pipeline/commit/c8bb5b0)
