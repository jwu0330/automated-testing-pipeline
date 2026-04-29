# A3/B6 API & Auth Testing (Newman)

> Postman Collection 基礎的 API 端點驗證與權限測試

---

## 概述

A3 與 B6 合併為一套 API 測試框架，使用 **Newman**（Postman CLI）執行：

| 節點 | 用途 | 工具 |
|------|------|------|
| **A3** | API 端點驗證 | Newman + Postman Collections |
| **B6** | 身分與權限驗證 | 同一個 collection 的 Auth folder |

---

## 預備條件

1. **Newman 安裝**：透過 Docker image `testing-pipeline-newman`（含 newman + openapi-to-postmanv2）
2. **測試來源**（任一即可）：
   - **OpenAPI 規格**（首選）：放在 `.testing/api/openapi.yaml` / `.yml` / `.json`，或在 `testing.yml:tests.api-test.openapi` 指定路徑 → pipeline 會自動轉成 Postman collection
   - **Postman Collection JSON**（手寫）：放在 `.testing/api/collections/*.postman_collection.json`
   - 兩者皆無 → API 測試靜悄悄跳過（不視為錯誤；純前端站不需要）

---

## 使用方式

### 1. 為專案建立 API collection

```bash
# 在專案 .testing 目錄建立
mkdir -p .testing/api/collections

# 複製或建立 Postman collection
# 方式 A：從官方範本複製
cp /path/to/pipeline/tests/api/collections/api-base.postman_collection.json \
   .testing/api/collections/my-api.postman_collection.json

# 方式 B：從 Postman 應用匯出（File > Export，選 Collection v2.1）
```

### 2. 編輯 collection

在 Postman 應用或文字編輯器編輯 JSON：

```json
{
  "info": {
    "name": "My API Tests",
    "schema": "https://schema.getpostman.com/json/collection/v2.1/collection.json"
  },
  "item": [
    {
      "name": "Health Check",
      "request": {
        "method": "GET",
        "url": "{{base_url}}/api/health"
      },
      "event": [
        {
          "listen": "test",
          "script": {
            "exec": [
              "pm.test('Status 200', () => pm.response.to.have.status(200));"
            ]
          }
        }
      ]
    },
    {
      "name": "Auth Tests",
      "item": [
        {
          "name": "Login",
          "request": {
            "method": "POST",
            "url": "{{base_url}}/api/auth/login",
            "body": {
              "mode": "raw",
              "raw": "{\"username\": \"{{E2E_USERNAME}}\", \"password\": \"{{E2E_PASSWORD}}\"}"
            }
          },
          "event": [{
            "listen": "test",
            "script": {
              "exec": [
                "pm.test('Login 成功', () => pm.response.to.have.status(200));",
                "pm.test('返回 token', () => {",
                "  const json = pm.response.json();",
                "  pm.expect(json).to.have.property('token');",
                "});"
              ]
            }
          }]
        }
      ]
    }
  ],
  "variable": [
    { "key": "base_url", "value": "https://example.com" },
    { "key": "E2E_USERNAME", "value": "" },
    { "key": "E2E_PASSWORD", "value": "" }
  ]
}
```

### 3. 執行測試

```bash
# 方式 A：經由 run-project.sh api-test scope
bash scripts/run-project.sh your-project api-test

# 方式 B：全部測試（包含 api-test）
bash scripts/run-project.sh your-project
```

---

## 格式 & 最佳實踐

### Folder 組織

```
{
  "item": [
    {
      "name": "Health & Basic",
      "item": [
        { "name": "GET /api/health", "request": {...} }
      ]
    },
    {
      "name": "Authentication",
      "item": [
        { "name": "POST /api/auth/login", "request": {...} },
        { "name": "POST /api/auth/logout", "request": {...} }
      ]
    },
    {
      "name": "Permissions",
      "item": [
        { "name": "GET /admin (should 403 if not admin)", "request": {...} },
        { "name": "POST /user/profile (should 401 if not auth)", "request": {...} }
      ]
    }
  ]
}
```

