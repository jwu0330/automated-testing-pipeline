# Automated Testing Pipeline

針對 [babydodofun](https://xcity.babydodofun.com) 網站的自動化測試與 CI/CD 流水線。

## 專案目標

透過 Docker 容器化的方式，整合多種開源測試工具，對遠端主機進行全方位的自動化測試，包含：

| 測試類型 | 工具 | 說明 |
|---------|------|------|
| SSL/TLS 檢測 | testssl.sh | 檢查憑證、協定版本、加密強度 |
| 資安掃描 | OWASP ZAP | Web 應用弱點掃描（XSS、SQL Injection 等） |
| 壓力測試 | k6 | API 與頁面的負載與效能測試 |
| UI/E2E 測試 | Playwright | 模擬使用者操作流程 |
| 靜態分析 | PHPStan | PHP 程式碼品質與型別檢查 |

## 架構概覽

```
┌─────────────────────────────────────────┐
│  本機 (Windows 11 + WSL + Docker)        │
│                                         │
│  ┌───────────┐  ┌───────────┐           │
│  │ testssl   │  │ OWASP ZAP │           │
│  └─────┬─────┘  └─────┬─────┘           │
│        │              │                  │
│  ┌─────┴──────────────┴─────┐           │
│  │     Docker Network        │           │
│  └─────────────┬─────────────┘           │
│                │                         │
└────────────────┼─────────────────────────┘
                 │ HTTPS
                 ▼
┌─────────────────────────────────────────┐
│  遠端主機 (xcity.babydodofun.com)        │
│  103.17.8.31 (共享主機 / cPanel)         │
└─────────────────────────────────────────┘
```

**重點**：所有測試工具都在本機 Docker 內執行，透過網路對遠端主機發送請求。不需要在遠端主機安裝任何東西。

## 環境需求

- Windows 11 + WSL2 (Ubuntu 24.04)
- Docker 29.3+
- Git

## 專案結構

```
automated-testing-pipeline/
├── README.md              # 本文件
├── docker-compose.yml     # 一鍵啟動所有測試容器
├── Dockerfile             # 自訂測試環境映像檔
├── .env.example           # 環境變數範本
├── .gitignore             # Git 忽略規則
├── scripts/               # 執行腳本
│   └── run-all.sh         # 一鍵執行全部測試
├── tests/                 # 測試設定與腳本
│   ├── ssl/               # testssl.sh 設定
│   ├── security/          # OWASP ZAP 設定
│   ├── stress/            # k6 壓力測試腳本
│   ├── e2e/               # Playwright E2E 測試
│   └── static/            # PHPStan 靜態分析設定
├── reports/               # 測試報告輸出（gitignore）
└── docs/                  # 操作文件
    └── setup.md           # 環境安裝與設定步驟
```

## 快速開始

```bash
# 1. 複製環境變數
cp .env.example .env
# 編輯 .env 填入目標網址

# 2. 啟動測試（在 WSL 內執行）
docker compose up --build

# 3. 查看報告
ls reports/
```

## 測試執行順序

1. **SSL/TLS 檢測** — 最快，確認基礎安全
2. **靜態分析** — 檢查程式碼品質
3. **資安掃描** — OWASP ZAP 基線掃描
4. **壓力測試** — k6 負載測試
5. **E2E 測試** — Playwright 使用者流程

## 版本紀錄

| 版本 | 日期 | 說明 |
|------|------|------|
| v0.1 | 2026-04-21 | 初始專案建立：README、專案結構、Git 初始化 |
