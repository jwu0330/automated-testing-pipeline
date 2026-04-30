# 認證後測試覆蓋強化計畫

> **目標讀者**：要決策、執行、或交接此計畫的工程師（後端 / QA / DevOps / 安全）。
> **時間範圍**：分階段約 2-4 週可完成全部 5 個 scope 的改造。
> **產出**：每一個測試項目（scope）都能涵蓋「登入後」行為，把目前只測公開表面的盲區補起來。

---

## 名詞釐清

本文件出現「測試項目（Scope）」與「Session」兩個詞，避免混淆先講清楚：

| 詞 | 在本文件指什麼 |
|---|---|
| **Scope / 測試項目** | 管線中的一個獨立測試類別（k6 / ZAP / Nuclei / Lighthouse / Lychee / E2E / Monkey） |
| **Session** | 使用者登入後的會話狀態（cookies + localStorage），對應 `<project>/.testing/storage-state.json` |

下文一律用「Scope」。

---

## 為什麼要做（總論）

### 現狀

目前 7 個測試 scope 中，**只有 E2E 與 Monkey** 會帶登入態進站；其餘 5 個（k6、ZAP、Nuclei、Lighthouse、Lychee）都是**未登入視角**的掃描。

對一個有會員系統的網站，這代表：

- **80% 的程式碼跑在登入後**（會員後台、購物流程、管理介面），但這些路徑**從來沒被掃過**。
- 真實 incident 的多數來源——IDOR、broken function-level authorization、stored XSS、後台 API 效能崩潰——目前管線**完全沒能力偵測**。
- 給的「PASS」報告會誤導決策層以為系統安全 / 效能達標。

### 目標

讓每個 scope 都具備兩種視角的能力：

1. **未認證視角**（保留）：抓「沒帳號的攻擊者」能挖到的問題
2. **已認證視角**（新增）：抓「拿到合法帳號後」才暴露的問題

且兩者**獨立執行、獨立報告**——這樣才能比對出「同一個 endpoint，登入前後表現不同」這類權限漏洞。

---

## Part A：各 Scope 改造計畫

每個 scope 的章節結構統一如下：

1. **修改前 vs 修改後**（具體能抓到的問題）
2. **為什麼要修改**（不修改會發生什麼）
3. **要怎麼修改**（檔案層級的具體改動 + 驗收條件）
4. **限制與風險**（修改後仍抓不到的東西）

---

### A1. ZAP — OWASP 安全掃描

#### 修改前 vs 修改後

| 漏洞類別 | 修改前（unauth baseline） | 修改後（unauth + per-role auth scans） |
|---|:-:|:-:|
| 缺資安標頭（CSP / HSTS / X-Frame-Options） | ✅ | ✅ |
| 公開頁 reflected XSS | ✅ | ✅ |
| `.git` / `.env` / robots.txt 洩漏 | ✅ | ✅ |
| Cookie 屬性錯誤 | ✅ | ✅ |
| 未鎖的 admin endpoint（直接 GET 不擋）| ✅ | ✅ |
| **登入後 stored XSS**（會員 nickname、留言、profile） | ❌ | ✅ |
| **IDOR**（改 URL 的 user_id 看到別人資料） | ❌ | ✅ |
| **Broken function-level authz**（會員身份打 admin API 通） | ❌ | ✅（user-role + admin-role 兩本掃描比對） |
| 後台表單 SQLi / XSS | ❌ | ✅ |
| CSRF token 缺失 | ❌ | ✅ |
| 上傳功能 path traversal | ❌ | ✅ |

#### 為什麼要修改

不改的話，ZAP spider 碰到登入牆就停——後台所有 endpoint 等於沒掃。實務上 90% 的真實 web 應用 vulnerability 都在 auth 後面：使用者只要登入了就能餵入攻擊載荷的位置（profile、留言、上傳、設定頁）才是高風險區。

更關鍵的是 **broken authorization 這類漏洞必須有兩個身份才測得出來**——一份 admin 角色的掃描 + 一份 user 角色的掃描，比對「user 身份不該回 200 的 admin endpoint 卻回了 200」，才能找到權限提升漏洞。這是目前管線**完全無法表達**的測試類型。

