# 環境安裝與設定步驟

## 前置需求

- Windows 11 + WSL2 (Ubuntu 24.04)
- Docker 已安裝於 WSL 內

## 第一次使用

### 1. 進入 WSL

```bash
wsl
```

### 2. 切換到專案目錄

Docker 安裝在 E 槽，WSL 內對應路徑為 `/mnt/e/`：

```bash
cd /mnt/e/Code/github/automated-testing-pipeline
```

### 3. 建立環境變數

```bash
cp .env.example .env
```

編輯 `.env`，確認 `TARGET_URL` 指向正確的測試目標。

### 4. 執行單一測試

```bash
# 只跑 SSL 檢測
docker compose --profile ssl up --build

# 只跑資安掃描
docker compose --profile security up

# 只跑壓力測試
docker compose --profile stress up

# 只跑 E2E 測試
docker compose --profile e2e up
```

### 5. 執行全部測試

```bash
bash tests/scripts/run-all.sh
```

### 6. 查看報告

所有報告輸出在 `reports/` 目錄：

```bash
ls reports/
```

- `testssl-*.html` — SSL 檢測報告（瀏覽器開啟）
- `zap-report.html` — OWASP ZAP 資安報告
- `k6-results.json` — k6 壓力測試原始資料
- `k6-summary.json` — k6 測試摘要

## 注意事項

- **不要對正式環境做高壓測試**：k6 預設值很保守（10 VU），但仍建議先在低流量時段測試
- **OWASP ZAP 是被動掃描**：使用 `zap-baseline.py` 只做基線掃描，不會主動攻擊
- **共享主機限制**：遠振共享主機可能有請求頻率限制，壓力測試時注意不要超過
- **所有測試工具都在本機執行**：只透過 HTTPS 對遠端發送請求，不需要在主機上安裝任何東西

## WSL 路徑對照

| Windows 路徑 | WSL 路徑 |
|-------------|----------|
| `E:\Code\github\automated-testing-pipeline` | `/mnt/e/Code/github/automated-testing-pipeline` |
| `E:\cwe網站\b12\babydodofun` | `/mnt/e/cwe網站/b12/babydodofun` |
