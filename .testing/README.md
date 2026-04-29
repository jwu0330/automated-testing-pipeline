# `.testing/` — 專案測試工具包

> 把這個資料夾整包放到你的專案根目錄，就能接上共用 `automated-testing-pipeline`。

---

## 快速開始（3 步驟）

```bash
# 1. 整包複製（保留資料夾名 .testing/）
cp -r /path/to/automated-testing-pipeline/.testing /path/to/your-project/

# 2. 編輯 testing.yml 裡的 4 個必填欄位
vim your-project/.testing/testing.yml

# 3. 一鍵跑完
bash your-project/.testing/link.sh
```

報告產出：`<pipeline>/reports/<your-project-name>/report.md`

---

## 一、必填（少一個就跑不起來）

### 1.1 `testing.yml`（4 個欄位）

```yaml
schema_version: 2

project:
  name: my_site                          # 專案識別名稱（英數底線）
  target_url: https://my-site.com        # 線上測試目標 URL
  local_path: /mnt/e/code/my-site        # 本地原始碼絕對路徑；"" → 只跑網路測試
  php_version: "8.1"                     # 非 PHP 專案留預設即可
```

### 1.2 固定規則

| 規則 | 為什麼不能改 |
|------|-----|
| 資料夾名必須是 `.testing/`，放在專案根目錄 | pipeline 靠這路徑偵測 |
| 設定檔名必須是 `testing.yml` | `run-project.sh` 寫死讀這檔名 |
| `.env`（若有）不要 commit | 敏感值；已寫入 `.gitignore` |
| 所有測試容器由共用 pipeline 執行 | 避免每專案各裝一套 Docker image |
| 執行入口只用 `link.sh` | 會處理註冊 + 啟動 + 執行 |

### 1.3 共用 pipeline 的位置

`link.sh` 按這順序找：

1. 環境變數 `PIPELINE_HOME`
2. `testing.yml` 的 `pipeline.home` 欄位
3. 預設 `/mnt/e/Code/github/automated-testing-pipeline`

---

## 二、按需啟用（有用到才填）

### 2.1 專案客製測試（各資料夾）

> **需要專案測試碼**（e2e / api）：資料夾放了檔案才會跑
> **通用測試的覆寫**（ssl / security / stress / static / ...）：一律會跑；資料夾只是額外客製
>
> **單元測試不在這裡**：請於專案自己的測試資料夾撰寫並執行；本 pipeline 不接管。

| 資料夾 | 觸發條件 | 放什麼 |
|--------|---------|--------|
| `e2e/` | 有 `e2e/package.json` → 才會跑 | `package.json` + `playwright.config.ts` + `tests/*.spec.ts` |
| `api/collections/` | 有 `*.postman_collection.json` → 才會跑 | Postman collection JSON（手寫） |
| `api/openapi.{yaml,yml,json}` | 自動轉成 Postman collection 後跑 | OpenAPI 3.x 規格檔（首選來源） |
| `static/phpstan.neon` | 存在 → 覆寫預設 | 客製 PHPStan 設定 |
| `ssl/*.conf` | 存在 → 覆寫預設 | 客製 testssl.sh 參數 |
| `security/zap.conf` | 存在 → 覆寫預設 | 自訂 ZAP 規則 |
| `stress/load-test.js` | 存在 → 取代預設 | 客製 k6 腳本 |
| `nuclei/templates/` | 存在 → 額外模板 | 自訂 nuclei YAML |
| `monkey/gremlins.spec.ts` | 存在 → 取代骨架 | 需登入等情境的 monkey spec |
| `hooks/pre.sh` / `post.sh` | 存在 → 測試前/後執行 | shell 鉤子 |

### 2.2 測試身分（給 `api-test` / `auth-test` 用）

> **重點**：不同身分應該看到不同頁面/API。管理者能進的頁，一般使用者應該 401/403。每個身分跑一輪完整 collection。

在 `.testing/.env` 填（最多 6 組：1 ADMIN + 5 USER）：

```bash
ADMIN_USERNAME=admin001            # 管理者（寫死預設）
ADMIN_PASSWORD=@admin001

USER1_USERNAME=                    # 選填，留空 → 此身分整輪 skip
USER1_PASSWORD=
USER1_LABEL=line_signup            # 選填，報告檔名會帶這個標籤

USER2_USERNAME=                    # 再加就填 USER2_ / USER3_ ...
USER2_PASSWORD=
USER2_LABEL=phone_signup

# USER3_ / USER4_ / USER5_ 同理
```

**行為**：給幾組帳密就跑幾輪。報告檔名：

```
newman-junit-admin.xml
newman-junit-user1-line_signup.xml
newman-junit-user2-phone_signup.xml
```

**為什麼要跑多輪？** 不同註冊管道（LINE / 手機 / Email）雖然看起來一樣，但：
- 登入流程可能差一步（LINE 不需要 OTP、手機要）
- 管理端跟使用者端的 UI 常常是兩套
- 即使只是細微差異，都要獨立驗過才能確定沒漏

### 2.3 覆寫測試參數

在 `testing.yml` 加 `tests:` 區塊（範例見 `testing.yml` 註解）。沒寫就走自動偵測。

### 2.4 E2E 登入（舊欄位，向下相容）

Playwright 舊 spec 用的 `E2E_USERNAME` / `E2E_PASSWORD` 放在 `.testing/.env`，通常沿用 `ADMIN_*` 的值即可。