#### 要怎麼修改

**步驟 1：testing.yml 增加 auth 區塊**

```yaml
schema_version: 2
project:
  name: foo
  target_url: https://example.com

auth:
  login_url: https://example.com/login
  username_field: "input[name='username']"     # CSS selector
  password_field: "input[name='password']"
  submit_button: "button[type='submit']"
  success_indicator: "/dashboard"               # 登入成功後 URL 會出現的子字串
  logged_out_indicator: "input[name='password']" # session 過期時頁面會回到的標記
  roles:
    admin:
      username_env: ADMIN_USERNAME             # .env 取值
      password_env: ADMIN_PASSWORD
    user:
      username_env: USER1_USERNAME
      password_env: USER1_PASSWORD
```

**步驟 2：寫 ZAP authentication context script**

新增 `tests/security/auth-context.js`（ZAP zest script）或 `auth-context.context` XML：用 form-based authentication 配合 `success_indicator` 偵測登入成功；`logged_out_indicator` 偵測 session 過期觸發 re-auth。

**步驟 3：改 docker-compose.yml 的 zap service**

把單一 service 拆成三個 profile：

```yaml
zap-unauth:        # 保留現狀
  command: zap-baseline.py -t ${TARGET_URL} -r zap-unauth.html -J zap-unauth.json
  profiles: [security, all]

zap-auth-user:     # 新增
  volumes:
    - ./tests/security/auth-context.context:/zap/wrk/context.xml
    - ${PROJECT_PATH}/.testing/storage-state.json:/zap/wrk/storage.json:ro
  command: >
    zap-full-scan.py -t ${TARGET_URL}
      -n /zap/wrk/context.xml
      -U user
      -r zap-auth-user.html -J zap-auth-user.json
  profiles: [security, all]

zap-auth-admin:    # 新增（同上，role=admin）
  ...
```

**步驟 4：summarize.js 加上 cross-role diff**

讀三份 report，產出「user role 不該能進但進得去」的 endpoint 列表——這是權限漏洞的直接證據。

#### 驗收條件

- 在已知有 IDOR 的測試專案跑 → user-role report 應該出現 IDOR alert
- 故意把 `/admin/*` 的 middleware 拿掉 → cross-role diff 應該標出 user 跑得通的 admin endpoint
- 登入過期觸發 → log 應該看到 ZAP re-authentication

#### 限制

ZAP 仍**抓不到**：業務邏輯漏洞（前端算價、流程跳步驟、race condition）、OAuth/SSO 流程特化漏洞、需要多步流程才能觸發的 bug（這要寫 ZAP sequence script 個別處理）。

---

### A2. k6 — 壓力測試

#### 修改前 vs 修改後

| 效能問題 | 修改前（4 條寫死路徑、未登入） | 修改後（journey-based + session） |
|---|:-:|:-:|
| 首頁 / 登入頁吞吐 | ✅ | ✅ |
| TLS handshake 退化 | ✅ | ✅ |
| 反向代理 worker 上限 | ✅ | ✅ |
| **登入後 API 吞吐**（會員列表、商品 CRUD） | ❌ | ✅ |
| 寫操作 DB 鎖競爭（同時下單） | ❌ | ✅ |
| 後台報表頁 N+1 query | ❌ | ✅ |
| Session store 規模壓力 | ❌ | ✅ |
| 上傳 endpoint IO 飽和 | ❌ | ✅ |

#### 為什麼要修改

修改前最大的問題不是「沒測後台」，而是**測出的數據是假的**：`/admin/services.html` 在未登入狀態下會 302 redirect 到登入頁，k6 量到的是「302 + 登入頁載入」的延遲，不是後台真實處理時間。報告會顯示「p95 < 200ms 通過」，上線後高峰一來，後台 API 真實 p95 是 5 秒，DB 連線池爆掉。

正確的壓力測試**模擬真實使用者行為**，不是 URL 列表。一條 journey 可能長這樣：

