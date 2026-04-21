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
| `security` | OWASP ZAP | 安全弱點掃描（XSS/SQLi/CSRF 等） |
| `stress` | k6 | 壓力／負載測試 |
| `static` | PHPStan | 靜態分析 |
| `unit` | PHPUnit | 單元測試（見 §4.1） |
| `e2e` | Playwright | UI/API 端對端測試（見 §4.2） |
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

啟用條件：`testing.yml` 將 `tests.unit.enabled` 改為 `true`。

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

29% 是該檔的上限：剩下 70% 是 DB / LINE API / SMS API 依賴，不適合做純單元測試。這些將由後續整合測試（Playwright API spec + staging DB）覆蓋。

#### 4.1.5 報告位置

| 檔案 | 內容 |
|---|---|
| `reports/<project>/phpunit.xml` | JUnit XML（給 CI / summarize.js） |
| `reports/<project>/coverage/index.html` | 覆蓋率 HTML 報告（可點開看每一行） |
| `reports/<project>/phpunit-clover.xml` | Clover XML（給 Codecov 等工具） |
| `reports/<project>/phpunit-coverage.txt` | 純文字摘要 |

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
| `reports/<project>/playwright/index.html` | Playwright HTML 報告（trace、screenshot） |
| `reports/<project>/playwright-junit.xml` | JUnit XML（給 summarize.js） |

---

## 5. 檢視報告

### 5.1 評分卡（建議的總覽）

```bash
bash scripts/run-project.sh <project> summary
# 或跑全套時最後會自動產：
bash scripts/run-project.sh <project>
```

輸出範例：

```
═══════════════════════════════════════════
  babydodofun 測試評分卡
  2026/4/21 下午2:13:21
═══════════════════════════════════════════

① SSL/TLS (testssl.sh)     A+  (93/100)  [=]
② 靜態分析 (PHPStan)         22 個錯誤
③ 資安掃描 (OWASP ZAP)       High=0  Medium=2  Low=7  Info=4
④ 壓力測試 (k6)             req=1450  avg=8ms  p95=16ms  fail=0.00%
⑤ 單元測試 (PHPUnit)         83 tests, 83 pass, 0 fail，覆蓋率 29.4%
⑥ E2E (Playwright)          18 tests, 18 pass, 0 fail
```

`[=]` / `[↓-1 改善]` 是和上次執行相比的趨勢。

### 5.2 詳細報告檔

報告全部寫在 `reports/<project>/` 底下。常用的：

- **SSL**：`testssl-<timestamp>.html`（每次執行一份）
- **PHPStan**：`phpstan.json`（原始）+ `phpstan-errors.md`（可讀版）
- **ZAP**：`zap-report.html`
- **k6**：`k6-summary.json`
- **PHPUnit**：`phpunit.xml` + `coverage/index.html`
- **Playwright**：`playwright/index.html`
- **執行歷史**：`run-history.jsonl`（append-only）

### 5.3 n8n GUI

打開 http://localhost:5678，`Execute workflow`，最後一個節點 `Show Scorecard — 評分卡彙整` 的輸出就是上面的評分卡。

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

---

## 7. 進階：透過 n8n GUI 排程

`n8n/workflows/pipeline-skeleton.json` 匯入後的 workflow 有 9 個節點：

```
Manual Trigger — 手動觸發
  → Set Project Vars — 設定專案
  → Run SSL Scan — SSL 憑證檢測
  → Run Static Analysis — 靜態程式碼分析
  → Run Security Scan — 弱點掃描
  → Run Load Test — 壓力測試
  → Run Unit Tests — 單元測試
  → Run E2E Tests — 端對端測試
  → Show Scorecard — 評分卡彙整
```

要排程：`Manual Trigger` 換成 `Schedule Trigger`（n8n 內建）；要換專案：雙擊 `Set Project Vars` 改 `projectName`。
