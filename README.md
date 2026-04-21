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
| 資安掃描 | OWASP ZAP | 通用 | Web 應用弱點掃描（XSS、SQL Injection） |
| 壓力測試 | k6 | 通用 | API 與頁面的負載與效能測試 |
| 靜態分析 | PHPStan | 通用 | PHP 程式碼品質與型別檢查 |
| **單元測試** | **PHPUnit** | **客製** | **各專案在 `.testing/unit/` 自行撰寫** |
| **UI / E2E 測試** | **Playwright** | **客製** | **各專案在 `.testing/e2e/` 自行撰寫** |

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
│   ┌───────────┼───────────┬──────────┬───────────┐     │
│   ▼           ▼           ▼          ▼           ▼     │
│ testssl   ZAP         k6        PHPStan     PHPUnit   │
│  (遠端)   (遠端)      (遠端)    (本地原始碼) (本地原始碼) │
│                                                          │
└──────────────────────────────────────────────────────────┘
                    │
                    │ HTTPS（僅遠端測試）
                    ▼
         遠端主機 xcity.babydodofun.com
```

**兩種測試資料流**：
- **遠端流**（SSL / ZAP / k6 / E2E）：從 Docker 發 HTTPS 請求打目標站
- **本地流**（PHPStan / PHPUnit）：掛載專案原始碼到 Docker 內做分析

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
│   ├── stress/load-test.js        # 通用 k6 腳本
│   ├── static/phpstan.neon.dist   # ★ 通用 PHPStan 設定
│   ├── unit/phpunit.xml.dist      # ★ PHPUnit 範本（給專案複製）
│   └── e2e/                       # ★ Playwright 通用骨架
│       ├── package.json
│       ├── playwright.config.ts
│       └── tests/smoke.spec.ts
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

### 第一次：啟動 n8n（一次即可）

```bash
cd /mnt/e/Code/github/automated-testing-pipeline
cp .env.example .env                                 # 若尚未建立
# 編輯 .env，填入 N8N_PASSWORD

docker compose --profile n8n up -d --build
# 開啟瀏覽器：http://localhost:5678
# 匯入 n8n/workflows/pipeline-skeleton.json
```

### 註冊你的第一個專案

```bash
# 1. 在你的專案根目錄建立 .testing/
mkdir -p /mnt/e/cwe網站/b12/babydodofun/.testing
cp scripts/testing-yml-template.yml \
   /mnt/e/cwe網站/b12/babydodofun/.testing/testing.yml
# 編輯該 testing.yml

# 2. 註冊
bash scripts/register-project.sh babydodofun /mnt/e/cwe網站/b12/babydodofun

# 3. 驗證通用測試
bash scripts/run-project.sh babydodofun ssl
```

### 日常執行

```bash
bash scripts/run-project.sh babydodofun            # 全部測試
bash scripts/run-project.sh babydodofun security   # 只跑 ZAP
bash scripts/run-project.sh babydodofun static     # 只跑 PHPStan
```

報告輸出：`reports/<project-name>/`

---

## 文件

- **[docs/project-convention.md](./docs/project-convention.md)** — 專案必讀：資料夾、路徑、內含項目、執行方式的規範
- [docs/run-tests.md](./docs/run-tests.md) — 操作手冊（骨架）
- [docs/setup.md](./docs/setup.md) — WSL/Docker 安裝

---

## 版本紀錄

| 版本 | 日期 | 說明 |
|------|------|------|
| v0.1 | 2026-04-21 | 初始專案建立 |
| v0.2 | 2026-04-21 | 補齊骨架：n8n、PHPStan、PHPUnit、Playwright、專案註冊機制、規範文件 |
