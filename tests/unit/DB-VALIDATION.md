# A4 DB Validation (Seed Data Verification)

> 資料庫種子資料完整性驗證

---

## 概述

A4 DB Validation 驗證：

1. **DB 連線**：test-mysql 容器是否啟動並就緒
2. **Schema 載入**：init.sql 與 fixtures 是否正確導入
3. **資料完整性**：必要的種子資料是否存在
4. **初始狀態**：資料表是否符合預期的初始條件

---

## 預備條件

1. 專案有 `.testing/unit/fixtures/` 目錄並包含至少一個 `.sql` 檔
2. 專案有 `database/init.sql`（可選，若有會自動載入）
3. Docker & Docker Compose

---

## 使用方式

### 1. 準備 SQL 檔案

```bash
# 專案結構
your-project/
├── database/
│   └── init.sql              # 主 schema（可選）
└── .testing/
    └── unit/
        └── fixtures/
            ├── 001_users.sql
            ├── 002_products.sql
            └── 003_permissions.sql
```

### 2. 編寫 Fixture SQL

**001_users.sql**：

```sql
-- 測試用戶
INSERT INTO users (id, email, role, created_at) VALUES
(1, 'admin@test.local', 'admin', NOW()),
(2, 'user@test.local', 'user', NOW()),
(3, 'guest@test.local', 'guest', NOW());
```

**002_products.sql**：

```sql
-- 測試商品
INSERT INTO products (id, name, sku, status) VALUES
(1, 'Widget A', 'SKU-001', 'active'),
(2, 'Widget B', 'SKU-002', 'active'),
(3, 'Widget C', 'SKU-003', 'inactive');
```

### 3. 執行驗證

```bash
# 方式 A：單獨執行 db-test scope
bash scripts/run-project.sh your-project db-test

# 方式 B：全部測試（包含 db-test）
bash scripts/run-project.sh your-project

# 方式 C：直接執行驗證腳本
cd your-project
export TEST_DB_HOST=test-mysql TEST_DB_USER=root TEST_DB_PASSWORD=test TEST_DB_NAME=test
bash /path/to/tests/unit/validate-db-seeds.sh
```

---

## 流程

1. **啟動 test-mysql**
   ```bash
   docker compose --profile unit-db up -d test-mysql
   ```

2. **等待 DB 就緒**（根認證完成，非只 ping）

3. **載入 schema**
   ```bash
   mysql -uroot -ptest test < database/init.sql
   ```

4. **按檔名順序載入 fixtures**
   ```bash
   mysql -uroot -ptest test < .testing/unit/fixtures/001_users.sql
   mysql -uroot -ptest test < .testing/unit/fixtures/002_products.sql
   # ...
   ```

5. **執行驗證**（見下）

6. **清理 DB**
   ```bash
   docker compose --profile unit-db down -v
   ```

---

## 驗證邏輯

### 內建驗證

`validate-db-seeds.sh` 會檢查：

- ✓ DB 連接正常
- ✓ 資料表是否建立
- ✓ fixtures 載入成功

輸出 JSON 報告：

```json
{
  "validator": "db-seeds",
  "timestamp": "2026-04-21T16:30:00Z",
  "database": "test",
  "checks": [
    {
      "name": "database_accessibility",
      "status": "pass",
      "message": "Database and tables accessible"
    },
    {
      "name": "schema_integrity",
      "status": "pass",
      "message": "Schema initialized from fixtures"
    }
  ]
}
```

### 專案客製驗證

若專案需要額外驗證邏輯，在同目錄建立 `validate-seeds.sh`：

```bash
# .testing/unit/validate-seeds.sh

#!/bin/bash
set -euo pipefail

TEST_DB_HOST="${TEST_DB_HOST:-test-mysql}"
TEST_DB_USER="${TEST_DB_USER:-root}"
TEST_DB_PASS="${TEST_DB_PASSWORD:-test}"
TEST_DB_NAME="${TEST_DB_NAME:-test}"

echo "執行專案客製驗證..."

# 驗證使用者資料完整性
USER_COUNT=$(mysql -h"$TEST_DB_HOST" -u"$TEST_DB_USER" -p"$TEST_DB_PASS" \
    -D"$TEST_DB_NAME" -se "SELECT COUNT(*) FROM users;")

if [ "$USER_COUNT" -lt 3 ]; then
    echo "❌ users 資料不足（預期 ≥3，實際 $USER_COUNT）"
    exit 1
fi

echo "  ✓ users 資料完整（$USER_COUNT 筆）"

# 驗證商品資料
PRODUCT_COUNT=$(mysql -h"$TEST_DB_HOST" -u"$TEST_DB_USER" -p"$TEST_DB_PASS" \
    -D"$TEST_DB_NAME" -se "SELECT COUNT(*) FROM products WHERE status='active';")

if [ "$PRODUCT_COUNT" -lt 2 ]; then
    echo "❌ active products 不足"
    exit 1
fi

echo "  ✓ products 資料完整（$PRODUCT_COUNT 個 active）"

echo "✓ 客製驗證通過"
exit 0
```

