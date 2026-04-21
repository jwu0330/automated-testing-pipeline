# Automated Testing Pipeline

> **角色**：「測試總管理者」。
> 負責對任何遵守 [專案測試規範](./docs/project-convention.md) 的 PHP 網站專案，
> 執行自動化測試（SSL / 資安 / 壓力 / 靜態分析 / 單元 / E2E）。

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
| **單元測試** | **PHPUnit** | **客製** | **各專案在 `.testing/unit/` 自行撰寫** |
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
│ testssl   ZAP/Nuclei   k6      PHPStan/Trivy  PHPUnit │
│ Lighthouse  Lychee   Monkey                           │
│  (遠端)    (遠端)    (遠端)    (本地原始碼) (本地原始碼) │
│                                                          │
└──────────────────────────────────────────────────────────┘
                    │
                    │ HTTPS（僅遠端測試）
                    ▼
         遠端主機 xcity.babydodofun.com
```

**兩種測試資料流**：
- **遠端流**（SSL / ZAP / Nuclei / k6 / Lighthouse / Lychee / E2E / Monkey）：從 Docker 發 HTTPS 請求打目標站
- **本地流**（PHPStan / PHPUnit / Trivy）：掛載專案原始碼到 Docker 內做分析

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
│   └── {unit,e2e,static,ssl,security,stress,lighthouse,nuclei,hooks,scripts}/
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
│   ├── unit/phpunit.xml.dist      # ★ PHPUnit 範本（給專案複製）
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

## 快速開始（推薦：一鍵導入）

共用 pipeline 只裝一次、啟動一次；每個專案複製 [`.testing/`](./.testing) kit 整包過去就能接上。

### 一次性：啟動共用 pipeline

```bash
cd /mnt/e/Code/github/automated-testing-pipeline
cp .env.example .env                      # 編輯填入 N8N_PASSWORD
docker compose --profile n8n up -d --build
```

### 每個新專案：三步驟一鍵跑

```bash
# 1. 整包複製 kit 到專案（保留資料夾名 .testing/）
cp -r /mnt/e/Code/github/automated-testing-pipeline/.testing /path/to/your-project/

# 2. 編輯 4 個必填欄位
vim /path/to/your-project/.testing/testing.yml

# 3. 一鍵連結 + 跑完所有 n8n 流程
bash /path/to/your-project/.testing/link.sh
```

完整說明：[`.testing/README.md`](./.testing/README.md)（必要 vs 可選、固定流程、FAQ 一份文件搞定）。

### 進階：CLI 直接操作（不走 kit）

```bash
bash scripts/register-project.sh <name> <path>
bash scripts/run-project.sh <name>            # 全部測試
bash scripts/run-project.sh <name> security   # 單一測試類型
```

完整 scope 列表：`all | ssl | security | stress | static | unit | e2e | nuclei | lighthouse | monkey | trivy | links | summary`

報告輸出：`reports/<project-name>/report.md`

---

## 文件

- **[`.testing/README.md`](./.testing/README.md)** ★ 新專案導入（必要 vs 可選、固定流程、一鍵指令）
- [docs/project-convention.md](./docs/project-convention.md) — 專案測試規範（深入參考）
- [docs/run-tests.md](./docs/run-tests.md) — 操作手冊
- [docs/setup.md](./docs/setup.md) — WSL/Docker 安裝

---

## 版本紀錄

| 版本 | 日期 | 說明 |
|------|------|------|
| v0.1 | 2026-04-21 | 初始專案建立 |
| v0.2 | 2026-04-21 | 補齊骨架：n8n、PHPStan、PHPUnit、Playwright、專案註冊機制、規範文件 |
| v0.3 | 2026-04-21 | 補齊五工具：Nuclei（深層資安）/ Lighthouse（前端品質）/ Gremlins monkey / Trivy（供應鏈）/ Lychee（壞連結） |