```
[登入] → [GET /api/dashboard] → [GET /api/orders?page=1] → [POST /api/orders/123/refund] → [GET /api/notifications]
```

每個 VU（virtual user）跑這條 journey，一直循環。這樣才量得到「100 個會員同時操作後台時，refund API 撐不撐得住」。

#### 要怎麼修改

**步驟 1：testing.yml 增加 journeys 區塊**

```yaml
tests:
  stress:
    enabled: true
    vus: 10
    duration: 30s
    journeys:
      - name: member_dashboard
        auth_role: user
        weight: 70                    # 70% VU 跑這條
        steps:
          - GET /api/dashboard
          - GET /api/orders?page=1
          - GET /api/profile
      - name: admin_management
        auth_role: admin
        weight: 30
        steps:
          - GET /api/admin/users
          - POST /api/admin/users/{id}/suspend
            body: '{"reason":"test"}'
```

**步驟 2：重寫 tests/stress/load-test.js**

```javascript
import http from 'k6/http';
import { sleep } from 'k6';

const TARGET = __ENV.TARGET_URL;
const STORAGE = __ENV.STORAGE_STATE_PATH ? JSON.parse(open(__ENV.STORAGE_STATE_PATH)) : null;
const COOKIE_HEADER = STORAGE
  ? STORAGE.cookies.map(c => `${c.name}=${c.value}`).join('; ')
  : '';

const JOURNEYS = JSON.parse(__ENV.JOURNEYS_JSON);

export const options = {
  scenarios: Object.fromEntries(
    JOURNEYS.map(j => [j.name, {
      executor: 'ramping-vus',
      stages: [{ duration: __ENV.K6_DURATION, target: Math.round(__ENV.K6_VUS * j.weight / 100) }],
      exec: j.name,
    }])
  ),
};

JOURNEYS.forEach(j => {
  globalThis[j.name] = function () {
    for (const step of j.steps) {
      const [method, path, body] = parseStep(step);
      const url = `${TARGET}${path}`;
      const params = { headers: { Cookie: COOKIE_HEADER } };
      const res = method === 'GET' ? http.get(url, params) : http.post(url, body, params);
      // 失敗率、p95 由 thresholds 統一管
    }
    sleep(1);
  };
});
```

**步驟 3：run-project.sh 的 run_stress() 把 journeys 從 yml 抽出來變 env**

```bash
JOURNEYS_JSON=$(yq -o=json '.tests.stress.journeys // []' "$TESTING_YML")
docker compose ... -e JOURNEYS_JSON="$JOURNEYS_JSON" -e STORAGE_STATE_PATH=/work/storage.json ...
```

**步驟 4：報告分 journey 出 metrics**

每個 journey 各自的 p95 / failure rate，不要全部混在一起平均。

#### 驗收條件

- 故意在 admin API 加 `sleep(2)` → admin journey 的 p95 應該 ≥ 2s，member journey 不受影響
- DB 連線池設 5 → 10 VU 同時跑寫操作 journey 應該觸發 connection wait warning
- 不給 storage-state → 應該明確 fail 並回報「auth journey 需要 session」，不要靜默退化

#### 限制

k6 仍**抓不到**：browser-only 行為（JS hydration 時間、客戶端渲染卡頓需用 Playwright）、業務 race condition（要更專門設計 chaos test）、長尾延遲下的 user-perceived 問題。

---

### A3. Lighthouse — 效能 / 無障礙

#### 修改前 vs 修改後

| 問題 | 修改前（只跑 `/`） | 修改後（多頁清單 + auth） |
|---|:-:|:-:|
| 首頁 LCP / FCP / CLS | ✅ | ✅ |
| 首頁 a11y / SEO | ✅ | ✅ |
| 商品頁 / landing page perf | ❌ | ✅ |
| 結帳流程關鍵頁 | ❌ | ✅ |
| 後台 dashboard TTI | ❌ | ✅ |
| SPA 動態渲染後的 a11y | ❌ | ✅ |

#### 為什麼要修改

