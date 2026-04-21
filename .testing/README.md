# `.testing/` — 專案測試工具包（Project Testing Kit）

> 把這個資料夾整包複製到你的專案根目錄，就能把這個專案接上**共用的 `automated-testing-pipeline`**。
>
> 本文件是**唯一一份說明**，內容就是全部。

---

## TL;DR — 三步驟一鍵跑

```bash
# 1. 整包複製（直接保留資料夾名 .testing/）
cp -r /path/to/automated-testing-pipeline/.testing /path/to/your-project/

# 2. 編輯 4 個必填欄位
vim your-project/.testing/testing.yml

# 3. 一鍵跑完所有 n8n 流程
bash your-project/.testing/link.sh
```

跑完後報告在：`<pipeline>/reports/<your-project-name>/report.md`

---

## 一、固定流程（只能這麼做）

這些是**不能改、沒有其他路徑**的規則。違反了就跑不起來。

| # | 規則 | 為什麼不能改 |
|---|------|-----|
| 1 | 資料夾名必須是 `.testing/`，放在專案根目錄 | pipeline 用這個路徑自動偵測 |
| 2 | 設定檔名必須是 `testing.yml` | `run-project.sh` 寫死讀這個檔名 |
| 3 | `testing.yml` 必須含 `schema_version: 2` 和 4 個必填欄位（見下） | 少一個就 fail-fast |
| 4 | `.env`（若有）**不要** commit | 敏感值；`.gitignore` 已排除 |
| 5 | 所有測試容器由**共用 pipeline** 執行，不在本專案 build | 避免每個專案都各裝一套 Docker image |
| 6 | 執行入口**只有** `link.sh`，不要自己呼叫 `run-project.sh` | link.sh 會處理註冊 + 啟動 + 執行 |

---

## 二、必要（Required）

做這些才跑得起來。

### 2.1 必要檔案

| 檔案 | 用途 |
|------|------|
| `testing.yml` | 4 個必填欄位：`name` / `target_url` / `local_path` / `php_version` |
| `link.sh` | 一鍵連結 + 執行流程；**不要改**（改了就收不到未來更新） |
| `README.md` | 本文件；留著讓後人看 |

### 2.2 必填欄位（4 個）

編輯 `testing.yml`：

```yaml
schema_version: 2

project:
  name: my_site                           # ① 專案識別名稱（英數底線）
  target_url: https://my-site.com         # ② 線上測試目標 URL
  local_path: /mnt/e/code/my-site         # ③ 本地原始碼絕對路徑（可空字串 "" → 只跑網路測試）
  php_version: "8.1"                      # ④ PHP 版本（非 PHP 專案留預設即可）
```

### 2.3 共用 pipeline 的位置

`link.sh` 找共用 pipeline 的順序（三擇一）：

```
環境變數 PIPELINE_HOME
   ↓ 沒設就看 ↓
testing.yml 的 pipeline.home
   ↓ 沒寫就用 ↓
預設路徑 /mnt/e/Code/github/automated-testing-pipeline
```

共用 pipeline 只需要存在一份，`n8n` 容器也只會起一個（所有專案都連到同一個 http://localhost:5678）。

---

## 三、可選（Optional）

只在「這個專案需要這種測試」時才填對應資料夾；不需要就留空。

### 3.1 可選：專案客製測試（13 個資料夾）

> 「啟用條件」欄位要小心區分兩類：
> - **需要專案測試碼**（unit/e2e）：資料夾要放檔案才會跑
> - **通用測試的覆寫/客製**（ssl/security/stress/static/lighthouse/nuclei/monkey/trivy/links）：一律會跑；資料夾只是讓你**額外客製**

| 資料夾 | 測試類型 | 觸發 / 客製條件 | 要放什麼 |
|--------|----------|-----------------|----------|
| `unit/` | PHPUnit 單元測試 | 有 `unit/phpunit.xml` → **才會跑** | `phpunit.xml` + `bootstrap.php` + `tests/*Test.php` |
| `e2e/` | Playwright 端對端 | 有 `e2e/package.json` → **才會跑** | `package.json` + `playwright.config.ts` + `tests/*.spec.ts` |
| `static/` | PHPStan 設定覆寫 | 有 `static/phpstan.neon` → 覆寫預設 | 客製 `phpstan.neon` |
| `ssl/` | SSL 檢測參數 | 有 `ssl/*.conf` → 覆寫預設 | 客製 testssl.sh 參數 |
| `security/` | ZAP 掃描設定 | 有 `security/zap.conf` → 覆寫預設 | 自訂 ZAP 規則 |
| `stress/` | k6 壓力腳本 | 有 `stress/load-test.js` → 取代預設 | 客製 k6 腳本 |
| `lighthouse/` | 前端品質 | 有 `lighthouse/config.js` → 覆寫預設 | Lighthouse 客製設定（預留） |
| `nuclei/` | 深層資安 | 有 `nuclei/templates/` → 額外模板 | 自訂 nuclei YAML 模板 |
| `monkey/` | Gremlins 互動探測 | 有 `monkey/gremlins.spec.ts` → 取代骨架 | 客製 monkey spec（需登入等情境） |
| `trivy/` | 供應鏈掃描 | 有 `trivy/.trivyignore` → 額外排除 | 客製忽略清單（預留） |
| `links/` | 壞連結檢查 | 有 `links/lychee.toml` → 覆寫預設 | 客製 lychee config（預留） |
| `hooks/` | pre/post 鉤子 | 有 `hooks/pre.sh` or `post.sh` | 測試前/後執行的 shell |
| `scripts/` | 專案客製腳本 | 由 `testing.yml` 指定 | 任何協助腳本 |

