# Automated Testing Pipeline

> **角色**：「測試總管理者」。
> 負責對任何遵守 [專案測試規範](./docs/project-convention.md) 的 PHP 網站專案，
> 執行自動化測試（SSL / 資安 / 壓力 / 靜態分析 / E2E / API）。
>
> **單元測試不歸這邊管**：每個專案的單元測試由其自己的測試資料夾自行維護。
> 本 pipeline 專注於黑箱／行為測試（API、壓力、安全、E2E、視覺迴歸等）。

---

## 專案目標

將以下測試統一放進 Docker，透過 n8n 做成可視化流水線：

| 測試類型 | 工具 | 通用/客製 | 說明 |
|---------|------|---------|------|
| SSL/TLS 檢測 | testssl.sh | 通用 | 檢查憑證、協定版本、加密強度 |
| 資安基線 | OWASP ZAP | 通用 | Web 應用弱點掃描（XSS、SQL Injection） |
| **深層資安** | **Nuclei** | **通用** | **模板化 CVE / 錯誤配置 / 洩漏端點掃描** |
| 壓力測試 | k6 | 通用 | API 與頁面的負載與效能測試 |
| **前端品質** | **Lighthouse** | **通用** | **Core Web Vitals / A11y / 最佳實踐 / SEO** |
| **連結檢查** | **Lychee** | **通用** | **壞連結 / 圖片 404** |
| 靜態分析 | PHPStan | 通用 | PHP 程式碼品質與型別檢查 |
| **供應鏈** | **Trivy** | **通用** | **依賴 CVE / 洩漏 secret / 錯誤配置** |
| **API 測試** | **Newman (Postman)** | **客製** | **各專案在 `.testing/api/collections/` 放 Postman collection** |
| **UI / E2E 測試** | **Playwright** | **客製** | **各專案在 `.testing/e2e/` 自行撰寫** |
| **互動探測** | **Gremlins.js** | **通用** | **Monkey 測試：隨機亂點亂打，抓未處理 JS 錯誤** |

---

## 架構

```
┌──────────────────────────────────────────────────────────┐
│  本機 (Windows 11 + WSL + Docker)                        │
│                                                          │
│  ┌─────────────────────────────────────┐                │
│  │  n8n (測試總管理者 @ :5678)         │                │
│  │   ├─ 手動/排程觸發                   │                │
│  │   └─ Execute Command 呼叫下方腳本   │                │
│  └────────────┬────────────────────────┘                │
│               │                                          │
│               ▼                                          │
│  ┌─────────────────────────────────────┐                │
│  │  scripts/run-project.sh             │                │
│  │   ├─ 讀 projects.registry.yml       │                │
│  │   ├─ 讀 <project>/.testing/testing.yml           │  │
│  │   └─ 依設定執行下列 docker 容器     │                │
│  └────────────┬────────────────────────┘                │
│               │                                          │
│   ┌───────────┬──────────┬──────────┬─────────────┐   │
│   ▼           ▼          ▼          ▼             ▼   │
│ testssl   ZAP/Nuclei   k6      PHPStan/Trivy  Newman  │
│ Lighthouse  Lychee   Monkey  Playwright(E2E)          │
│  (遠端)    (遠端)    (遠端)    (本地原始碼)    (遠端)  │
│                                                          │
└──────────────────────────────────────────────────────────┘
                    │
                    │ HTTPS（僅遠端測試）
                    ▼
         遠端主機 xcity.babydodofun.com
```

**兩種測試資料流**：
- **遠端流**（SSL / ZAP / Nuclei / k6 / Lighthouse / Lychee / E2E / Monkey / Newman API）：從 Docker 發 HTTPS 請求打目標站
- **本地流**（PHPStan / Trivy）：掛載專案原始碼到 Docker 內做分析

---

## 專案結構