行銷部門用 PageSpeed 看到首頁 95 分就以為產品 perf 沒問題，但**沒人停留在首頁**。客戶實際在用的商品頁可能 LCP 4.5 秒、結帳頁 6 秒，導致跳出率高、轉換差。後台 dashboard 是員工每天看的頁，TTI 8 秒員工會抱怨「卡卡的」但沒數據佐證。

Lighthouse 的設計從來就不是「掃全站」（全站太多頁、跑完要小時計），而是**抽樣關鍵頁**——但這個「抽樣清單」現在沒人定義，預設就只有首頁。

#### 要怎麼修改

**步驟 1：testing.yml 增加頁面清單**

```yaml
tests:
  lighthouse:
    pages:
      - path: /
        auth: false                   # 公開頁
      - path: /products
        auth: false
      - path: /products/123
        auth: false
      - path: /checkout
        auth: user                    # 需登入
      - path: /admin/dashboard
        auth: admin
    preset: desktop                   # 或 mobile
    perf_threshold: 80                # 分數低於此值算 fail
```

**步驟 2：改 tests/lighthouse/lighthouse-run.sh**

讀 yml、對每頁分別跑 lighthouse；auth 不為 false 的頁加 `--extra-headers='{"Cookie":"..."}'`：

```bash
COOKIE=$(jq -r '.cookies | map("\(.name)=\(.value)") | join("; ")' /work/storage.json)
for page in $(yq -r '.tests.lighthouse.pages[] | @json' /work/testing.yml); do
  PATH=$(echo $page | jq -r .path)
  AUTH=$(echo $page | jq -r .auth)
  EXTRA_HEADERS=""
  [ "$AUTH" != "false" ] && EXTRA_HEADERS="--extra-headers={\"Cookie\":\"$COOKIE\"}"
  lighthouse "$TARGET$PATH" $EXTRA_HEADERS --output=json --output-path=/reports/lh-$slug.json
done
```

**步驟 3：報告聚合**

每頁一個 score 列表，總分用「最差頁」而非平均（避免被首頁高分拉抬）。

#### 驗收條件

- 故意讓 admin dashboard 載超慢 → admin/dashboard 的 perf score 應該降到 < 50，但首頁分數不變
- Cookie 沒帶進去 → admin 頁應該被導去登入頁，Lighthouse 算的是登入頁分數（要在報告明確標註「auth failed」）

#### 限制

頁數線性增加時間：每頁 cold run 約 30-60s。10 頁就要 5-10 分鐘。建議**主管線只跑 3-5 頁**，完整清單放 nightly job。

---

### A4. Lychee — 死連結檢查

#### 修改前 vs 修改後

| 問題 | 修改前（不帶 cookie） | 修改後（帶 cookie） |
|---|:-:|:-:|
| 公開頁 404 連結 | ✅ | ✅ |
| 公開頁壞圖 | ✅ | ✅ |
| 後台介面壞連結 | ❌ | ✅ |

#### 為什麼要修改

Lychee 是這次計畫**成本最低**的補丁，但價值也是最低——員工會抱怨的破連結 80% 在後台，而且 Lychee 的修復對 dev team 是低優先（壞連結通常只是 cosmetic，不會 block 業務）。

#### 要怎麼修改

docker-compose.yml 的 lychee service 加一行：

```yaml
lychee:
  ...
  command:
    - --header
    - "Cookie: ${TARGET_COOKIE}"
    - ...
```

`run-project.sh` 的 run_links() 從 storage-state.json 抽 cookie 變 env：

```bash
TARGET_COOKIE=$(jq -r '.cookies | map("\(.name)=\(.value)") | join("; ")' "$PROJECT_PATH/.testing/storage-state.json" 2>/dev/null || echo "")
export TARGET_COOKIE
docker compose --profile links up ...
```

#### 驗收條件

- 後台某頁加一個 `<a href="/dead-link">` → 報告應該抓到（修改前抓不到）

#### 限制

Lychee 對 SPA / JS 渲染的連結無感（它只看 HTML），這跟 auth 無關，是工具本質限制。