Pipeline 會自動執行它（若存在）。

---

## 最佳實踐

### 1. Fixture 命名

用數字前綴表達載入順序（因為有外鍵相依性）：

```
001_roles.sql         # 最先：基礎資料
002_users.sql         # 依賴 roles
003_products.sql      # 獨立
004_orders.sql        # 依賴 users & products
005_permissions.sql   # 依賴 roles 與 users
```

### 2. 保持輕量化

Fixtures 應該只包含**必要的測試資料**，避免 dump 整個 production DB：

```sql
-- ✓ 好：只放必要的測試資料
INSERT INTO users VALUES (1, 'admin', ...);
INSERT INTO users VALUES (2, 'user', ...);

-- ✗ 不好：10萬筆 log 記錄
INSERT INTO activity_log SELECT * FROM production.activity_log LIMIT 100000;
```

### 3. 冪等性

Fixtures 應該**可安全重複執行**（不拋「duplicate key」之類的錯誤）。用 `INSERT IGNORE` 或 `ON DUPLICATE KEY UPDATE`：

```sql
INSERT INTO users (id, email, role) VALUES (1, 'admin@test.local', 'admin')
ON DUPLICATE KEY UPDATE updated_at = NOW();
```

或搭配 `TRUNCATE` 清空再插：

```sql
-- 清空並重新載入
TRUNCATE TABLE users;
INSERT INTO users VALUES ...;
```

### 4. 避免時間戳陷阱

使用相對時間（`NOW()`、`DATE_SUB(NOW(), ...)`）而非寫死時間：

```sql
-- ✓ 好：永遠相對於當前時刻
INSERT INTO orders (user_id, created_at, expires_at) VALUES
(1, NOW(), DATE_ADD(NOW(), INTERVAL 7 DAY));

-- ✗ 不好：寫死日期會在 2027 年失效
INSERT INTO orders (user_id, created_at, expires_at) VALUES
(1, '2026-04-21 12:00:00', '2026-04-28 12:00:00');
```

---

## 報告

位置：

```
reports/<project-name>/raw/
└── db-validation.json      # 驗證結果
```

範例：

```json
{
  "validator": "db-seeds",
  "timestamp": "2026-04-21T16:30:00Z",
  "database": "test",
  "checks": [
    {
      "name": "database_accessibility",
      "status": "pass",
      "message": "Database and tables accessible"
    },
    {
      "name": "schema_integrity",
      "status": "pass",
      "message": "Schema initialized from fixtures"
    }
  ]
}
```

`summarize.js` 會解析此 JSON 並納入評分卡。

---

## FAQ

**Q: 我想驗證的資料量很大，fixtures 載入太慢怎麼辦？**

A: 
1. 只放**必要資料**。大多數測試不需要完整 production 資料。
2. 用 `mysqlimport` 或更快的方式：
   ```bash
   mysqlimport -h test-mysql -u root -ptest test < fixture.csv
   ```
3. 或在 `validate-seeds.sh` 裡直接注入必要資料（而非 fixtures）。

**Q: 我用 Doctrine / ORM，不想寫 SQL fixture。**

A: 改用程式化方式。在 `validate-seeds.sh` 裡 PHP 呼叫 Doctrine fixtures loader：

```bash
docker run --rm \
    --network atp-test-net \
    -e TEST_DB_HOST=test-mysql \
    -v your-project:/project \
    -w /project \
    php:8.1-cli \
    php -r 'require "bootstrap.php"; (new FixtureLoader())->load();'
```

或在 PHPUnit 的 `setUp()` 方法裡直接建資料。

**Q: 驗證通過但單元測試還是失敗，怎麼除錯？**

A: 登入 test-mysql 手動檢查：

```bash
docker compose exec test-mysql mysql -uroot -ptest test
mysql> SELECT * FROM users;
mysql> DESCRIBE products;
mysql> SHOW CREATE TABLE orders;
```

確認 schema 與資料符合預期。

---

## 相關檔案

- [tests/unit/validate-db-seeds.sh](./validate-db-seeds.sh) — 驗證指令
- [tests/unit/Dockerfile](./Dockerfile) — PHPUnit image（含 MySQL extension）
- [docs/run-tests.md](../docs/run-tests.md) — 執行手冊