### Test 指令碼範例

```javascript
// 狀態碼驗證
pm.test('Status 200', () => pm.response.to.have.status(200));
pm.test('Status 401 or 403', () => pm.expect([401, 403]).to.include(pm.response.code));

// JSON 結構驗證
pm.test('Has token', () => {
  const json = pm.response.json();
  pm.expect(json).to.have.property('token');
  pm.expect(json.token).to.be.a('string');
});

// 回應時間驗證
pm.test('Response < 1s', () => {
  pm.expect(pm.response.responseTime).to.be.below(1000);
});

// 標頭驗證
pm.test('Has Content-Type', () => {
  pm.response.to.have.header('Content-Type');
  pm.expect(pm.response.headers.get('Content-Type')).to.include('application/json');
});

// 環境變數設定（供後續請求用）
const json = pm.response.json();
pm.environment.set('auth_token', json.token);
pm.environment.set('user_id', json.user.id);
```

### 環境變數

Collection 的 `variable` 陣列定義：

```json
"variable": [
  { "key": "base_url", "value": "https://api.example.com", "type": "string" },
  { "key": "auth_token", "value": "", "type": "string" },
  { "key": "user_id", "value": "", "type": "string" },
  { "key": "E2E_USERNAME", "value": "", "type": "string" },
  { "key": "E2E_PASSWORD", "value": "", "type": "string" }
]
```

使用時：`{{base_url}}`、`{{auth_token}}` 等。

---

## 報告

執行完後報告位置：

```
reports/<project-name>/raw/
├── newman.json          # 完整測試結果（JSON）
└── newman-junit.xml     # JUnit XML 格式（供 summarize.js 解析）
```

### Newman JSON 結構

```json
{
  "info": {
    "name": "My API Tests",
    "schema": "..."
  },
  "stats": {
    "assertions": { "total": 15, "passed": 15, "failed": 0 },
    "tests": { "total": 10, "passed": 10, "failed": 0 },
    "requests": { "total": 10, "issued": 10, "failed": 0 }
  },
  "executions": [
    {
      "name": "Health Check",
      "tests": { "Status 200": true },
      "assertions": [...]
    }
  ]
}
```

---

## FAQ

**Q: 我的 API 需要 Bearer token 認證，怎麼在 collection 設定？**

A: 在 request 的 `auth` 物件設定或用 pre-request 指令碼注入：

```json
{
  "request": {
    "auth": {
      "type": "bearer",
      "bearer": [{ "key": "token", "value": "{{auth_token}}", "type": "string" }]
    },
    "method": "GET",
    "url": "{{base_url}}/api/protected"
  }
}
```

或用 pre-request script：

```javascript
// Pre-request Script
pm.request.headers.add({
  key: 'Authorization',
  value: 'Bearer ' + pm.environment.get('auth_token')
});
```

**Q: 我在 collection 層級想設定預設的 auth，可以嗎？**

A: 可以。在 collection 根的 `auth` 物件設定：

```json
{
  "info": {...},
  "auth": {
    "type": "bearer",
    "bearer": [{ "key": "token", "value": "{{auth_token}}" }]
  },
  "item": [...]
}
```

所有子 request 都會繼承，除非覆寫。

**Q: 怎麼跳過某些測試？**

A: 用 `pm.test.skip()`：

```javascript
pm.test.skip('Flaky test', () => {
  // ...
});
```

或設定 collection variable `skip_flaky = true`，在指令碼裡判斷。

**Q: 報告怎麼整合到 CI/CD？**

A: 用 `newman-junit.xml`。Pipeline 的 `summarize.js` 會自動解析 JUnit XML 並納入最終評分卡。

---

## 範例

見 [collections/api-base.postman_collection.json](./collections/api-base.postman_collection.json)。
