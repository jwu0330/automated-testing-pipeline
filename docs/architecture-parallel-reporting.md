# 三路並行架構與報告生成機制

> **日期**: 2026-04-21
> **版本**: v0.4 (並行化架構)
>
> **歷史快照**：以下內容描述 v0.4 三路並行設計時的測試清單，包含已從 pipeline 移除的 PHPUnit / db-test 等項目。架構圖與資料流邏輯仍然有效，但相關工具的具體名稱以最新 [run-tests.md](./run-tests.md) 為準。

---

## 1. 三路並行的設計

### 結構概圖

```
                    ┌─────────────────┐
                    │ 01 Init         │
                    │ Set Project Vars│
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │ 02 Precheck     │
                    │ Health Check    │
                    └────────┬────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
   ┌────▼──────┐      ┌──────▼───────┐      ┌───▼──────┐
   │ 路線 A    │      │  路線 B      │      │ 路線 C   │
   │ 本地測試  │      │ 資安 & 壓力  │      │ 使用者   │
   └─────┬─────┘      └──────┬───────┘      └───┬──────┘
         │                   │                   │
    (A1-A4)            (B1-B6)              (C1-C6)
         │                   │                   │
         └────────────────────┼───────────────────┘
                              │
                    ┌─────────▼──────────┐
                    │ Report - Generate  │
                    │ Scorecard          │
                    │ (summarize.js)     │
                    └─────────┬──────────┘
                              │
                    ┌─────────▼──────────┐
                    │ Report - Parse     │
                    │ Results            │
                    │ (JSON to n8n)      │
                    └────────────────────┘
```

### 各路線職責

| 路線 | 名稱 | 節點 | 執行時間 | 特點 |
|------|------|------|---------|------|
| **A** | 本地端測試 | A1–A4 | ~5 分鐘 | 針對原始碼與本地邏輯，無外網需求 |
| **B** | 資安 & 壓力測試 | B1–B6 | ~6 分鐘 | 針對安全性與效能，遠端網路掃描 |
| **C** | 使用者層面測試 | C1–C6 | ~7 分鐘 | 針對 UI 和用戶體驗，相容性與互動 |

**並行優勢**：
- 串行耗時：A + B + C = ~18 分鐘
- 並行耗時：max(A, B, C) = ~7 分鐘
- **時間節省**：~11 分鐘 (61% 加速)**

### 防禦機制

所有節點設定 `onError: continueRegularOutput`，確保：
1. **路線內容錯**: 後續節點續執行（保留既有 `|| echo` 模式）
2. **路線間獨立**: A 失敗不影響 B、C
3. **報告仍生成**: 即使某路失敗，其他路結果照彙整

---

## 2. 報告生成機制：安全性驗證

### 當前架構 (三路各執行一次)

```
A4 ──────────────┐
                 ├─→ Report-Generate (summarize.js × 3) ─→ Parse ─→ n8n Schema
B6 ──────────────┤
                 │
C6 ──────────────┘
```

### 資料流分析

#### summarize.js 的行為

```javascript
// 1. 讀取階段
const RAW = path.join(REPORT_DIR, 'raw');
const phpunit = findRaw('phpunit.xml');    // 讀 A3 or C1 的輸出
const testssl = findRaw('testssl-*.html'); // 讀 B1 的輸出
// ... 等 11 個工具輸出

// 2. 解析階段
const phpunitData = parsePHPUnit(phpunit);
const sslData = parseSSL(testssl);
// ... 等 11 個解析函式

// 3. 彙整階段
const scorecard = {
  phpunit: phpunitData,
  ssl: sslData,
  // ...
};

// 4. 寫入階段
fs.appendFileSync(HISTORY, JSON.stringify(entry) + '\n');  // ✅ append
fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify(scorecard));  // ✅ 覆寫
fs.writeFileSync(path.join(REPORT_DIR, 'report.md'), markdown);  // ✅ 覆寫
```

### 安全性驗證：✅ 無資料寫入不全風險

#### 原因 1: 讀檔獨立於寫檔