```text
automated-testing-pipeline/
├── README.md                      # 本文件
├── docker-compose.yml             # 所有服務定義（含 n8n）
├── Dockerfile                     # testssl 自訂映像
├── .env / .env.example            # 環境變數
├── projects.registry.yml          # 客戶專案註冊表（gitignore）
├── projects.registry.example.yml  # 註冊表範本
│
├── .testing/                      # ★ 專案導入工具包（可整包複製到客戶專案）
│   ├── README.md                  #   唯一說明文件（必要 / 可選）
│   ├── testing.yml                #   4 個必填欄位範本
│   ├── link.sh                    #   一鍵連結 + 跑完整流程
│   ├── .env.example               #   可選：專案敏感值範本
│   └── {e2e,api,static,ssl,security,stress,lighthouse,nuclei,hooks,scripts}/
│                                  #   10 個可選客製資料夾（預設空 .gitkeep）
│
├── scripts/
│   ├── run-all.sh                 # 舊有：跑 compose 的全部 profile
│   ├── run-project.sh             # ★ 新：對指定專案跑測試
│   ├── register-project.sh        # ★ 新：註冊專案
│   └── testing-yml-template.yml   # ★ testing.yml 範本
│
├── n8n/
│   ├── Dockerfile                 # n8n + docker-cli + yq
│   └── workflows/
│       ├── README.md
│       └── pipeline-skeleton.json # ★ 可匯入的 workflow
│
├── tests/
│   ├── ssl/run-testssl.sh         # 通用 SSL 腳本
│   ├── security/                  # ZAP 由 compose 直接驅動
│   ├── nuclei/                    # ★ Nuclei 由 compose 直接驅動
│   ├── stress/load-test.js        # 通用 k6 腳本
│   ├── lighthouse/                # ★ Lighthouse（Dockerfile + run script）
│   │   ├── Dockerfile
│   │   └── lighthouse-run.sh
│   ├── links/                     # ★ Lychee 由 compose 直接驅動
│   ├── static/phpstan.neon.dist   # ★ 通用 PHPStan 設定
│   ├── trivy/                     # ★ Trivy 由 run-project.sh 直接 docker run
│   ├── api/                       # ★ Newman / Postman API 測試骨架
│   │   ├── Dockerfile
│   │   ├── collections/
│   │   └── postman/run-newman.sh
│   ├── e2e/                       # ★ Playwright 通用骨架
│   │   ├── package.json
│   │   ├── playwright.config.ts
│   │   └── tests/smoke.spec.ts
│   └── monkey/                    # ★ Gremlins.js monkey 測試骨架
│       ├── package.json
│       ├── playwright.config.ts
│       └── tests/gremlins.spec.ts
│
├── docs/
│   ├── setup.md                   # 舊有環境安裝步驟
│   ├── project-convention.md      # ★ 專案測試規範（核心文件）
│   └── run-tests.md               # ★ 操作手冊（骨架，待填）
│
└── reports/                       # 每個專案一個子目錄
    └── <project-name>/
```

---

## 快速開始

主要介面是 **Claude Code Skills**（CLI），三個 skill 對應兩種情境。

### 情境 A：自家專案的長期測試流水線（有原始碼）

在你的專案目錄打開 Claude Code：

```
/pipeline-init    # 第一次接入：偵測 OpenAPI、建 .testing/、註冊專案
/pipeline-run     # 之後每次跑：讀設定、選 scope、產報告
```

報告寫進 `<project>/.testing/reports/report.md`。

### 情境 B：一次性 review 別人的網站（沒原始碼）

```
/pipeline-quick-test
```

Skill 會問你 URL、專案名、ADMIN 帳密，然後在 `<pipeline>/<name>/` 建臨時資料夾、跑全套、產報告。資料夾本地 gitignore（`.git/info/exclude`），review 完手動 `rm -rf <name>/`。

### 安裝 skill（只需一次）

```bash
mkdir -p ~/.claude/skills/{pipeline-init,pipeline-run,pipeline-quick-test}
for s in pipeline-init pipeline-run pipeline-quick-test; do
  curl -L "https://github.com/jwu0330/automated-testing-pipeline/releases/latest/download/${s}_SKILL.md" \
    -o "~/.claude/skills/${s}/SKILL.md"
done
```

完整安裝說明：[`skills/README.md`](./skills/README.md)。

### CLI 直接操作（給沒裝 Claude Code 的人）

