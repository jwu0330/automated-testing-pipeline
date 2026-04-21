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
| **測試碼位置** | `.testing/unit/` 與 `.testing/e2e/` 在**專案**裡 | pipeline 只 bind mount，不持有副本 |
| **執行入口** | `bash scripts/run-project.sh <name>` | 單一指令 |

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
    ├── unit/                    # ☐ 自動偵測
    │   ├── phpunit.xml          # 有此檔 → 自動啟用 unit 測試
    │   ├── bootstrap.php
    │   ├── tests/*.php          # 專案自己寫的測試
    │   └── fixtures/*.sql       # 有 .sql → 自動啟動 test-mysql 容器
    │
    ├── e2e/                     # ☐ 自動偵測
    │   ├── package.json         # 有此檔 → 自動啟用 e2e 測試
    │   ├── playwright.config.ts
    │   └── tests/*.spec.ts
    │
    └── static/                  # ☐ 選填
        └── phpstan.neon         # 覆寫流水線預設
```

### 重要

- 測試碼（`unit/tests/`、`e2e/tests/`）留在專案 git repo，**流水線不複製**。pipeline 執行時 `docker run -v <project>:/project` bind mount 進容器。
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
| `project.local_path` | 本地原始碼絕對路徑。**留空或設 `""` → 只跑網路測試（SSL/Security/Stress）**，不跑 static/unit/e2e |
| `project.php_version` | PHP 版本（決定 PHPUnit Docker image）。非 PHP 專案留預設 `"8.1"` 即可 |

### 3.3 自動偵測規則

未在 `testing.yml` 明確設定時：

| 測試 | 啟用條件 |
|------|---------|
| `ssl` | `target_url` 以 `https://` 開頭 |
| `security` | 一律啟用 |
| `stress` | 一律啟用（vus=10, duration=30s, pages=[`/`]） |
| `static` | `local_path` 不為空且掃描到 `.php` 檔（level=5） |
| `unit` | `.testing/unit/phpunit.xml` 存在 |
| `e2e` | `.testing/e2e/package.json` 存在 |
| `unit.use_db` | `.testing/unit/fixtures/*.sql` 存在 → 自動啟動 `test-mysql` 容器 |

### 3.4 想覆寫預設？在 `testing.yml` 加對應鍵

```yaml
tests:
  stress:
    vus: 20                       # 覆寫預設 10
    pages: [/, /login.html]       # 覆寫預設 [/]
  static:
    level: 7                      # 覆寫預設 5
  unit:
    enabled: false                # 偵測到但強制關掉
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

## 5. DB 整合測試（option B — pipeline 管 MySQL）

### 5.1 設計

當專案有 DB 相關測試時，**禁止連 production DB**。pipeline 提供獨立 MySQL 容器（寫在 tmpfs，每次跑完銷毀）：

```
.testing/unit/fixtures/*.sql   存在
   ↓ 自動觸發
pipeline 啟動 test-mysql 容器（profile=unit-db）
   ↓
載入 <project>/database/init.sql（schema）
   ↓
載入 .testing/unit/fixtures/*.sql（測試資料）
   ↓
phpunit 容器加入 atp-test-net 網路
   ↓ env 變數：
TEST_DB_HOST=test-mysql
TEST_DB_PORT=3306
TEST_DB_NAME=test
TEST_DB_USER=root
TEST_DB_PASSWORD=test
   ↓
跑測試
   ↓
test-mysql 容器銷毀（資料隨 tmpfs 清空）
```

### 5.2 在測試中使用

`.testing/unit/bootstrap.php` 從範本複製 `testDb()` helper，測試類別內：

```php
public function testSomething(): void {
    $pdo = testDb();                         // 拿 PDO
    $pdo->exec('INSERT INTO members ...');   // 寫資料
    // assert ...
}
```

### 5.3 Fixtures 撰寫

```sql
-- .testing/unit/fixtures/001_test_users.sql
INSERT INTO m_members (id, phone, name) VALUES
  (1, '0911111111', '測試用戶1'),
  (2, '0922222222', '測試用戶2');
```

Pipeline 啟動時會依檔名順序載入。

---

## 6. 通用 vs 客製測試分工

| 測試 | 類型 | 提供者 |
|------|------|--------|
| SSL/TLS (testssl.sh) | 通用 | 流水線（僅需 `target_url`） |
| 資安掃描 (OWASP ZAP) | 通用 | 流水線（僅需 `target_url`） |
| 壓力測試 (k6) | 通用 | 流水線（可調 vus/pages） |
| 靜態分析 (PHPStan) | 通用 | 流水線（可客製 `.testing/static/phpstan.neon`） |
| **單元測試 (PHPUnit)** | **客製** | **專案自己寫在 `.testing/unit/`** |
| **E2E (Playwright)** | **客製** | **專案自己寫在 `.testing/e2e/`** |

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
bash /path/to/pipeline/scripts/register-project.sh new_project "$(pwd)"

# 3. 跑
bash /path/to/pipeline/scripts/run-project.sh new_project
```

### 7.2 指定測試類型

```bash
bash scripts/run-project.sh <name>             # 全部
bash scripts/run-project.sh <name> ssl         # 只 SSL
bash scripts/run-project.sh <name> unit        # 只 Unit
bash scripts/run-project.sh <name> summary     # 只重新產生 report.md
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
    ├── phpunit.xml
    ├── coverage/
    └── playwright/
```

---

## 9. 新增專案檢查清單

- [ ] 在專案根目錄建 `.testing/` 資料夾
- [ ] 建 `.testing/testing.yml`（4 個必填）
- [ ] `bash scripts/register-project.sh <name> <path>`
- [ ] 驗證：`bash scripts/run-project.sh <name> ssl`
- [ ] 若要 unit 測試：在 `.testing/unit/` 放 `phpunit.xml` + `bootstrap.php` + `tests/*.php`
- [ ] 若 unit 測試要 DB：在 `.testing/unit/fixtures/*.sql` 放種子資料
- [ ] 若要 e2e：在 `.testing/e2e/` 放 `package.json` + `playwright.config.ts` + `tests/*.spec.ts`
- [ ] 跑全套：`bash scripts/run-project.sh <name>`

---

## 10. FAQ

**Q：`local_path` 留空會怎樣？**
A：SSL / Security / Stress 照跑（這些只要 URL）；Static / Unit / E2E 自動略過（沒有源碼可測）。適合「只想檢查線上網站」的情境。

**Q：一定要用 production DB 測嗎？**
A：**絕對不要**。Pipeline 提供獨立測試 DB 容器（option B），production DB 永遠不該被自動化測試碰到。

**Q：我想新增 Python/Node 專案？**
A：SSL/Security/Stress/E2E 對語言無關，立刻可用。Static/Unit 目前只支援 PHP（PHPStan + PHPUnit），未來再擴充。

**Q：共享主機有什麼限制？**
A：Stress `vus` 建議 ≤ 10；Static/Unit 完全在本機 Docker 跑，不連遠端。

**Q：v1 的 testing.yml 還能用嗎？**
A：能。`run-project.sh` 偵測到 v1 會用 registry 的 path 當 local_path；但建議遷移到 v2（少寫 30 行）。