```
時間序列：

[ T=0 ]  A1-A4 執行  (Static / Unit / API / DB)
         ↓ 各自寫入 raw/phpstan.json, raw/phpunit.xml, ...

[ T=5m ]  A4 呼叫 summarize.js
         ├─ 讀 raw/phpstan.json   ✓
         ├─ 讀 raw/phpunit.xml    ✓
         └─ 生成 report.json      (寫)

[ T=5m ]  同時 B1-B6 執行  (SSL / ZAP / Nuclei / ...)
         ↓ 各自寫入 raw/testssl-*.html, raw/zap-report.json, ...

[ T=11m ] B6 呼叫 summarize.js
         ├─ 讀 raw/phpstan.json   ✓ (A 的結果)
         ├─ 讀 raw/phpunit.xml    ✓ (A 的結果)
         ├─ 讀 raw/testssl-*.html ✓ (B 新寫的)
         └─ 生成 report.json      (覆寫，內容 ⊇ 之前)

[ T=18m ] C1-C6 執行  (E2E / Visual / compat / Lighthouse / ...)
          ↓ 各自寫入 raw/playwright/, raw/lighthouse-*.json, ...

[ T=25m ] C6 呼叫 summarize.js
         ├─ 讀 raw/* 全部       ✓ (A+B+C 的結果)
         └─ 生成 report.json    (覆寫，內容最完整)
```

#### 原因 2: 寫入方式安全

**追加式寫入 (append)**:
```javascript
fs.appendFileSync(HISTORY, JSON.stringify(entry) + '\n');
```
- 每次執行附加一筆歷史記錄
- 3 次執行 = 3 筆記錄（可追溯）
- **無碰撞** (append 有 OS 層鎖定)

**覆寫式寫入 (overwrite)**:
```javascript
fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify(scorecard));
```
- 每次覆寫前先讀全部 raw/ 檔案彙整
- 第 3 次執行讀到最新資料 = 最完整的報告
- **無遺漏** (資料只在讀檔階段，彙整前已全部就位)

#### 原因 3: 原始工具輸出已獨立完成

```
各路線的輸出寫入時間線（相對於 summarize.js 呼叫）：

[ A 執行期間 ]
  A1: Static → raw/phpstan.json ✓ DONE
  A2: Unit → raw/phpunit.xml ✓ DONE
  (A3: API → raw/newman-*.json)  [待實作]
  (A4: DB → raw/migration-*.log) [待實作]

[ B 執行期間 (與 A 並行) ]
  B1: SSL → raw/testssl-*.html ✓ DONE
  B2: ZAP → raw/zap-report.json ✓ DONE
  B3: Nuclei → raw/nuclei.jsonl ✓ DONE
  B4: Trivy → raw/trivy-fs.json ✓ DONE
  B5: Load → raw/k6-summary.json ✓ DONE
  (B6: Auth → [複用 A3])

[ C 執行期間 (與 A/B 並行) ]
  C1: E2E → raw/playwright-junit.xml ✓ DONE
  (C2: Visual → raw/playwright/*.png)  [待實作]
  (C3: Compat → raw/compat-*.json)     [待實作]
  C4: Lighthouse → raw/lighthouse-*.json ✓ DONE
  C5: Links → raw/lychee.json ✓ DONE
  C6: Monkey → raw/monkey-report.json ✓ DONE

[ summarize.js 呼叫時 ]
  → 三個時間點（A4, B6, C6）都能讀到截至該時刻的完整 raw/ 集合
  → 報告完整性遞增：1/3 → 2/3 → 3/3
```

### 結論

**三路各執行一次 summarize.js 是安全的**，因為：
1. 工具輸出寫完才讀 → 無部分檔案問題
2. 逐次覆寫 → 最後一次最完整
3. 歷史記錄 append → 可追溯三次執行
4. n8n 只用最後一次 stdout → 看到完整報告

**缺點**（非功能問題）：
- 讀檔效率：3× IO 成本
- 視覺清晰度：邏輯不夠直觀

---

## 3. 優化方案（未來選項）

### 方案 A: 使用 n8n Merge 節點（推薦用於正式環境）

改為：
```
A4 ─┐
B6 ├─→ [Merge 節點] ─→ Report-Generate (× 1) ─→ Parse ─→ n8n
C6 ─┘
```

**優點**：
- 只執行一次 summarize.js
- IO 成本 -66%
- 邏輯更清晰

**步驟**：
1. 在 JSON 加新節點 `Merge Three Results`
2. 三路各輸出連到 Merge.input
3. Merge.output 連到 Report-Generate
4. 報告生成只跑一次

**成本**：JSON 修改 5-10 行

