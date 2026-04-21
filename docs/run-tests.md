# 測試執行手冊 — Operator Manual

> 本文件是「怎麼用」的操作手冊；「為什麼這樣設計」請見 [project-convention.md](./project-convention.md)。

---

## 目錄

1. [事前準備](#1-事前準備)
2. [註冊第一個專案](#2-註冊第一個專案)
3. [執行通用測試](#3-執行通用測試)
4. [執行專案客製測試](#4-執行專案客製測試)
   - 4.1 單元測試 (PHPUnit)
   - 4.2 E2E 測試 (Playwright)
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
| bash | 跑 `scripts/run-project.sh` | `bash --version` |
| node | 跑 `scripts/summarize.js` | `node --version` |

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
cp scripts/testing-yml-template.yml /path/to/your-project/.testing/testing.yml
# 編輯 testing.yml 設定 target_url, php_version 等

# 2. 註冊到 projects.registry.yml
bash scripts/register-project.sh your-project /path/to/your-project
```

完整規範見 [project-convention.md](./project-convention.md)。

---

## 3. 執行通用測試

通用測試的指令格式：`bash scripts/run-project.sh <project> <scope>`

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
| `unit` | PHPUnit | 單元測試（見 §4.1） |
| `e2e` | Playwright | UI/API 端對端測試（見 §4.2） |
| `monkey` | Gremlins.js | Monkey 測試：隨機亂點亂打，抓未處理 JS 錯誤 |
| `all`（預設） | 全部 | 依序全部跑一遍、最後產評分卡 |
| `summary` | summarize.js | 僅彙整既有報告成評分卡 |

範例：

```bash
bash scripts/run-project.sh babydodofun ssl        # 只跑 SSL
bash scripts/run-project.sh babydodofun            # 全部測試 + 評分卡
```

---

## 4. 執行專案客製測試

### 4.1 單元測試 (PHPUnit)

#### 4.1.1 專案需要的檔案

```
<project>/.testing/unit/
├── phpunit.xml              # PHPUnit 設定（可從 tests/unit/phpunit.xml.dist 複製）
├── bootstrap.php            # 載入待測程式碼 + 注入 stub
├── stubs.php                # 函式 stub（視專案而定，可為空）
└── tests/
    └── *Test.php            # PHPUnit 測試類別
```

啟用條件（schema v2）：`phpunit.xml` 存在 → 自動啟用；無需在 `testing.yml` 設任何欄位。想強制停用：`testing.yml` 加 `tests.unit.enabled: false`。

**若測試需要 DB**，在 `.testing/unit/fixtures/` 放任一個 `.sql` 檔即可自動觸發 DB 整合模式（見 §4.1.6）。

#### 4.1.2 從範本建立

```bash
# 進入專案目錄
cd /path/to/your-project

# 複製範本
mkdir -p .testing/unit/tests
cp /mnt/e/Code/github/automated-testing-pipeline/tests/unit/phpunit.xml.dist \
   .testing/unit/phpunit.xml
cp /mnt/e/Code/github/automated-testing-pipeline/tests/unit/bootstrap.php.dist \
   .testing/unit/bootstrap.php

# 依專案原始碼路徑修改 phpunit.xml 內 <source><include> 區塊
# 依專案 autoload 狀況修改 bootstrap.php
```

#### 4.1.3 執行

```bash
bash scripts/run-project.sh <project> unit
```

首次會自動建置 `testing-pipeline-phpunit:php<版本>` image（含 pcov 覆蓋率擴充），約 1–2 分鐘。

#### 4.1.4 真實範例：babydodofun 的 6 個純函式

babydodofun 的 `public/api/member_helpers.php` 裡有 6 個無 DB 耦合的純函式（validatePhone / validateDate / validateLength / calculateExpiry / validateMemberNo / isPhoneRegistered），加上 4 個資料轉換函式（getLevelLabel / getLevelPreset / buildBalanceFlex / buildDeductConfirmFlex）。

實際設定：

- `.testing/unit/phpunit.xml` → `<source><include><file>../../public/api/member_helpers.php</file></include></source>`
- `.testing/unit/bootstrap.php` → `require_once __DIR__ . '/../../public/api/member_helpers.php';`
- `.testing/unit/tests/MemberHelpersTest.php` → 10 個函式、約 30 個 test method、約 113 個 assertion

執行結果：

```
OK (83 tests, 113 assertions)
Lines:   29.41% (70/238)
```

剩下 70% 是 DB / LINE API / SMS API 依賴，不適合做純單元測試。DB 依賴的部分由 §4.1.6 的整合測試覆蓋。

#### 4.1.6 DB 整合測試（test-mysql 容器）

**觸發**：專案的 `.testing/unit/fixtures/` 存在任一 `.sql` 檔時自動啟用。pipeline 會：

1. `docker compose --profile unit-db up -d test-mysql`（MySQL 8.0，tmpfs，用後即棄）
2. 等 root 認證 ready（真實 `SELECT 1`，非只 `mysqladmin ping`）
3. 載入 schema：`<project>/database/init.sql`
4. 依檔名排序載入 `.testing/unit/fixtures/*.sql`
5. `docker run` PHPUnit 時加入 `--network=atp-test-net`，注入 `TEST_DB_HOST=test-mysql` 等 5 個 env
6. 測試完 → `docker compose --profile unit-db down -v`（容器與 tmpfs 一起消失）

**在測試中連 DB**：兩條路

```php
// 路 A：用 pipeline 提供的 testDb()
class MyIntegrationTest extends TestCase {
    public function testX(): void {
        $pdo = testDb();  // bootstrap.php.dist 範例 C 提供
        $pdo->exec('INSERT INTO ...');
    }
}

// 路 B：用專案自己的 db()，前提是 env.php 支援 APP_ENV=testing
// bootstrap.php 把 TEST_DB_* 映射到專案習慣的 DB_* env var
// 然後 db() 透過 env('DB_HOST') → getenv('DB_HOST') 就會拿到 test-mysql
```

**專案必須遵守的合約**（`env()` 必須在 `APP_ENV=testing` 時跳過 `config.local.php` 之類的本地設定檔），詳見 [project-convention.md §5.4](./project-convention.md#54-專案必須支援的合約重要)。

**避免測試資料與 fixture 碰撞**：整合測試建的 test member `member_no` 用未來日期前綴；base class 的 `tearDownAfterClass` 依 class 前綴清掉。見 [project-convention.md §5.5](./project-convention.md#55-避免測試資料與-fixture-碰撞)。

#### 4.1.7 真實範例：babydodofun 3 個 DB 整合測試類

babydodofun 的 `.testing/unit/tests/` 下有 3 個 DB 整合測試類（extends `IntegrationTestCase`）：

- **`MemberHelpersDbTest`**（13 tests）— `auditLog` / `autoDowngradeIfNeeded` / `reconcilePointBalance` / `generateMemberNo` 的 DB 行為
- **`SchemaInvariantsTest`**（12 tests）— ENUM 值齊全、索引存在、欄位類型
- **`DataIntegrityTest`**（8 tests）— 跨表不變式（無孤兒、point_balance 一致、deleted 必有 deleted_at）

加上 2 個純 unit（MemberHelpersTest 83、LoggerTest 10），一次 `run-project.sh babydodofun unit` 會跑 **129 tests / 237 assertions / 覆蓋率 59.9%**（含 DB 行為，覆蓋率從純 unit 的 32% → 60%）。

#### 4.1.8 報告位置

| 檔案 | 內容 |
|---|---|
| `reports/<project>/raw/phpunit.xml` | JUnit XML（給 summarize.js 解析） |
| `reports/<project>/raw/coverage/index.html` | 覆蓋率 HTML 報告（逐行點開） |
| `reports/<project>/raw/phpunit-clover.xml` | Clover XML（給 Codecov 等工具） |
| `reports/<project>/raw/phpunit-coverage.txt` | 純文字摘要 |

---

### 4.2 E2E 測試 (Playwright)

#### 4.2.1 專案需要的檔案

```
<project>/.testing/e2e/
├── package.json             # 指定 @playwright/test 版本
├── playwright.config.ts     # baseURL、reporter 等設定
├── .gitignore               # 排除 node_modules、test-results
└── tests/
    └── *.spec.ts            # Playwright 測試 spec
```

**重要：`@playwright/test` 版本必須精確匹配 pipeline 使用的 docker image**（目前 `1.52.0`）。寫成 `"@playwright/test": "1.52.0"`，**不要加 caret `^`**。否則 `npm install` 會拉到最新版但 docker 內瀏覽器還是舊版，導致 `Executable doesn't exist` 錯誤。

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
bash scripts/run-project.sh <project> e2e
```

首次會 pull `mcr.microsoft.com/playwright:v1.52.0-noble`（約 2 GB，一次）。後續每次跑 `npm install` 約 30 秒 + 測試本身。

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

### 4.3 通用擴充測試（Nuclei / Lighthouse / Monkey / Trivy / Lychee）

這五個工具皆為**流水線通用**（不需要專案客製測試碼），依 `target_url` 與 `local_path` 自動啟用。

#### 4.3.1 Nuclei — 深層資安

補 ZAP baseline 抓不到的 CVE / 錯誤配置 / 洩漏端點。用 ProjectDiscovery 模板引擎。

```bash
bash scripts/run-project.sh <project> nuclei
```

設定（`testing.yml` 可選）：

```yaml
tests:
  nuclei:
    severity: "critical,high,medium"   # 預設；加 low/info 會變超慢
    rate_limit: 50                     # req/s，共享主機建議 ≤ 50
```

首次會 pull `projectdiscovery/nuclei:latest`（約 200 MB）。模板自動內嵌 image，無需手動更新；要最新 CVE 請定期 `docker pull`。

#### 4.3.2 Lighthouse — 前端品質

Core Web Vitals / A11y / Best Practices / SEO 四項分數 + LCP / CLS / TBT 指標。

```bash
bash scripts/run-project.sh <project> lighthouse
```

設定：

```yaml
tests:
  lighthouse:
    preset: desktop            # desktop | mobile
    pages: [/, /login.html]    # 預設 [/]
```

首次會 build `lighthouse:latest` image（`node:20-slim + chromium + lighthouse@12`，約 1 GB，一次）。

#### 4.3.3 Monkey — Gremlins.js 互動探測

注入 gremlins.js 做隨機點擊/打字/滾動，監聽 `pageerror` 未捕獲例外。**抓 E2E spec 寫不到的邊界 bug**。

```bash
bash scripts/run-project.sh <project> monkey
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

#### 4.3.4 Trivy — 供應鏈掃描

同時掃 **依賴 CVE / 洩漏 secret / 錯誤配置** 三類。需要 `local_path`。

```bash
bash scripts/run-project.sh <project> trivy
```

設定：

```yaml
tests:
  trivy:
    severity: "CRITICAL,HIGH,MEDIUM"     # 注意大寫
    scanners: "vuln,secret,misconfig"    # 可省略某項
```

用 `atp-trivy-cache` docker volume 快取 CVE DB，第二次之後跑很快（< 10 秒）。

#### 4.3.5 Lychee — 壞連結檢查

Rust 寫的超快連結檢查器，驗證頁面上所有 `<a>` / `<img>` / `<script>` 是否可達。

```bash
bash scripts/run-project.sh <project> links
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
bash scripts/run-project.sh <project> summary
# 或跑全套時最後會自動產：
bash scripts/run-project.sh <project>
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
⑤ 單元測試        129/129 pass, cov=59.9%
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
    ├── phpunit.xml
    ├── phpunit-coverage.txt
    ├── coverage/index.html
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

流程：`Show Scorecard — 評分卡彙整` 呼叫 `summarize.js --json` 輸出 JSON → `Parse Scorecard` 節點 `JSON.parse` 成結構化物件 → Schema 面板逐欄顯示 ssl.grade / phpstan.total / phpunit.tests 等。

---

## 6. 常見問題 (FAQ)

### Q: `npm ci` 失敗「lock file does not satisfy ...」

A: 常見於升版 `@playwright/test` 之後。刪掉 lockfile 重跑：

```bash
rm <project>/.testing/e2e/package-lock.json
rm -rf <project>/.testing/e2e/node_modules
bash scripts/run-project.sh <project> e2e
```

### Q: PHPUnit coverage 顯示 `Lines: 0.00% (0/...)`

A: pcov 的 `pcov.directory` 沒指到專案。Pipeline 內已在 Dockerfile 寫死 `pcov.directory=/project`，如果還是 0%，確認 `phpunit.xml` 的 `<source><include>` 路徑正確（應為 `../../public/xxx`，以 `phpunit.xml` 位置為基準）。

### Q: PHPUnit 遇到 `Cannot redeclare function X()`

A: bootstrap.php 或 stubs.php 先宣告了一個該專案原始碼也會宣告的函式。把重複的拿掉；如果真的需要覆蓋行為，得用 runkit/uopz PHP 擴充（pipeline 預設沒裝）。

### Q: Playwright 報「Executable doesn't exist at ...」

A: package.json 的 `@playwright/test` 版本和 pipeline 的 docker image 對不上。把版本號寫**精確值**（如 `"1.52.0"`），不要 caret。

### Q: ZAP 回傳 exit code 2 算失敗嗎？

A: 不算。ZAP 用 exit code 表達「有警告」；`run-project.sh` 已用 `|| echo ...` 吞掉，會繼續跑下一項。

### Q: DB 整合測試 connection refused / No such file or directory

A: 專案的 `env()` 沒有在 `APP_ENV=testing` 時跳過 `config.local.php`（或類似本地設定檔）。env() 會優先回傳 config 檔的 `DB_HOST=localhost`，覆蓋 pipeline 注入的 `DB_HOST=test-mysql`。請參照 [project-convention.md §5.4](./project-convention.md#54-專案必須支援的合約重要) 修 env 函式。

### Q: DB 整合測試全部 PDOException: could not find driver

A: PHPUnit 容器沒有 `pdo_mysql` 擴充。刪掉舊 image 重 build：

```bash
docker rmi testing-pipeline-phpunit:php8.1
docker build --build-arg PHP_VERSION=8.1 -t testing-pipeline-phpunit:php8.1 tests/unit/
```

### Q: test-mysql 啟動後第一次跑遇 Access denied for user 'root'

A: `mysqladmin ping` 在 TCP socket 開啟時就 pass，但 root 密碼初始化稍晚。pipeline 已改用 `mysql -uroot -ptest -e "SELECT 1"` 做真實認證等待；若還是遇到，檢查 `start_test_db()` 的 tries 上限是否過低（預設 45 秒應足夠）。

### Q: 第二次跑 init.sql 遇 Duplicate entry 'admin001'

A: test-mysql 容器第一次跑完沒銷毀就再跑一次，init.sql 重複載入。pipeline 正常流程會在 `run_unit()` 尾端呼叫 `stop_test_db`；若遇 CTRL-C 或其他中斷，手動清：

```bash
docker rm -f test-mysql
docker network rm atp-test-net
```

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