---

## 三、一鍵指令

```bash
bash .testing/link.sh              # 連結 + 跑完全部
bash .testing/link.sh link         # 只連結，不跑
bash .testing/link.sh run          # 只跑（之前已連結過）
```

`link.sh` 做的事：
1. 讀 `testing.yml` 拿專案名稱/路徑
2. 呼叫 pipeline 的 `register-project.sh` 註冊
3. 確認 n8n 容器啟動
4. 呼叫 `run-project.sh <name> all` 跑 11 種測試 + 產評分卡

單獨跑某個 scope（不走 n8n）：

```bash
bash <pipeline>/scripts/run-project.sh <name> <scope>
# scope 可用：ssl / security / stress / static / e2e /
#             api-test / auth-test / visual-test / browser-compat /
#             nuclei / lighthouse / monkey / trivy / links
```

---

## 附錄 A：自動偵測規則（Silence = Default）

沒在 `testing.yml` 寫、對應資料夾也沒放檔案時的預設：

| 測試 | 預設 |
|------|------|
| ssl | `target_url` 是 `https://` 就開 |
| security (ZAP) | 一律開 |
| stress (k6) | 一律開（vus=10, duration=30s, pages=[/]） |
| static (PHPStan) | `local_path` 有 `.php` 檔就開（level=5） |
| e2e (Playwright) | `.testing/e2e/package.json` 存在才開 |
| api-test / auth-test | 任一條件成立才開：`.testing/api/collections/*.postman_collection.json` 存在；或 `.testing/api/openapi.{yaml,yml,json}` 存在；或 `testing.yml:tests.api-test.openapi` 指到一個有效檔。**全部沒有 → 安靜跳過**（純前端站不會被擋） |
| nuclei | 一律開（severity=critical,high,medium） |
| lighthouse | 一律開（preset=desktop, pages=[/]） |
| monkey | 一律開（pages=[/], attacks=500, delay_ms=10） |
| trivy | `local_path` 不為空就開（severity=CRITICAL,HIGH,MEDIUM） |
| links | 一律開（timeout=15, max_concurrency=4） |

**原則：沉默＝用預設；要覆寫才寫。**

---

## 附錄 B：報告位置

```
<pipeline>/reports/<your-project-name>/
├── report.md              ★ 看這個就好
├── report.json            結構化版本（給 n8n / CI）
├── history.jsonl          累計歷史
└── raw/                   工具原始輸出
    ├── newman-junit-admin.xml                  API/Auth 身分：admin
    ├── newman-junit-user1-line_signup.xml      API/Auth 身分：user1
    ├── newman-junit-user2-phone_signup.xml     ...
    ├── newman-junit.xml                        最後一輪的副本（給 summarize.js）
    ├── playwright/ / playwright-junit.xml
    ├── testssl-*.{html,json}
    ├── zap-report.{html,json}
    ├── k6-summary.json
    ├── phpstan.json
    ├── nuclei.jsonl
    ├── lighthouse-*.{html,json}
    ├── monkey-report.json
    ├── trivy-fs.json
    └── lychee.json
```

n8n GUI：http://localhost:5678（帳密在 pipeline 的 `.env`）

---

## 附錄 C：FAQ

**Q：我只想 commit `testing.yml`，不想整包 commit？**
不建議。其他人接手時 `link.sh` 就沒了。最多把 `.env` 和測試產物（`e2e/node_modules/` 等）排掉（已在 `.gitignore` 中）。

**Q：兩個專案要共用同一份 pipeline，要各複製一份 `.testing/` 嗎？**
對。每個專案的 `.testing/` 是它自己的客製區；共用的只有 pipeline 本身。每個專案 `name` 要不同，報告分別放 `reports/<name>/`。

**Q：pipeline 裝在非預設位置？**
`export PIPELINE_HOME=/your/path` 再跑 `link.sh`，或在 `testing.yml` 取消註解 `pipeline.home`。

**Q：`link.sh` 能改嗎？**
不建議。未來 pipeline 更新 `link.sh` 也會跟著動，改了就收不到更新。客製需求寫在 `hooks/pre.sh` 或 `hooks/post.sh`。

**Q：沒裝 yq 怎麼辦？**
`link.sh` 有簡易 fallback 能讀基本欄位；但 pipeline 的 `run-project.sh` 需要 yq。到 pipeline 主機裝一次即可：

```bash
wget -qO ~/.local/bin/yq https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64
chmod +x ~/.local/bin/yq
```

**Q：只給 1 組帳密會有問題嗎？**
不會。admin 那輪照跑，USER1..5 全部 skip。要驗「管理端 vs 使用者端」隔離時才補其他組。

---

## 附錄 D：新專案接入檢查清單

- [ ] 整包複製 `.testing/` 到專案根
- [ ] 編輯 `testing.yml` 的 4 個必填欄位
- [ ] （可選）需要 API/Auth 測試 → `cp .env.example .env`，填 `ADMIN_*` 和需要的 `USER*_*`
- [ ] （可選）需要 e2e → 放 `e2e/package.json` + `e2e/tests/*.spec.ts`
- [ ] （可選）調整新工具參數 → 在 `testing.yml` 加 `tests.xxx.*` 區塊
- [ ] 執行 `bash .testing/link.sh`
- [ ] 打開 `<pipeline>/reports/<name>/report.md` 看結果