### 方案 B: 保持現狀（推薦用於開發階段）

**優點**：
- 改動最小
- 無新增複雜度
- 功能完整、安全無誤

**缺點**：
- IO 多 3 倍
- 視覺上看起來有冗餘

**推薦**：先方案 B（穩定），等三路都成熟後改方案 A（優化）。

---

## 4. 新增節點實作方向

### A3 API Validation (Newman)

**目標**: 驗證 API 端點功能 + response schema

**實作**:
```bash
# 專案結構
<project>/.testing/api/
├── postman-collection.json   # Postman 集合
├── postman-environment.json  # 環境變數
└── postman-tests/            # 自定義 test script
```

**pipeline 執行**:
```bash
bash tests/scripts/run-project.sh <project> api-test
# 內部：docker run -v .testing/api:/api newman:latest run postman-collection.json ...
```

**報告**:
```
reports/<project>/raw/newman-*.json
```

---

### A4 DB Validation (自製)

**目標**: 驗證 migration 版本一致 + seed 初始資料完整

**實作**:
```bash
# 專案結構
<project>/.testing/db/
├── validate-migrations.sh    # 檢查 up/down 可逆性
└── validate-seeds.sh         # 檢查表行數/欄位正確性
```

**pipeline 執行**:
```bash
bash tests/scripts/run-project.sh <project> db-test
# 內部：執行上述 2 個 shell script，比對預期狀態
```

**報告**:
```
reports/<project>/raw/migration-validation.log
reports/<project>/raw/seed-validation.log
```

---

### B6 Auth & Permission (Postman 擴充)

**目標**: 驗證身分驗證 + 權限檢查

**實作**:
```bash
# 複用 A3 的 Postman 集合，新增 auth test folders：
<project>/.testing/api/
└── postman-collection.json
    ├── folder: [GET] API Tests
    └── folder: [GET] Auth & Permission Tests  ← 新增
        ├── test: Invalid token → 401
        ├── test: Expired token → 401
        ├── test: Insufficient scope → 403
        └── test: Cross-user access → 403
```

**pipeline 執行**:
```bash
bash tests/scripts/run-project.sh <project> auth-test
# 內部：newman 執行該 folder
```

---

### C2 Visual Comparison (Playwright)

**目標**: 視覺迴歸測試（捕捉 UI 變化）

**實作**:
```typescript
// .testing/e2e/tests/visual-regression.spec.ts
import { test, expect } from '@playwright/test';

test('homepage visual snapshot', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveScreenshot('homepage-light.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page).toHaveScreenshot('homepage-dark.png');
});
```

**baseline 管理**:
```
.testing/e2e/tests/__screenshots__/
└── visual-regression.spec.ts/
    ├── homepage-light.png   (baseline)
    └── homepage-dark.png    (baseline)
```

**pipeline 執行**:
```bash
bash tests/scripts/run-project.sh <project> visual-test
# 內部：playwright test --grep @visual
```

---

### C3 Browser Compatibility (Playwright Projects)

**目標**: 驗證跨瀏覽器相容性

**實作**:
```typescript
// playwright.config.ts
export default defineConfig({
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'] },
    },
  ],
});
```

**pipeline 執行**:
```bash
bash tests/scripts/run-project.sh <project> browser-compat
# 內部：playwright test --grep @compat (全 projects)
```

---

## 5. 工具選型總結

| 功能 | 選擇 | 實作複雜度 | 預計完成 |
|------|------|----------|---------|
| A3 API | Newman | 低 | 1-2 週 |
| A4 DB | 自製 shell | 中 | 1-2 週 |
| B6 Auth | Postman 擴充 | 低 | 同 A3 |
| C2 Visual | Playwright 內建 | 中 | 2-3 週 |
| C3 Compat | Playwright Projects | 中 | 2-3 週 |

---

## 6. 延遲實作 (已預留)

以下機制暫不實作，但架構已預留接軌點：

- **Gate 1-3**：URL 可達、程式品質、環境別（可在 Precheck 或路線首個節點加）
- **分支 Merge**：改用 n8n Merge 節點（三路匯聚前）

實作時機：各路線完全成熟後 (v0.5+)

---

## 版本紀錄

| 版本 | 日期 | 變更 |
|------|------|------|
| v0.4 | 2026-04-21 | 三路並行架構、報告生成安全驗證、工具評選確定 |