---

### A5. Nuclei — 漏洞模板掃描

#### 修改前 vs 修改後

| 問題 | 修改前 | 修改後 |
|---|:-:|:-:|
| 已知 CVE 指紋 | ✅ | ✅ |
| 未鎖 well-known path | ✅ | ✅ |
| 預設帳密 | ✅ | ✅ |
| 登入後版本資訊洩漏 | ❌ | △（極少數模板有效） |

#### 為什麼要（不太需要）修改

**誠實說：Nuclei 帶 session 的收益最低。** 它的設計是模板比對外部可達 path，本來就不靠登入態。市面上 95% 的 Nuclei 模板都是 unauthenticated 探測。

**建議**：把這個 scope 排到優先級最低（甚至先不做）。如果還是要做，就把 `-H "Cookie: ..."` 加進 docker-compose.yml 的 nuclei command，跟 Lychee 同樣手法。

---

## Part B：50-60 個按鈕的規模化問題

> **背景**：使用者描述系統有 50-60 個 distinct 按鈕（會員操作 + 後台管理），希望全部都被測試覆蓋。

### (a) 測試時間估算

下表是「**真的把每個按鈕都納入每個 scope**」的天真做法時間估算（以 60 個按鈕、每按鈕對應 1 個 endpoint 為例）：

| Scope | 算法 | 估時 |
|---|---|---|
| ZAP unauth baseline | 既有 spider，~1 分鐘 | 1-2 min |
| ZAP auth (per role × 2 roles) | full scan：每個 endpoint × ~30 payload variations | **2-6 hr** |
| k6 stress（全 60 個 endpoint）| 60 × 10 VU × 30s | 30 min（含暖機 / 收尾）|
| Nuclei | URL list × ~9000 templates | 10-30 min |
| Lighthouse | 60 頁 × 30s cold run | 30-60 min |
| Lychee | 整站 spider | 5-10 min |
| E2E（每按鈕 1 spec） | 60 specs × 10s 平均 | 10-15 min |
| Monkey | 固定時間預算 | 5 min |
| **合計（序列跑）** | | **~4-8 小時** |
| **合計（最大平行化）** | | **~2-3 小時**（瓶頸是 ZAP auth）|

### (b) 系統如何處理

**結論**：完整跑一次需要小時計，**不能也不該每次都跑全集**。標準做法是**分層執行**：

#### 三層執行策略

| 層級 | 觸發 | 內容 | 時間 | 用途 |
|---|---|---|---|---|
| **Smoke** | 每次 push / PR | 5-10 個關鍵按鈕 + 公開頁 ZAP baseline + Lighthouse 首頁 | **3-5 min** | 防低級錯誤 |
| **Standard** | 每日 / merge to main | 30 個高風險按鈕 + ZAP unauth + Lighthouse 5 頁 | **20-40 min** | 主要 regression 防線 |
| **Full** | 每週 nightly / pre-release | 全部 60 個按鈕 + ZAP unauth+auth × 2 roles + Lighthouse 全清單 | **2-4 hr** | 全面安全 / 效能審查 |

對應 `testing.yml` 設計：

```yaml
tests:
  buttons:
    - id: btn_login
      tier: smoke                     # smoke 一定跑
      endpoint: POST /api/login
      auth: false
    - id: btn_create_order
      tier: standard                  # standard 才跑
      endpoint: POST /api/orders
      auth: user
    - id: btn_admin_export_users
      tier: full                      # full 才跑
      endpoint: GET /api/admin/users/export
      auth: admin
```

每個 scope 從這份清單依 tier 過濾自己要打的端點。

#### 平行化機制

| Scope | 平行能力 |
|---|---|
| k6 | VU 本來就是平行，scenarios 之間也平行 |
| ZAP | thread per host（5 thread），per-role scan 之間也可平行 |
| Lighthouse | 多頁可平行（不同 chrome instance）|
| E2E Playwright | workers 設定可開 4-8 個 |
| Nuclei | rate-limit 內最大平行 |
| Lychee | concurrent connection 已可調 |
| Monkey | 不平行（單一 session）|

