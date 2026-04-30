# 專案測試規範 — Project Testing Convention

> **角色定位**：`automated-testing-pipeline` 是「測試總管理者」。
> 每個客戶/網站專案是「測試委託者」，必須遵守本文件規範才能被流水線接受。
>
> **Schema 版本**：`schema_version = 2`（2026-04-21）
> v1 仍可運作（向下相容），但新專案請用 v2。

---

## 1. 規範總覽

| 項目 | 規定 | 為什麼 |
|------|------|--------|
| **資料夾名稱** | 固定 `.testing/`（以點開頭） | 表示「測試設定」非業務程式碼；IDE 會摺疊 |
| **路徑** | 專案根目錄，與 `index.php` 或 `composer.json` 同層 | 方便自動偵測 |
| **必填欄位** | `testing.yml` 只需 4 個欄位 | 其餘走智慧預設 |
| **測試碼位置** | `.testing/e2e/` 與 `.testing/api/` 在**專案**裡 | pipeline 只 bind mount，不持有副本 |
| **單元測試** | 由專案自己的測試資料夾管理（不在 `.testing/`） | pipeline 只跑黑箱／行為測試 |
| **執行入口** | `bash tests/scripts/run-project.sh <name>` | 單一指令 |

---

## 2. 對接口：`.testing/` 資料夾

```text
<client-project-root>/
└── .testing/
    ├── testing.yml              # ★ 必填（4 個欄位）
    ├── .env                     # ☐ 選填（敏感值，gitignore）
    ├── .env.example             # ☐ 選填（告訴下一個人要填什麼）
    ├── README.md                # ☐ 選填（專案測試說明）
    │
    ├── e2e/                     # ☐ 自動偵測
    │   ├── package.json         # 有此檔 → 自動啟用 e2e 測試
    │   ├── playwright.config.ts
    │   └── tests/*.spec.ts
    │
    ├── api/                     # ☐ 自動偵測
    │   └── collections/
    │       └── *.postman_collection.json  # 有此檔 → 自動啟用 api-test
    │
    └── static/                  # ☐ 選填
        └── phpstan.neon         # 覆寫流水線預設
```

> **單元測試不在這裡**：請於專案自己的測試資料夾（例：`tests/`）撰寫並執行；pipeline 不接管 PHPUnit / DB seed 驗證。

### 重要

- 測試碼（`e2e/tests/`、`api/collections/`）留在專案 git repo，**流水線不複製**。pipeline 執行時 `docker run -v <project>:/project` bind mount 進容器。
- 原始碼**不要**放進 `.testing/`。
- `.testing/` 應納入 Git 版控（除了 `.env`）。

---

## 3. `testing.yml`：4 必填 + 智慧預設

### 3.1 最小可跑範例（4 行即可）

```yaml
schema_version: 2

project:
  name: babydodofun
  target_url: https://xcity.babydodofun.com
  local_path: /mnt/e/cwe網站/b12/babydodofun
  php_version: "8.1"
```

**這 4 個欄位填完就能跑**。所有測試開關走自動偵測。

### 3.2 4 個必填欄位

| 欄位 | 說明 |
|------|------|
| `project.name` | 唯一識別名稱（英數底線），用於 `reports/<name>/`、n8n 選單 |
| `project.target_url` | 線上測試目標 URL（SSL/ZAP/k6/E2E 指向這） |
| `project.local_path` | 本地原始碼絕對路徑。**留空或設 `""` → 只跑網路測試（SSL/Security/Stress）**，不跑 static/trivy |
| `project.php_version` | PHP 版本（保留欄位以利未來工具切版）。非 PHP 專案留預設 `"8.1"` 即可 |

### 3.3 自動偵測規則

未在 `testing.yml` 明確設定時：

| 測試 | 啟用條件 |
|------|---------|
| `ssl` | `target_url` 以 `https://` 開頭 |
| `security` | 一律啟用（ZAP baseline） |
| `stress` | 一律啟用（vus=10, duration=30s, pages=[`/`]） |
| `static` | `local_path` 不為空且掃描到 `.php` 檔（level=5） |
| `e2e` | `.testing/e2e/package.json` 存在 |
| `api-test` | `.testing/api/collections/*.postman_collection.json` 存在 |
| `nuclei` | 一律啟用（severity=critical,high,medium, rate_limit=50） |
| `lighthouse` | 一律啟用（preset=desktop, pages=[`/`]） |
| `monkey` | 一律啟用（pages=[`/`], attacks=500, delay_ms=10） |
| `trivy` | `local_path` 不為空 → 掃依賴 / secret / misconfig |
| `links` | 一律啟用（timeout=15, max_concurrency=4） |

### 3.4 想覆寫預設？在 `testing.yml` 加對應鍵

```yaml
tests:
  stress:
    vus: 20                       # 覆寫預設 10
    pages: [/, /login.html]       # 覆寫預設 [/]
  static:
    level: 7                      # 覆寫預設 5
```

**原則：沉默 = 用預設。**

---

## 4. `.env` 協議（敏感值）

| 位置 | 存放 | Git | 誰維護 |
|------|------|:---:|------|
| `<project>/.testing/testing.yml` | 非敏感設定 | ✅ | 專案開發者 |
| `<project>/.testing/.env.example` | 「需要哪些敏感變數」的清單 | ✅ | 專案開發者 |
| `<project>/.testing/.env` | 實際敏感值 | ❌ | 本機填入 |

