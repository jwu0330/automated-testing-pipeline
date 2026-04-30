# 測試執行手冊 — Operator Manual

> 本文件是「怎麼用」的操作手冊；「為什麼這樣設計」請見 [project-convention.md](./project-convention.md)。

---

## 目錄

1. [事前準備](#1-事前準備)
2. [註冊第一個專案](#2-註冊第一個專案)
3. [執行通用測試](#3-執行通用測試)
4. [執行專案客製測試](#4-執行專案客製測試)
   - 4.1 E2E 測試 (Playwright)
   - 4.2 API / Auth 測試（Newman，多身分迴圈）
   - 4.3 通用擴充測試（Nuclei / Lighthouse / Monkey / Trivy / Lychee）

> **單元測試已從 pipeline 移除**：請於專案自己的測試資料夾撰寫並執行；本 pipeline 不接管 PHPUnit / DB seed 驗證。
5. [檢視報告](#5-檢視報告)
6. [常見問題 (FAQ)](#6-常見問題-faq)
7. [進階：透過 n8n GUI 排程](#7-進階透過-n8n-gui-排程)

---

## 1. 事前準備

### 1.1 必要工具

| 工具 | 用途 | 驗證指令 |
|---|---|---|
| Docker | 所有測試都在容器內跑 | `docker --version` |
| Docker Compose v2 | 跑 SSL / ZAP / k6 / n8n | `docker compose version` |
| yq（Go 版）| 讀 testing.yml | `yq --version` |
| bash | 跑 `tests/scripts/run-project.sh` | `bash --version` |
| node | 跑 `tests/scripts/summarize.js` | `node --version` |

WSL2 上 Docker 通常由 Docker Desktop 提供；yq 可裝到 `~/.local/bin` 避免 sudo。

### 1.2 啟動 n8n（選配）

如果要用 GUI 排程／手動執行流水線：

```bash
cd /mnt/e/Code/github/automated-testing-pipeline
cp .env.example .env                            # 若尚未建立；編輯填 N8N_PASSWORD
docker compose --profile n8n up -d --build
# 瀏覽器開 http://localhost:5678，匯入 n8n/workflows/pipeline-skeleton.json
```

CLI 跑測試的話可略過這步。

---

## 2. 註冊第一個專案

```bash
# 1. 在專案根目錄建立 .testing/
mkdir -p /path/to/your-project/.testing
cp tests/scripts/testing-yml-template.yml /path/to/your-project/.testing/testing.yml
# 編輯 testing.yml 設定 target_url, php_version 等

# 2. 註冊到 projects.registry.yml
bash tests/scripts/register-project.sh your-project /path/to/your-project
```

完整規範見 [project-convention.md](./project-convention.md)。

---

## 3. 執行通用測試

通用測試的指令格式：`bash tests/scripts/run-project.sh <project> <scope>`

| scope | 工具 | 說明 |
|---|---|---|
| `ssl` | testssl.sh | SSL/TLS 憑證與協定檢查 |
| `security` | OWASP ZAP | 安全弱點掃描基線（XSS/SQLi/CSRF 等） |
| `nuclei` | Nuclei | 深層資安：模板化 CVE / 錯誤配置掃描 |
| `stress` | k6 | 壓力／負載測試 |
| `lighthouse` | Lighthouse | 前端品質：Perf / A11y / 最佳實踐 / SEO |
| `links` | Lychee | 壞連結 / 圖片 404 檢查 |
| `static` | PHPStan | 靜態分析 |
| `trivy` | Trivy fs | 供應鏈：依賴 CVE / 洩漏 secret / 錯誤配置 |
| `e2e` | Playwright | UI/API 端對端測試（見 §4.1） |
| `api-test` | Newman (Postman CLI) | **A3 + B6**：API 端點驗證 + 多身分權限驗證（見 §4.2） |
| `auth-test` | Newman | `api-test` 的 n8n alias，共用同一份 collection |
| `visual-test` | Playwright `--grep C2` | **C2**：視覺基準線比對（只跑 `visual.spec.ts` 中的 C2 describe） |
| `browser-compat` | Playwright `--grep C3` | **C3**：瀏覽器相容（chromium/firefox/webkit，跑 `visual.spec.ts` 中的 C3 describe） |
| `monkey` | Gremlins.js | Monkey 測試：隨機亂點亂打，抓未處理 JS 錯誤 |
| `all`（預設） | 全部 | 依序全部跑一遍、最後產評分卡 |
| `summary` | summarize.js | 僅彙整既有報告成評分卡 |

> **注意**：`auth-test`、`visual-test`、`browser-compat` 是 **n8n workflow 專用的 scope alias**。`all` 走主線（`api-test` 已涵蓋 auth / `e2e` 已涵蓋 visual & compat），不重複。

範例：

```bash
bash tests/scripts/run-project.sh babydodofun ssl              # 只跑 SSL
bash tests/scripts/run-project.sh babydodofun                  # 全部測試 + 評分卡
bash tests/scripts/run-project.sh babydodofun ssl,e2e,lighthouse  # 逗號分隔多選
bash tests/scripts/run-project.sh babydodofun REMOTE_ONLY      # preset：只跑遠端
bash tests/scripts/run-project.sh babydodofun LOCAL_ONLY       # preset：只跑本地
```

### 3.1 Scope 逗號分隔與 Preset（v0.5+）

`run-project.sh` 第 2 個參數支援：

- **單項**（同上表的 scope 名稱）
- **多項逗號分隔**：`ssl,e2e,lighthouse` → 依序跑這三項，去重、末尾自動補 `summary`
- **Preset**（大寫或底線式都可以）：
  - `ALL` / `all` — 全部（預設；同留空）
  - `REMOTE_ONLY` / `remote-only` — `precheck, ssl, security, nuclei, stress, lighthouse, links, monkey`
  - `LOCAL_ONLY` / `local-only` — `static, trivy`

Preset 會在執行前展開成具體 scope 清單，所以你在 log 會看到 `解析 scopes：...` 一行顯示真正會跑的項目。

### 3.2 前置檢查行為：警告後繼續（v0.5+）

從 v0.5 起，`local_path` 不存在不再是致命錯誤：

- `target_url` 空 → **致命**（沒東西可測，exit 1）
- `local_path` 不存在 → **warning**，降級為 URL-only 模式，自動 skip `static / trivy`
- `ADMIN_USERNAME/PASSWORD` 空 → warning，`api-test / auth-test` 會 skip
- `E2E_USERNAME/PASSWORD` 空 → warning，`e2e` 降級為未登入流程
- `target_url` 非 https → warning，`ssl` 會 skip

所有 warning 會寫到 `reports/<project>/warnings.txt`，`summarize.js` 會把它們附到 `report.md` 的「前置檢查警告」段，並在 `report.json` 加入 `warnings: [...]` 陣列。

---

## 3.3 手動觸發（Google Sheets 驅動、純線性 13 節點）

`n8n/workflows/pipeline-skeleton.json`（通用模板 workflow）用 **Google Sheets 當專案清單**，每次跑一個專案。沒有批次、沒有循環。

Sheet 規範與欄位見 [google-sheets-schema.md](./google-sheets-schema.md)。

### 操作流程

1. 打開 http://localhost:5678，開啟 `Testing Pipeline — Universal Template`
2. 點右上 **Execute workflow**
3. 單一 Form（`01 Form Trigger (pick project)`）：dropdown 選一個專案名稱
   - `scopesOverride` 留空就用 Sheet 裡那一列的 scopes；填了會覆寫（支援逗號分隔 / `ALL` / `REMOTE_ONLY` / `LOCAL_ONLY`）
4. Submit 後 workflow 開始跑，n8n executions 頁面可以即時看 08~23 每個測試節點的狀態
5. 跑完產 `reports/<name>/report.md`；要再跑一個專案，回到 1 重來

### 節點流程（純線性）

```
01 Form Trigger (pick project)    (Form 單頁；dropdown 選 project_name + 可選 scopesOverride)
  ↓
02 Sheet — Read Selected Row      (用 filter project_name == {{ projectPick }} 只抓選中那列)
  ↓
03 Resolve + Precheck             (展開 scopes preset + 蒐集 warnings)
  ↓
04 Prepare Write Args             (組 base64 .env)
  ↓
05 Write testing.yml + .env       (write-project-config.sh)
  ↓
06 Extract Path                   (從 stdout 撈 registry path, 順便精簡 JSON)
  ↓
07 Register + write warnings      (register-project.sh + 寫 n8n-precheck-warnings.txt)
  ↓
08 ~ 23                           (測試節點，每個獨立執行：precheck / static /
                                   api-test / links / ssl / trivy / lighthouse /
                                   e2e / visual / browser-compat / nuclei / security / stress / monkey)
  ↓
24 Summary Scorecard              (summarize.js --json)
  ↓
25 Parse Results                  (解析 JSON、合併 warnings、算 overallScore)
  (end)
```

### 設計要點

- **純線性、不循環、不岔路**：每次 Execute 跑一個專案；想跑 N 個就 Execute N 次
- **失敗 surface 到 executions**：所有失敗在 n8n Executions 列表呈現，不寄信
- **關鍵步驟 stopWorkflow**：05 寫設定失敗、07 註冊失敗會直接停（避免下游在錯資料上跑）；08~23 測試節點和 24 Scorecard 用 `continueRegularOutput` 容忍部分測試失敗
- **警告不致命**：03 Precheck 僅在 `project_name` / `target_url` 空時 throw；其他缺欄位只記 warning 並從 scope list 移除對應測試
- **多身分迴圈在 bash 內**：`run-project.sh` 內部對 `api-test` / `auth-test` 會把 `ADMIN_*` / `USER1_*..USER5_*` 各跑一輪，產生 `newman-junit-<id>.xml`；其他測試（ssl/security/nuclei/stress/lighthouse/...）一律跑一次
- **ephemeral 模式**：`local_path` 空或不存在時，`write-project-config.sh` 會寫到 `<pipeline>/.tmp-ephemeral/<name>/`，pipeline 能對純網域站（無本地原始碼）跑測試
- **單頁 Form + Sheet Filter 架構**：01 Form 的 `projectPick` dropdown 選項**寫死**在 workflow JSON 裡（不動態讀 Sheet），02 Sheet 用 `filtersUI` 把 `project_name` 比對 `{{ projectPick }}` 只讀選中那列。這個設計是因為 n8n `formTrigger` 在 Form 渲染前無法先讀 Sheet；試過「多頁 Form（Trigger→Sheet→Code→Form）」但 n8n GUI 會把多頁欄位合併顯示、動態 `fieldOptions` 拿不到資料。代價：**新增 Sheet 列時要同步改 01 節點的 `fieldOptions.values`**。

### 首次設定

匯入 workflow 後，需要在 n8n GUI 做**一次性**設定：

1. **建立 Google Sheets credential**：Credentials 頁面 → 新增 Google Sheets OAuth2 或 Service Account（本 workflow 用 Service Account / `googleApi` 型）→ 授權
2. **確認 credential id 與 JSON 一致**：
   - 查 id：`docker exec n8n n8n export:credentials --all 2>&1 | grep -v Permissions | head -c 500`
   - 比對 workflow JSON `02 Sheet — Read Selected Row` 節點的 `credentials.googleApi.id` 是否相同
   - 若不同（例如你新建的 credential id 不是 `fiuriPKFftRY2Dly`），改 JSON 的 id 重匯即可

Sheet ID / 分頁名 / credential id 都寫死在 workflow JSON 裡，`docker exec n8n n8n import:workflow` 會保留這些值，**不會被清掉**。

目前寫死的設定：
- `documentId`: `11e25lFuf-CtztktJh4pvOaOcB_CQgilLaU6WtEoOeao`（testing-pipeline-batch Sheet；注意第 4 個字元是小寫 L 不是大寫 I）
- `sheetName`: `Sheet1`
- `credentials.googleApi.id`: `fiuriPKFftRY2Dly`（此實例的 `Google Sheets account 2`）

Sheet 建立：檔名 `testing-pipeline-batch`，首個 tab 保留預設 `Sheet1`，首列 header 依 [google-sheets-schema.md](./google-sheets-schema.md) 設定。

### 換不同的 Sheet / tab

1. **方法 A（推薦）**：直接改 `n8n/workflows/pipeline-skeleton.json` 的 `02 Sheet — Read Selected Row` 節點的 `documentId.value` 和 `sheetName.value`，重匯入，保證下次重啟也不會歸零
2. **方法 B（臨時用）**：在 n8n GUI 雙擊 `02 Sheet — Read Selected Row` 改 Document / Sheet 欄位；**但下次執行 `docker exec n8n n8n import:workflow` 會被 JSON 覆寫**，要保留請同步改 JSON

匯入 workflow 的指令：

```bash
docker cp n8n/workflows/pipeline-skeleton.json n8n:/tmp/pipeline.json
docker exec n8n n8n import:workflow --input=/tmp/pipeline.json
```

### 為什麼重啟後 GUI 的改動會消失？

n8n 容器是 **DooD（Docker-out-of-Docker）** 模式，workflow 儲存在容器內的 SQLite。但每次 `docker exec ... import:workflow` 會**以 JSON 檔為準**覆寫 DB 裡的 workflow。所以：

- GUI 改 → 只存在 DB → `n8n import:workflow` 會覆蓋掉
- JSON 改 + 重匯 → 變成新的「真相來源」→ GUI 跟著變

解法：**把「想保留的設定」都寫進 JSON**（Sheet ID、tab name、固定的 timeout 等）；只有**每次執行要變動的**（prompt 帶的 projectPick）才在 GUI 互動。

### ⚠️ n8n 節點編輯常見坑（寫 / 改 workflow JSON 時檢查清單）

n8n 某些節點有**必填欄位**，漏填會在 GUI 顯示紅色三角警告、Execute 步驟失敗。以下是本 pipeline 用到的節點、各自的必填欄位清單。**修改 JSON 後務必逐項對照，避免重複踩坑**。

#### `n8n-nodes-base.form` (中間 Form, typeVersion 1)

必填：
- `parameters.operation`：`"page"`（中間 Form，送出後繼續往下）或 `"completion"`（終點，顯示完成畫面）
- `parameters.formTitle`：字串
- `parameters.formFields.values[]`：至少 1 個 field
- 每個 field 必填 `fieldLabel`；若 `fieldType: "dropdown"` 則必填 `fieldOptions.values`（可用 expression 如 `={{ $json.options }}`）
- `parameters.options.respondWith`：`"showText"` 或 `"redirect"`
- `parameters.options.formSubmittedText`（若 respondWith=showText）：送出後顯示的文字

過去踩過的坑：
- ❌ 漏填 `options.respondWith` + `formSubmittedText` → GUI 噴紅三角、Execute 失敗
- ❌ `operation: "completion"` 卻當中間 Form 用 → 送出後 workflow 停在這裡、下游不執行
- ✅ 中間 Form 要用 `operation: "page"`
- ❌ **`form` 節點前面用 `manualTrigger`** → 執行時噴 `An n8n Form Trigger node must be set up before this node`。n8n 的「多頁表單」流程強制要求起點是 `formTrigger`，`manualTrigger` 不被認可。

#### `n8n-nodes-base.formTrigger` (起點 Form Trigger)

- 只能當 workflow 起點，不能放中間
- **若下游有 `form` 節點（多頁表單），起點一定要用 `formTrigger`**；用 `manualTrigger` 會在下游 form 節點噴「must be set up before this node」
- **`formTrigger` 至少要有 1 個 field**（哪怕是假的佔位欄位）。若設 `formFields.values: []`，n8n GUI 會把 01 和下一個 `form` 節點的欄位合併在同一頁顯示，導致下游 `form` 節點動態 `fieldOptions: {{ $json.options }}` 拿不到資料（Sheet 還沒讀就渲染了）。
- 實務做法：01 放一個單選 dropdown（如 `ready=start`）當佔位，讓 01 成為真正獨立的第一頁，下游 `form` 節點才會被當成第二頁、等 Sheet/Code 跑完後才渲染。

#### `n8n-nodes-base.googleSheets` (typeVersion 4.5)

必填：
- `parameters.operation`：`"read"` / `"append"` / ...
- `parameters.documentId`：`{ "__rl": true, "value": "...", "mode": "id" }`（**不是直接寫字串**，必須包 resourceLocator 物件）
- `parameters.sheetName`：`{ "__rl": true, "value": "Sheet1", "mode": "name" }`（或 `"mode": "list"` + `value: gid`）
- `credentials`：Google Sheets / Google API 類節點要綁 OAuth credential
- **credential 綁定可以寫進 JSON**（早期誤判為不行）：在節點加 `"credentials": { "googleApi": { "id": "<id>", "name": "<name>" } }`；重匯 JSON 不會清掉
- 第一次建立 credential 必須手動在 GUI 做（OAuth 授權流程無法自動化）。之後：
  1. 查 credential id：`docker exec n8n n8n export:credentials --all 2>&1 | grep -v Permissions | head -c 500` — 只看 id / name / type，不要用 `--decrypted`（會吐 private key 到螢幕）
  2. 複製到節點 JSON 的 `credentials` 欄位
  3. 以後重匯就不會再掉綁定
- 如果真的被清掉（例如換 n8n 實例、credential 被重建）：開節點 → Credential 下拉重選 → Execute step 驗證 → Save

#### `n8n-nodes-base.executeCommand` (typeVersion 1)

- `parameters.command`：字串；expression 型如 `={{ ... }}`
- 可選 `parameters.options.executionTimeout`：毫秒；不設預設 2 分鐘，**長時間測試必加**
- `onError`：`"stopWorkflow"` / `"continueRegularOutput"` / `"continueErrorOutput"`；注意 `continueErrorOutput` 會產生錯誤出口，若沒連下游錯誤會被吞掉

#### `n8n-nodes-base.code` (typeVersion 2)

- `parameters.mode`：`"runOnceForAllItems"` 或 `"runOnceForEachItem"`
- `parameters.jsCode`：JS；`runOnceForEachItem` 模式用 `$json`，`runOnceForAllItems` 用 `$input.all()`

#### 跨節點通則

- `id` 欄位每個節點必須唯一；連線表 `connections` 的 key 是**節點 name**（不是 id）
- 改 node name 時，**connections key 要跟著改**，否則匯入後連線斷掉
- 有紅三角警告的節點 → 先在 GUI 手動把警告全消掉再儲存；不確定就去 n8n 官方節點文件對照

---

## 4. 執行專案客製測試

> **單元測試已從 pipeline 移除**：請於專案自己的測試資料夾撰寫並執行。pipeline 不再提供 `unit` / `db-test` scope、不再啟動 `test-mysql` 容器。

### 4.1 E2E 測試 (Playwright)

#### 4.2.1 專案需要的檔案

```
<project>/.testing/e2e/
├── package.json             # 指定 @playwright/test 版本
├── playwright.config.ts     # baseURL、reporter 等設定
├── .gitignore               # 排除 node_modules、test-results
└── tests/
    └── *.spec.ts            # Playwright 測試 spec
```

**重要：`@playwright/test` 版本必須精確匹配 pipeline 使用的 docker image**（目前 `1.59.1`）。寫成 `"@playwright/test": "1.59.1"`，**不要加 caret `^`**。否則 `npm install` 會拉到最新版但 docker 內瀏覽器還是舊版，導致 `Executable doesn't exist` 錯誤。

#### 4.2.2 從範本建立

```bash
# 複製整個 e2e/ 骨架
mkdir -p .testing/e2e/tests
cp -r /mnt/e/Code/github/automated-testing-pipeline/tests/e2e/* \
      .testing/e2e/

# 依專案需求修改 playwright.config.ts 的 baseURL / projects
# 依要測的路由修改 tests/smoke.spec.ts / 新增 routes.spec.ts
```

#### 4.2.3 執行

```bash
bash tests/scripts/run-project.sh <project> e2e
```

首次會 pull `mcr.microsoft.com/playwright:v1.59.1-noble`（約 2 GB，一次）。後續每次跑 `npm install` 約 30 秒 + 測試本身。

如果專案已有 `package-lock.json` 則用 `npm ci`（快、鎖定版本）；否則 fallback 到 `npm install`。

#### 4.2.4 真實範例：babydodofun smoke + routes

babydodofun 的 E2E 設計原則是**只讀**：不登入、不寫資料、不觸發 LINE / SMS。

- `smoke.spec.ts`：`/`、`/login.html`、`/api/health.php` 可達 + 安全標頭
- `routes.spec.ts`：`/liff/*`、`/member/*`、`/admin/*` 等 6 條路由存在（允許 2xx/3xx/401/403；拒絕 404/5xx）

執行結果：

```
17 passed (6.7s)
```

寫資料類的測試（建會員、加點數、開發票）需要 staging DB 環境，因此沒在這次做；未來要補時，從舊的 `local/qa/unit/round1-5/` 把邏輯移植成 Playwright `request.post()` 呼叫即可。

#### 4.2.5 報告位置

| 檔案 | 內容 |
|---|---|
| `reports/<project>/raw/playwright/index.html` | Playwright HTML 報告（trace、screenshot） |
| `reports/<project>/raw/playwright-junit.xml` | JUnit XML（給 summarize.js 解析） |

---

### 4.3 API / Auth 測試（Newman，多身分迴圈）

> 這一節對應 n8n workflow 的 **A3 API Validation** + **B6 Auth & Permission**。
> 兩個 n8n 節點都呼叫 `api-test` / `auth-test` scope，共用同一份 Postman collection；每個身分跑一輪完整 collection。

#### 4.3.1 專案需要的檔案

```
<project>/.testing/
├── api/collections/
│   └── <project>.postman_collection.json   # Postman collection v2.1（必須）
└── .env                                    # 身分帳密（選填；需要才填）
```

#### 4.3.2 身分設計（最多 6 組：1 ADMIN + 5 USER）

在 `.testing/.env` 填：

```bash
# 管理者（寫死預設，除非該站不同才覆寫）
ADMIN_USERNAME=admin001
ADMIN_PASSWORD=@admin001

# 一般使用者 1..5（選填；留空 → 該輪整輪 skip）
USER1_USERNAME=
USER1_PASSWORD=
USER1_LABEL=line_signup         # 顯示在報告檔名

USER2_USERNAME=
USER2_PASSWORD=
USER2_LABEL=phone_signup

# USER3_ / USER4_ / USER5_ 同理
```

**行為**：給 3 組帳密就跑 3 輪、給 5 組就跑 5 輪。每輪是一次完整 collection 執行，用不同身分登入、驗權限邊界。

#### 4.3.3 Collection 如何讀身分

`run-project.sh` 會對每個有填帳密的身分執行 Newman，注入：

| 變數 | 值 |
|------|----|
| `{{CURRENT_IDENTITY}}` | `admin` / `user1` / `user2` / ... |
| `{{CURRENT_USERNAME}}` | 該身分帳號 |
| `{{CURRENT_PASSWORD}}` | 該身分密碼 |
| `{{CURRENT_LABEL}}` | 該身分標籤（如 `line_signup`；可空） |
| `{{base_url}}` | `project.target_url` |

Collection test script 範例（以角色決定預期狀態）：

```javascript
const role = pm.variables.get('CURRENT_IDENTITY');

if (role === 'admin') {
  pm.test('管理者可存取 admin API', () => pm.response.to.have.status(200));
} else {
  pm.test('一般使用者不可存取 admin API', () => {
    pm.expect([401, 403]).to.include(pm.response.code);
  });
}
```

#### 4.3.4 執行

```bash
bash tests/scripts/run-project.sh <project> api-test       # 跑所有身分輪
bash tests/scripts/run-project.sh <project> auth-test      # 同上（n8n alias）
```

首次會從 `tests/scripts/build-newman-image.sh` 建 `testing-pipeline-newman:latest`（Newman 6.x + 內建 junit reporter）。

#### 4.3.5 報告

每個身分獨立一份 XML：

```
reports/<project>/raw/
├── newman-junit-admin.xml                  管理者身分
├── newman-junit-user1-line_signup.xml      一般使用者 1（LINE 註冊）
├── newman-junit-user2-phone_signup.xml     一般使用者 2（手機註冊）
├── newman-admin.json                       cli + json 報告
├── newman-user1-line_signup.json
├── ...
└── newman-junit.xml                        最後一輪副本（summarize.js 解析）
```

> **補充**：目前 `summarize.js` 只解析 `newman-junit.xml`（最後一輪副本）。若要讓評分卡彙總所有身分，未來會改成 glob 所有 `newman-junit-*.xml`。現在你能從 `raw/` 目錄直接看到每個身分的結果。

---

### 4.4 通用擴充測試（Nuclei / Lighthouse / Monkey / Trivy / Lychee）

這五個工具皆為**流水線通用**（不需要專案客製測試碼），依 `target_url` 與 `local_path` 自動啟用。

#### 4.4.1 Nuclei — 深層資安

補 ZAP baseline 抓不到的 CVE / 錯誤配置 / 洩漏端點。用 ProjectDiscovery 模板引擎。

```bash
bash tests/scripts/run-project.sh <project> nuclei
```

設定（`testing.yml` 可選）：

```yaml
tests:
  nuclei:
    severity: "critical,high,medium"   # 預設；加 low/info 會變超慢
    rate_limit: 50                     # req/s，共享主機建議 ≤ 50
```

首次會 pull `projectdiscovery/nuclei:latest`（約 200 MB）。模板自動內嵌 image，無需手動更新；要最新 CVE 請定期 `docker pull`。

#### 4.4.2 Lighthouse — 前端品質

Core Web Vitals / A11y / Best Practices / SEO 四項分數 + LCP / CLS / TBT 指標。

```bash
bash tests/scripts/run-project.sh <project> lighthouse
```

設定：

```yaml
tests:
  lighthouse:
    preset: desktop            # desktop | mobile
    pages: [/, /login.html]    # 預設 [/]
```

首次會 build `lighthouse:latest` image（`node:20-slim + chromium + lighthouse@12`，約 1 GB，一次）。

#### 4.4.3 Monkey — Gremlins.js 互動探測

注入 gremlins.js 做隨機點擊/打字/滾動，監聽 `pageerror` 未捕獲例外。**抓 E2E spec 寫不到的邊界 bug**。

```bash
bash tests/scripts/run-project.sh <project> monkey
```

設定：

```yaml
tests:
  monkey:
    pages: [/, /login.html]    # 預設 [/]
    attacks: 500               # 總攻擊次數
    delay_ms: 10               # 每次間隔；總耗時 ≈ attacks * delay_ms
```

重用 E2E 的 Playwright image，不需額外空間。注入 `gremlins.js` 來自 unpkg CDN，需外網連線。

#### 4.4.4 Trivy — 供應鏈掃描

同時掃 **依賴 CVE / 洩漏 secret / 錯誤配置** 三類。需要 `local_path`。

```bash
bash tests/scripts/run-project.sh <project> trivy
```

設定：

```yaml
tests:
  trivy:
    severity: "CRITICAL,HIGH,MEDIUM"     # 注意大寫
    scanners: "vuln,secret,misconfig"    # 可省略某項
```

用 `atp-trivy-cache` docker volume 快取 CVE DB，第二次之後跑很快（< 10 秒）。

#### 4.4.5 Lychee — 壞連結檢查

Rust 寫的超快連結檢查器，驗證頁面上所有 `<a>` / `<img>` / `<script>` 是否可達。

```bash
bash tests/scripts/run-project.sh <project> links
```

設定：

```yaml
tests:
  links:
    timeout: 15              # 單一連結逾時秒數
    max_concurrency: 4       # 高的話容易被 rate limit
```

若目標站引用很多社群連結（FB / IG）會出大量 403，目前骨架未加 exclude 規則，未來會在 testing.yml 補 `exclude` 陣列。

---

## 5. 檢視報告

### 5.1 統一報告（建議的總覽）

```bash
bash tests/scripts/run-project.sh <project> summary
# 或跑全套時最後會自動產：
bash tests/scripts/run-project.sh <project>
```

兩份一起產：

- `reports/<project>/report.md` — 人類可讀，摘要 + 詳細一檔
- `reports/<project>/report.json` — 結構化（給 n8n、CI、Grafana）

評分卡的總覽段落範例：

```
① SSL/TLS         A+  (93/100)  [=]
② 靜態分析        22 個錯誤
③ 資安掃描        H=0 M=2 L=7 I=4
④ 壓力測試        p95=16ms  fail=0.00%  reqs=1450
⑥ E2E             18/18 pass
⑦ 深層資安        C=0 H=1 M=3 L=5
⑧ 前端品質        Perf=82 A11y=95 BP=93 SEO=100
⑨ 互動探測        1/1 pass
⑩ 供應鏈          C=0 H=2 M=7  secrets=0  misconfig=1
⑪ 連結檢查        48/52 OK  broken=4
```

`[=]` / `[↓-1 改善]` 是和上次執行相比的趨勢。

### 5.2 詳細檔

```
reports/<project>/
├── report.md              ★ 統一入口（摘要 + 詳細）
├── report.json            結構化
├── history.jsonl          累計執行歷史（append-only）
└── raw/                   工具原始輸出
    ├── testssl-<ts>.html / .json
    ├── phpstan.json / phpstan-errors.md
    ├── zap-report.html / .json
    ├── k6-summary.json
    ├── playwright/index.html
    ├── playwright-junit.xml
    ├── nuclei.jsonl                       # ★ Nuclei 一行一 finding
    ├── lighthouse-manifest.json           # ★ Lighthouse 摘要
    ├── lighthouse-*-*.report.{html,json}  # ★ 每頁完整報告
    ├── monkey-report.json                 # ★ Monkey JSON
    ├── monkey-html/index.html             # ★ Monkey HTML
    ├── trivy-fs.json                      # ★ Trivy 供應鏈
    └── lychee.json                        # ★ Lychee 壞連結
```

### 5.3 n8n GUI

打開 http://localhost:5678，`Execute workflow`，最後一個節點 `Parse Scorecard — 結構化評分` 把 JSON 展開成欄位後，可在 n8n 的 Schema 面板直接檢視每項測試結果。

流程：`Show Scorecard — 評分卡彙整` 呼叫 `summarize.js --json` 輸出 JSON → `Parse Scorecard` 節點 `JSON.parse` 成結構化物件 → Schema 面板逐欄顯示 ssl.grade / phpstan.total / e2e.tests 等。

---

## 6. 常見問題 (FAQ)

### Q: `npm ci` 失敗「lock file does not satisfy ...」

A: 常見於升版 `@playwright/test` 之後。刪掉 lockfile 重跑：

```bash
rm <project>/.testing/e2e/package-lock.json
rm -rf <project>/.testing/e2e/node_modules
bash tests/scripts/run-project.sh <project> e2e
```

### Q: Playwright 報「Executable doesn't exist at ...」

A: package.json 的 `@playwright/test` 版本和 pipeline 的 docker image 對不上。把版本號寫**精確值**（如 `"1.59.1"`），不要 caret。

### Q: ZAP 回傳 exit code 2 算失敗嗎？

A: 不算。ZAP 用 exit code 表達「有警告」；`run-project.sh` 已用 `|| echo ...` 吞掉，會繼續跑下一項。

---

## 7. 進階：透過 n8n GUI 排程

`n8n/workflows/pipeline-skeleton.json` 匯入後的 workflow 採**三路並行架構**：

### 整體流程圖

```
Manual Trigger — 手動觸發
  → 01 Init - Set Project Vars — 設定專案
  → 02 Precheck - Health Check — URL 探測
  
  分成三條並行路線：

【路線 A：本地端測試】      【路線 B：資安 & 壓力測試】  【路線 C：使用者層面測試】
├─ A1 Static Analysis      ├─ B1 SSL Scan            ├─ C1 E2E Tests
├─ A2 Unit Tests           ├─ B2 ZAP                 ├─ C2 Visual Comparison (空)
├─ A3 API Validation (空)  ├─ B3 Nuclei              ├─ C3 Browser Compatibility (空)
└─ A4 DB Validation (空)   ├─ B4 Trivy               ├─ C4 Lighthouse
                           ├─ B5 Load Test           ├─ C5 Link Check
                           └─ B6 Auth & Permission (空) └─ C6 Monkey Testing
  
  三路匯聚：
  → Report - Generate Scorecard — 評分卡彙整（JSON 輸出）
  → Report - Parse Results — 結構化評分（n8n Schema 可直接分欄顯示）
```

### 三條路線說明

| 路線 | 名稱 | 節點 | 特點 |
|------|------|------|------|
| **A** | 本地端測試 | A1–A4 | 針對原始碼與本地邏輯，無外網需求 |
| **B** | 資安 & 壓力 | B1–B6 | 針對安全性與效能，遠端網路掃描 |
| **C** | 使用者層面 | C1–C6 | 針對 UI 和用戶體驗，相容性與互動 |

### 節點預留（"空"）與工具選型

以下節點標註為「(空)」，表示功能框架已預留，待實作。已評選最適合的工具：

| 節點 | 工具選擇 | 說明 |
|------|---------|------|
| **A3 API Validation (空)** | **Newman** (Postman CLI) | API 端點驗證；業界標準，支援複雜 auth/token、豐富報告 |
| **A4 DB Validation (空)** | **自製 Migration + Seed 驗證** | 驗證 schema 版本一致性 + 初始資料完整；輕量無額外依賴 |
| **B6 Auth & Permission (空)** | **Postman** (複用 API 集合) | 身分與權限驗證；複用 A3 的 API 集合新增權限 test case |
| **C2 Visual Comparison (空)** | **Playwright Visual Comparisons** | 視覺迴歸測試；與現有 E2E 框架同堆疊，內建無額外工具 |
| **C3 Browser Compatibility (空)** | **Playwright Projects** | 瀏覽器相容性測試；支援 chromium/firefox/webkit 多引擎本地驗證 |

**選型原則**：
- 最廣泛支援 × 最小依賴 × 已驗證可靠
- 優先複用現有堆疊（Playwright）避免工具爆炸
- API/Auth 合併為同一 Newman 集合，減少配置複雜度

### 防禦機制

- 所有節點設定 `onError: continueRegularOutput`（繼續執行下一步）
- 前面步驟失敗**不會**阻擋後面路線（既有 `|| echo` 模式保留）
- 三路獨立並行，任何一路失敗都不影響其他路線

### 排程與專案切換

要排程：`Manual Trigger` 換成 `Schedule Trigger`（n8n 內建）
要換專案：雙擊 `01 Init - Set Project Vars` 修改 `projectName`

匯入：

```bash
docker cp n8n/workflows/pipeline-skeleton.json n8n:/tmp/pipeline.json
docker exec n8n n8n import:workflow --input=/tmp/pipeline.json
```