實務建議：**主管線（smoke / standard tier）強制序列化**避免相互干擾；**Full tier 的 nightly job 才開平行**。

#### 為什麼不能無腦全部平行

1. **目標站本身有承載上限**：同時 10 個 scope 撞，可能直接把站打掛——你變成自己的 DDoS 攻擊者。
2. **資料污染**：ZAP active scan 跟 k6 stress 同時跑，ZAP 注入的 SQLi payload 會出現在 k6 寫入的訂單裡，DB 變垃圾場。
3. **報告解讀**：失敗發生時無法判斷是「k6 寫太快導致 ZAP 看到不一致 state」還是「真的有 bug」。

---

## Part C：操作手冊

### C1. 開發人員：新增一個 Journey / Button

當你新增一個 feature（例如「批次匯出訂單」按鈕），同時要做：

1. **編輯 `<project>/.testing/testing.yml` 的 `buttons` 區塊**
   ```yaml
   - id: btn_admin_export_orders
     tier: standard                  # 或 smoke / full
     endpoint: GET /api/admin/orders/export?format=csv
     auth: admin
     expected_status: 200
     expected_response_includes: "Content-Type: text/csv"
   ```

2. **若按鈕需多步流程**（例：先選日期範圍才能匯出），加 journey：
   ```yaml
   journeys:
     - name: admin_export_orders_with_filter
       auth_role: admin
       steps:
         - POST /api/admin/orders/filter   # body: {"from":"2026-01-01"}
         - GET /api/admin/orders/export
   ```

3. **在 PR description 註記「新增 button：btn_admin_export_orders，預期出現在 standard tier」**——讓 reviewer 確認分層正確。

### C2. QA：執行測試 / 讀報告

**執行**：

```bash
# Smoke（PR check）
/pipeline-run                       # 預設行為，~5 min

# Standard（每日）
/pipeline-run --tier standard

# Full（pre-release）
/pipeline-run --tier full
```

**讀報告**：

- 主報告 `<project>/.testing/reports/report.md` 的 scorecard 用顏色分 tier，紅色 = 該 tier 有 fail
- 各 scope 子報告在 `reports/raw/`：`zap-auth-user.html`、`zap-auth-admin.html`、`k6-by-journey.json`、`lighthouse-by-page.json`
- **權限漏洞看哪**：`reports/cross-role-diff.md`——這是 user role 與 admin role ZAP 報告的差集，列出「user 不該能進但進了」的 endpoint

### C3. DevOps：CI 排程

```yaml
# .github/workflows / GitLab CI
on:
  pull_request:
    schedule: smoke                  # 每次 PR
  push:
    branches: [main]
    schedule: standard               # merge 觸發
  schedule:
    - cron: "0 2 * * *"
      schedule: full                 # 每天凌晨 2 點

env:
  ADMIN_USERNAME: ${{ secrets.TEST_ADMIN_USERNAME }}
  ADMIN_PASSWORD: ${{ secrets.TEST_ADMIN_PASSWORD }}
  USER1_USERNAME: ${{ secrets.TEST_USER1_USERNAME }}
  USER1_PASSWORD: ${{ secrets.TEST_USER1_PASSWORD }}
```

**重要**：full tier 一定排在離峰時段，且**只打 staging，永遠不打 production**。

---

## Part D：潛在問題（你還沒提到的）

下面這些問題在執行計畫過程中會冒出來，先列出免得遺漏：

### D1. 資料污染與環境隔離

- **ZAP active scan / k6 stress 會建立、修改、刪除真實資料**——絕不能跑在 production
- 必須有獨立 staging 環境，**且每次跑 full tier 前 reset 一次 DB**（snapshot/restore 或 fresh seed）
- 測試帳號的訂單、留言、上傳檔案會留在 staging DB 裡——需要 cleanup script 或 nightly truncate

### D2. 測試帳號的密碼管理