**預留**：lighthouse/trivy/links 的資料夾客製尚未被 pipeline 讀取（目前只透過 `testing.yml` 的 `tests.<tool>.*` 覆寫）。先留資料夾是為了未來擴充時不用再次改結構。

### 3.2 可選：DB 整合測試

若 `unit/` 測試要連 DB：

```
.testing/unit/fixtures/001_seed.sql
```

放一個 `.sql` 檔就**自動**啟動 pipeline 的 `test-mysql` 容器（用完即棄 tmpfs），注入環境變數 `TEST_DB_HOST=test-mysql` 等到 PHPUnit 容器。

### 3.3 可選：敏感變數

需要時才建：

```bash
cp .env.example .env
# 編輯 .env 填入 E2E_USERNAME / E2E_PASSWORD / API_TOKEN 等
```

### 3.4 可選：覆寫測試參數

在 `testing.yml` 加 `tests:` 區塊（範例見 `testing.yml` 註解）。沒寫就走自動偵測。

---

## 四、自動偵測規則（Silence = Default）

沒在 `testing.yml` 寫、對應資料夾也沒放檔案時，pipeline 的預設行為：

| 測試 | 預設 |
|------|------|
| ssl | `target_url` 是 `https://` 就開 |
| security (ZAP) | 一律開 |
| stress (k6) | 一律開（vus=10, duration=30s, pages=[/]） |
| static (PHPStan) | `local_path` 有 `.php` 檔就開（level=5） |
| unit (PHPUnit) | `.testing/unit/phpunit.xml` 存在才開 |
| e2e (Playwright) | `.testing/e2e/package.json` 存在才開 |
| unit + DB | `.testing/unit/fixtures/*.sql` 存在才啟動 test-mysql |
| **nuclei (深層資安)** | 一律開（severity=critical,high,medium, rate_limit=50） |
| **lighthouse (前端品質)** | 一律開（preset=desktop, pages=[/]） |
| **monkey (Gremlins.js)** | 一律開（pages=[/], attacks=500, delay_ms=10） |
| **trivy (供應鏈)** | `local_path` 不為空就開（severity=CRITICAL,HIGH,MEDIUM） |
| **links (Lychee)** | 一律開（timeout=15, max_concurrency=4） |

**原則：沉默＝用預設；要覆寫才寫。**

---

## 五、一鍵指令

### 5.1 完整一鍵（連結 + 跑完全部）

```bash
bash .testing/link.sh
```

做了這些事：
1. 讀 `testing.yml` 拿專案名稱與路徑
2. 呼叫共用 pipeline 的 `register-project.sh` 註冊
3. 確認共用 n8n 容器已啟動（沒啟就起）
4. 呼叫 `run-project.sh <name> all` 跑完 **11 種測試**（ssl / security / nuclei / stress / lighthouse / links / static / trivy / unit / e2e / monkey）
5. 顯示報告路徑 + n8n GUI 網址

### 5.2 只連結（不跑）

```bash
bash .testing/link.sh link
```

### 5.3 只跑（之前已連結過）

```bash
bash .testing/link.sh run
```

---

## 六、報告位置

```
<共用 pipeline>/reports/<your-project-name>/
├── report.md              ★ 看這個就好
├── report.json            結構化版本（n8n / CI 用）
├── history.jsonl          累計歷史
└── raw/                   工具原始輸出
```

n8n GUI：http://localhost:5678（帳密在 pipeline 的 `.env`）

---

## 七、FAQ

**Q：我不想 commit `.testing/` 整包，只想留 testing.yml？**
A：不建議。其他人接手時 `link.sh` 就沒了，等於破壞固定流程。最多把 `.testing/.env` 和測試產物（`unit/test-results/`、`e2e/node_modules/`）排掉（已在 `.gitignore` 中）。

**Q：我有兩個專案要共用同一份 pipeline，要各複製一份 `.testing/` 嗎？**
A：對。每個專案自己的 `.testing/` 是它的客製區；共用的只有 pipeline 本身（Docker 容器、腳本、n8n）。每個專案的 `name` 要不同，報告會分別放在 `reports/<name>/`。

**Q：pipeline 的位置和預設不一樣？**
A：`export PIPELINE_HOME=/your/path` 再跑 `link.sh`；或在 `testing.yml` 取消註解 `pipeline.home` 欄位。

**Q：`link.sh` 能改嗎？**
A：**不建議**。未來 pipeline 更新時 `link.sh` 也會跟著動，改了就收不到更新。客製需求寫在 `hooks/pre.sh` 或 `hooks/post.sh`。

**Q：沒裝 yq 會怎樣？**
A：`link.sh` 有簡易 fallback 能讀基本欄位；但共用 pipeline 的 `run-project.sh` 需要 yq。到 pipeline 主機裝一次即可：`wget -qO ~/.local/bin/yq https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 && chmod +x ~/.local/bin/yq`。

---

## 八、檢查清單

新專案第一次接入 pipeline：

- [ ] 整包複製 `.testing/` 到專案根
- [ ] 編輯 `.testing/testing.yml` 的 4 個必填欄位
- [ ] （可選）若需要登入測試，`cp .env.example .env` 並編輯
- [ ] （可選）需要 unit 測試 → 放 `unit/phpunit.xml` + `unit/tests/*.php`
- [ ] （可選）需要 e2e → 放 `e2e/package.json` + `e2e/tests/*.spec.ts`
- [ ] （可選）調整新工具參數 → 在 `testing.yml` 加 `tests.nuclei.severity` / `tests.lighthouse.pages` / `tests.monkey.attacks` / `tests.trivy.severity` / `tests.links.timeout`
- [ ] 執行 `bash .testing/link.sh`
- [ ] 打開 `<pipeline>/reports/<name>/report.md` 看結果（v0.3 起含 11 項評分）