`.env` 完全是選填 —— 只有需要登入（`tests.e2e.auth.enabled: true`）或專案自己有 token/key 時才建立。

流水線 `run-project.sh` 會自動 `source` 並注入所有容器。

---

## 5. 單元測試與 DB 整合測試（不在 pipeline）

> 這些屬於專案自己的測試範疇，**pipeline 不接管**。請在專案自己的測試資料夾（例：`tests/`）使用 PHPUnit 等工具撰寫並執行；連線測試用 DB 也由專案自行管理。
>
> Pipeline 專注於黑箱／行為測試（API、E2E、SSL、Security、壓力、視覺迴歸…），詳見下節。

---

## 6. 通用 vs 客製測試分工

| 測試 | 類型 | 提供者 |
|------|------|--------|
| SSL/TLS (testssl.sh) | 通用 | 流水線（僅需 `target_url`） |
| 資安基線 (OWASP ZAP) | 通用 | 流水線（僅需 `target_url`） |
| 深層資安 (Nuclei) | 通用 | 流水線（模板化 CVE / 錯誤配置） |
| 壓力測試 (k6) | 通用 | 流水線（可調 vus/pages） |
| 前端品質 (Lighthouse) | 通用 | 流水線（可調 preset/pages） |
| 連結檢查 (Lychee) | 通用 | 流水線（可調 timeout/exclude） |
| 靜態分析 (PHPStan) | 通用 | 流水線（可客製 `.testing/static/phpstan.neon`） |
| 供應鏈 (Trivy) | 通用 | 流水線（需 `local_path`） |
| **API 測試 (Newman / Postman)** | **客製** | **專案自己寫在 `.testing/api/collections/`** |
| **E2E (Playwright)** | **客製** | **專案自己寫在 `.testing/e2e/`** |
| 單元測試 | 不在 pipeline | 由專案自己的測試資料夾管理 |
| 互動探測 (Gremlins monkey) | 通用 | 流水線（可調 pages/attacks/delay_ms） |

---

## 7. 執行方式

### 7.1 新專案三步驟

```bash
# 1. 在專案下建 testing.yml（4 行即可）
cd /path/to/new-project
mkdir -p .testing
cat > .testing/testing.yml <<EOF
schema_version: 2
project:
  name: new_project
  target_url: https://new-project.example.com
  local_path: $(pwd)
  php_version: "8.1"
EOF

# 2. 註冊到 pipeline
bash /path/to/pipeline/tests/scripts/register-project.sh new_project "$(pwd)"

# 3. 跑
bash /path/to/pipeline/tests/scripts/run-project.sh new_project
```

### 7.2 指定測試類型

```bash
bash tests/scripts/run-project.sh <name>             # 全部
bash tests/scripts/run-project.sh <name> ssl         # 只 SSL
bash tests/scripts/run-project.sh <name> api-test    # 只 API
bash tests/scripts/run-project.sh <name> e2e         # 只 E2E
bash tests/scripts/run-project.sh <name> summary     # 只重新產生 report.md
```

---

## 8. 報告產出

```text
automated-testing-pipeline/reports/<project>/
├── report.md              # ★ 統一入口：摘要 + 詳細（看這個就好）
├── report.json            # 結構化版本（n8n 用）
├── history.jsonl          # 累計執行歷史（append-only）
└── raw/                   # 工具原始輸出（除錯時翻）
    ├── testssl-<ts>.html
    ├── phpstan.json
    ├── zap-report.json
    ├── k6-summary.json
    ├── newman-junit-*.xml
    └── playwright/
```

---

## 9. 新增專案檢查清單

- [ ] 在專案根目錄建 `.testing/` 資料夾
- [ ] 建 `.testing/testing.yml`（4 個必填）
- [ ] `bash tests/scripts/register-project.sh <name> <path>`
- [ ] 驗證：`bash tests/scripts/run-project.sh <name> ssl`
- [ ] 若要 API 測試：在 `.testing/api/collections/` 放 `*.postman_collection.json`，並在 `.testing/.env` 填 `ADMIN_*` / `USER*_*` 帳密
- [ ] 若要 e2e：在 `.testing/e2e/` 放 `package.json` + `playwright.config.ts` + `tests/*.spec.ts`
- [ ] 跑全套：`bash tests/scripts/run-project.sh <name>`

---

## 10. FAQ

**Q：`local_path` 留空會怎樣？**
A：SSL / Security / Stress / API / E2E 照跑（這些只要 URL）；Static / Trivy 自動略過（沒有源碼可掃）。適合「只想檢查線上網站」的情境。

**Q：單元測試呢？**
A：不在 pipeline 裡。請在專案自己的測試資料夾（例：`tests/`）以 PHPUnit 等工具自行執行；pipeline 專注於黑箱／行為測試。

**Q：我想新增 Python/Node 專案？**
A：SSL/Security/Stress/API/E2E 對語言無關，立刻可用。Static 目前只支援 PHP（PHPStan），未來再擴充。

**Q：共享主機有什麼限制？**
A：Stress `vus` 建議 ≤ 10；Static 完全在本機 Docker 跑，不連遠端。

**Q：v1 的 testing.yml 還能用嗎？**
A：能。`run-project.sh` 偵測到 v1 會用 registry 的 path 當 local_path；但建議遷移到 v2（少寫 30 行）。