- `.env` 放明文不適合 CI（CI logs 可能洩漏）
- 建議：CI 用 secret manager，本機用 `.env` + `.gitignore`
- 密碼 rotate 政策：staging 測試帳號至少**每季 rotate**，rotation 後同步更新所有 CI secret

### D3. Auth script 的維護成本

登入流程改動會把整套 auth 機制打掛，需要監控的變動：

- 登入欄位 selector 改了（`input[name=username]` → `input[name=email]`）
- 登入流程加 reCAPTCHA → ZAP 自動登入直接死，得改用 storage-state 注入（如目前 capture-session 流程）
- 登入加 MFA → 自動化幾乎不可能，**測試帳號必須關 MFA**
- 登入改成 SSO（OAuth → Google）→ ZAP 的 form-based auth context 失效，要改用 OAuth 流程或 storage-state

**建議**：每次 auth flow 改動視為 breaking change，要在 PR 標 `breaking:auth`，提醒同步檢查 testing.yml。

### D4. Session 過期 / re-auth

- ZAP full scan 跑 4 小時，session 通常 30 分鐘過期
- 必須在 ZAP context 設定 `loggedOutIndicator` regex，讓它偵測過期自動重登
- k6 也要在 journey 開頭判斷 session 還在不在，不在就重新 capture——**或乾脆每個 VU 自己登一次**（更接近真實情境）

### D5. WAF / Rate limiting

- 站台前面有 Cloudflare / AWS WAF：ZAP 的 SQLi payload 會被擋，產生「false negative」（你以為沒漏洞，其實是 WAF 擋掉看不到）
- k6 的高併發會觸發 rate limit，量到的是 429 不是真實容量
- **解法**：staging 環境的 WAF 設定 IP allowlist 給 CI runner，或暫時關掉 WAF 跑測試

### D6. CSRF token

- 登入後的 POST endpoint 多數有 CSRF token（每次 form 的 hidden field 會變）
- 帶 cookie 還不夠，POST 會被 403
- **ZAP 的 anti-CSRF token 設定**：在 context 標明 token field name，ZAP 會自動 grab + replay
- **k6 解法**：每個 journey 在 POST 前先 GET 一次拿 token

### D7. 多步流程（sequence）

- 「下單」要：選商品 → 加購物車 → 填地址 → 結帳
- ZAP 的 spider 不會自己組合這些步驟去測 race condition
- **解法**：寫 ZAP sequence script（zest）或在 E2E 那邊覆蓋；ZAP scope 不要勉強

### D8. 業務副作用

- 跑 stress 時 prod alarm 會狂響（即使打 staging 也可能因為共用監控）→ **跑前通知運維 + alarm silencing window**
- 測試帳號的活動會塞滿 audit log → audit log 加 tag 過濾 `is_test_account=true`
- 寄信類 endpoint（忘記密碼 / 通知）測試時會真的寄出 → mock SMTP 或用 mailhog

### D9. Multi-channel / Multi-platform

50-60 個按鈕在 web / mobile app / public API 三個 channel 各有一份。本計畫**只覆蓋 web**。Mobile app + API 要另外處理：

- Mobile app：用 Appium / Detox，這條 pipeline 不接（複雜度太高）
- Public API：用 OpenAPI 餵 api-test scope，現有管線已支援（Newman + Postman collection）

### D10. 動態因素

- A/B test：不同使用者看到不同 UI，測試結果不穩 → 測試帳號 force 進 control group
- Feature flag：未開放的功能不該被測 → testing.yml 的 button 加 `feature_flag: foo`，runtime 過濾
- 時間敏感資料：「今日活動」按鈕在不同時間結果不同 → 測試環境鎖時間（freezegun-like）或標 `time_sensitive: true` 跳過

### D11. i18n

多語站台每個 `lang` 的 perf 都不同（中文字型 hinting 會拖慢 LCP）→ Lighthouse 至少對主要 2-3 個語言各跑一次。

### D12. 跨工具報告打通

5 個 scope 改完，會有 ~10 份原始 report（zap-unauth、zap-auth-user、zap-auth-admin、k6-per-journey、lighthouse-per-page、lychee、nuclei、e2e、monkey、summary）。**目前 summarize.js 沒設計 per-tier / per-role 顯示**，要同步擴充：

