# 專案測試規範 — Project Testing Convention

> **角色定位**：`automated-testing-pipeline` 是「測試總管理者」。
> 每個客戶/網站專案是「測試委託者」，必須遵守本文件規範才能被流水線接受。
> **Schema 版本**：`schema_version = 1`（2026-04-21）

---

## 1. 規範總覽（四件事）

| 項目 | 規定 | 為什麼 |
|------|------|--------|
| **資料夾名稱** | 固定 `.testing/`（以點開頭） | 表示為「測試設定」而非業務程式碼；IDE 會摺疊 |
| **路徑** | 專案根目錄，與 `index.php` 或 `composer.json` 同層 | 方便自動偵測 |
| **內含項目** | `testing.yml` 必填 + 選配子目錄 | 一個設定檔描述所有測試 |
| **執行方式** | `bash scripts/run-project.sh <project-name>` | 單一入口 |

---

## 2. 資料夾結構

```text
<client-project-root>/
└── .testing/
    ├── testing.yml              # ★ 必填：專案測試設定
    ├── unit/                    # ☐ 選填：PHPUnit 單元測試（由專案開發者撰寫）
    │   ├── phpunit.xml
    │   └── tests/
    │       └── *Test.php
    ├── e2e/                     # ☐ 選填：Playwright E2E 測試（由專案開發者撰寫）
    │   ├── package.json
    │   └── tests/
    │       └── *.spec.ts
    ├── static/                  # ☐ 選填：PHPStan 客製規則
    │   └── phpstan.neon         #   覆寫流水線預設
    └── fixtures/                # ☐ 選填：測試資料（SQL 種子、JSON mock）
        └── *.sql, *.json
```

### 規則

- `testing.yml` **必填**；其餘子目錄依 `tests.*.enabled` 需要時才建立。
- 原始碼**不要**放進 `.testing/`。這資料夾只存放測試設定與測試腳本。
- `.testing/` 應該納入 Git 版控（除了 `reports/`、`.cache/` 等產出物）。

---

## 3. `testing.yml` 格式

完整範本見 [scripts/testing-yml-template.yml](../scripts/testing-yml-template.yml)。

最小化範例：

```yaml
schema_version: 1

project:
  name: babydodofun
  target_url: https://xcity.babydodofun.com
  stack:
    language: php
    php_version: "8.1"
    database: mysql
    hosting: pseudo

tests:
  ssl:      { enabled: true }
  security: { enabled: true }
  stress:   { enabled: true, vus: 10, duration: 30s }
  static:   { enabled: true, level: 5 }
  unit:     { enabled: false }
  e2e:      { enabled: false }
```

### 欄位說明

| 欄位 | 必填 | 說明 |
|------|:---:|------|
| `project.name` | ✅ | 唯一識別名稱（英數 + 底線，用於報告目錄、n8n 選單） |
| `project.target_url` | ✅ | 遠端測試目標 URL |
| `project.stack.language` | ✅ | `php` / `node` / `python`... |
| `project.stack.php_version` | △ | 若為 PHP 專案，必填。決定 PHPUnit 容器版本 |
| `source.paths_to_scan` | △ | 若 `tests.static.enabled=true` 需填，告訴 PHPStan 掃哪些目錄 |
| `tests.*.enabled` | ✅ | 布林值，決定是否執行該項測試 |

---

## 4. 通用 vs 客製測試分工

| 測試 | 類型 | 提供者 | 客製方式 |
|------|------|--------|---------|
| SSL/TLS (testssl.sh) | 通用 | 流水線 | 不需客製 |
| 資安掃描 (OWASP ZAP) | 通用 | 流水線 | `testing.yml` 調整 level |
| 壓力測試 (k6) | 通用 | 流水線 | `testing.yml` 調整 VUs、測試頁面 |
| 靜態分析 (PHPStan) | 通用 | 流水線 | 選配 `.testing/static/phpstan.neon` 覆寫 |
| **單元測試 (PHPUnit)** | **客製** | **專案** | **必須寫在 `.testing/unit/`** |
| **E2E 測試 (Playwright)** | **客製** | **專案** | **必須寫在 `.testing/e2e/`** |

> **重要**：流水線**不會**幫你寫單元測試與 E2E 測試。
> 這兩類測試由每個專案的開發者負責撰寫，流水線只負責「呼叫執行」。
> 流水線提供了通用骨架（[tests/e2e/](../tests/e2e/)）作為參考，可複製到專案中改寫。

---

## 5. 執行方式

### 5.1 第一次：註冊專案

```bash
cd /mnt/e/Code/github/automated-testing-pipeline

# 註冊：在 projects.registry.yml 加入該專案
bash scripts/register-project.sh <project-name> <absolute-path>
```

範例：

```bash
bash scripts/register-project.sh babydodofun /mnt/e/cwe網站/b12/babydodofun
```

### 5.2 日常：執行測試

```bash
# 跑全部啟用的測試
bash scripts/run-project.sh <project-name>

# 只跑指定測試
bash scripts/run-project.sh <project-name> ssl
bash scripts/run-project.sh <project-name> security
bash scripts/run-project.sh <project-name> stress
bash scripts/run-project.sh <project-name> static
bash scripts/run-project.sh <project-name> unit
bash scripts/run-project.sh <project-name> e2e
```

### 5.3 透過 n8n GUI

開啟 <http://localhost:5678>，使用匯入的 workflow：
- 手動觸發測試
- 設定 cron 排程（每天凌晨跑一次）
- 失敗時自動發送通知

---

## 6. 報告位置

所有測試報告統一輸出到：

```text
automated-testing-pipeline/reports/<project-name>/
├── testssl-<timestamp>.html
├── testssl-<timestamp>.json
├── zap-report.html
├── k6-results.json
├── k6-summary.json
├── phpstan.json
├── phpunit.xml         # JUnit format
└── playwright/
    └── index.html
```

---

## 7. 新增客戶專案的檢查清單

每次開始新專案時，依序執行：

- [ ] 在專案根目錄建立 `.testing/` 資料夾
- [ ] 複製 [scripts/testing-yml-template.yml](../scripts/testing-yml-template.yml) → `<project>/.testing/testing.yml`
- [ ] 填寫 `project.name`、`project.target_url`、`project.stack`
- [ ] 依需求切換 `tests.*.enabled`
- [ ] 若啟用 `unit`：在 `.testing/unit/` 建立 `phpunit.xml` 與測試案例
- [ ] 若啟用 `e2e`：在 `.testing/e2e/` 建立 `package.json` 與 spec 檔
- [ ] 在流水線註冊：`bash scripts/register-project.sh <name> <path>`
- [ ] 驗證通用測試：`bash scripts/run-project.sh <name> ssl`
- [ ] 跑一次全部：`bash scripts/run-project.sh <name>`

---

## 8. FAQ

**Q：我想新增一個 Python/Node 專案，可以嗎？**
A：目前 v1 只完整支援 PHP 專案的 PHPUnit/PHPStan。SSL、Security、Stress、E2E 測試對語言無關，可以直接用。

**Q：共享主機（遠振）有什麼限制？**
A：壓力測試 `vus` 建議不超過 10；PHPStan/PHPUnit 完全在本機 Docker 跑，不會連遠端。

**Q：IoT 專案怎麼測？**
A：在 `testing.yml` 的 `project.tags` 加 `iot` 標籤；目前流水線不特別處理，未來再擴充。