```bash
bash scripts/register-project.sh <name> <absolute-path>
bash scripts/run-project.sh <name>            # 全部測試
bash scripts/run-project.sh <name> ssl,e2e    # 多選
```

完整 scope：`all | ssl | security | stress | static | e2e | api-test | nuclei | lighthouse | monkey | trivy | links | summary`

---

## 文件

- **[`skills/README.md`](./skills/README.md)** ★ **從這裡開始** — 三個 skill 的使用方式
- [`docs/QUICKSTART.md`](./docs/QUICKSTART.md) — 15 分鐘上手 CLI 流程
- [`.testing/README.md`](./.testing/README.md) — `.testing/` kit 結構與必要 / 可選欄位
- [docs/project-convention.md](./docs/project-convention.md) — 專案測試規範
- [docs/run-tests.md](./docs/run-tests.md) — 操作手冊
- [docs/architecture-parallel-reporting.md](./docs/architecture-parallel-reporting.md) — 三路並行設計、報告安全驗證
- [docs/setup.md](./docs/setup.md) — WSL/Docker 安裝
- [n8n/workflows/README.md](./n8n/workflows/README.md) — **[已棄用]** n8n GUI 流程，僅作參考保留

---

## 操作注意事項

- **報告位置**：v0.6 起報告寫進 `<project>/.testing/reports/`（pipeline repo 不再儲存其他專案的測試結果）。Quick-test 模式寫進 `<pipeline>/<name>/.testing/reports/`，folder 本地 gitignore。
- **報告輪替**：`run-project.sh` 每次開跑前呼叫 `rotate-reports.sh`，把超過 `REPORTS_KEEP_DAYS`（預設 30）天的報告打包進 `archive/YYYY-MM.tar.gz`，archive 超過 365 天自動刪。關閉：`REPORTS_NO_ROTATE=1`。
- **中文路徑風險**：`projects.registry.yml` 裡若路徑含中文（例 `/mnt/e/cwe網站/...`），在 docker volume mount 跨 WSL ↔ Windows 偶爾出問題。建議客戶專案放純英數路徑，或在 WSL 內 `mklink` 別名。
- **n8n 已棄用**：保留 `n8n/` 目錄與 docker-compose service 作為參考，但不再主推。CLI / Claude Code Skills 是現在的主要介面。

---

## 版本紀錄

| 版本 | 日期 | 說明 |
|------|------|------|
| v0.1 | 2026-04-21 | 初始專案建立 |
| v0.2 | 2026-04-21 | 補齊骨架：n8n、PHPStan、PHPUnit、Playwright、專案註冊機制、規範文件 |
| v0.3 | 2026-04-21 | 補齊五工具：Nuclei（深層資安）/ Lighthouse（前端品質）/ Gremlins monkey / Trivy（供應鏈）/ Lychee（壞連結） |
| v0.4 | 2026-04-22 | 通用化：Form Trigger 取代寫死 projectName、失敗 Email 通知、Precheck 失敗即中止、reports 自動輪替、移除 xcity.babydodofun fallback |
| v0.5 | 2026-04-29 | 黑箱／行為測試專屬（移除 PHPUnit）、OpenAPI 自動轉 Postman collection |
| v0.6 | 2026-04-29 | 報告寫進專案 `.testing/reports/`、API parser、Monkey self-host、Quick-test skill、n8n 軟下架 |

---

## 版本紀錄

| 版本 | 日期 | 說明 |
|------|------|------|
| v0.1 | 2026-04-21 | 初始專案建立 |
| v0.2 | 2026-04-21 | 補齊骨架：n8n、PHPStan、PHPUnit、Playwright、專案註冊機制、規範文件 |
| v0.3 | 2026-04-21 | 補齊五工具：Nuclei（深層資安）/ Lighthouse（前端品質）/ Gremlins monkey / Trivy（供應鏈）/ Lychee（壞連結） |
| v0.4 | 2026-04-22 | 通用化：Form Trigger 取代寫死 projectName、失敗 Email 通知、Precheck 失敗即中止、reports 自動輪替、移除 xcity.babydodofun fallback |