- scorecard 加 「unauth / user / admin」三軸
- 加 cross-role diff 區塊（D 區產出）
- 加 tier 標籤

---

## Part E：本計畫不覆蓋的盲區

寫進來避免讓決策者誤以為「做完這個計畫就萬事 OK」。

| 盲區 | 為什麼沒覆蓋 | 怎麼補（如要） |
|---|---|---|
| 業務邏輯漏洞（前端算價、跳步驟）| DAST 工具本質做不到 | 手動 pen-test / threat modeling |
| Race condition（同時下單兩次） | 需專門 chaos test | 寫 k6 中的 `setup()` + 並行 POST |
| 第三方依賴 CVE | Trivy 只掃 image，不掃 npm/composer | 加 `npm audit` / Snyk |
| Mobile App | 工具鏈完全不同 | Appium pipeline 另開 |
| Internal API（東西向流量）| 目前測的是 public-facing | 加 contract test |
| Email / SMS 流程 | side effect 難回滾 | mailhog + e2e flow |
| 支付流程真實扣款 | 不能在自動化測 | sandbox key + 手動驗證 |
| 大量資料的 perf（10 萬筆訂單後台）| testing data 沒這麼多 | seed script 灌 dummy data |

---

## 摘要：50-60 按鈕問題的回答

**(a) 測試時間會很久嗎？**

「全部按鈕、全部 scope」一次跑完的天真做法：序列 4-8 小時、平行 2-3 小時。這**不是合理做法**。

正確做法是**三層分流**：

- **Smoke（每次 PR）**：5-10 個關鍵按鈕，3-5 分鐘
- **Standard（每次 merge / 每日）**：30 個高風險按鈕，20-40 分鐘
- **Full（nightly / pre-release）**：全部 60 個按鈕，2-4 小時，離峰跑

開發者每次提交感受到的是 smoke 的 5 分鐘，不是 4 小時。

**(b) 系統怎麼處理？**

1. `testing.yml` 用 `buttons` + `tier` + `auth` 把 60 個按鈕分類
2. 每個 scope 從這份清單**依 tier 過濾**自己要打的端點
3. 每個 scope **內部平行**（k6 VU、ZAP thread、Lighthouse 多 chrome）
4. **scope 之間序列化**——避免互相污染與 DDoS 自己
5. 報告依 tier 分區、依 role 分軸，cross-role diff 自動算權限漏洞

關鍵心智模型：**目前管線把「URL」當輸入，計畫後改成把「按鈕清單 + journey + role」當輸入**——這是從「機械掃描」升級為「業務感知測試」的本質改變。

---

## 執行順序建議

| 順 | Scope | 工作量 | 影響面 | 建議排程 |
|:-:|---|:-:|:-:|---|
| 1 | testing.yml schema 擴充（auth / buttons / journeys / tier） | 中 | 大（所有 scope 依賴） | Week 1 |
| 2 | ZAP auth context + per-role | 大 | 大 | Week 1-2 |
| 3 | k6 journey-based + session | 大 | 中 | Week 2 |
| 4 | Lighthouse 多頁 + auth | 小 | 小 | Week 3 |
| 5 | Lychee 帶 cookie | 極小 | 極小 | Week 3 |
| 6 | Nuclei 帶 session（可省略） | 小 | 極小 | Week 4（或不做） |
| 7 | summarize.js 擴充 + cross-role diff | 中 | 大（讀報告體驗） | Week 4 |
| 8 | tier 切換機制 + CI 整合 | 中 | 大 | Week 4 |

---

## 附錄：本計畫不會動到的部分

- E2E spec 內容（業務邏輯，由各專案自己寫）
- Trivy / 靜態分析 / SSL scan（已是不需 auth 的合理範圍）
- API test（OpenAPI driven，已支援 auth header 注入）
- UI server / Skill 流程（這次完成的 capture-session 已足夠把 storage-state 餵給後續 scope）

完。
