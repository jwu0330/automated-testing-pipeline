# Playwright E2E 通用骨架

本目錄是 **流水線提供的通用 Playwright 範本**，不會直接被 `tests/scripts/run-project.sh` 執行。

## 用途

1. **作為新專案的起手模板**：複製整包到 `<project>/.testing/e2e/` 然後改寫。
2. **作為煙霧測試的參考**：[tests/smoke.spec.ts](./tests/smoke.spec.ts) 列出任何 PHP 網站都適用的基本檢查。

## 如何在新專案套用

```bash
mkdir -p /path/to/your-project/.testing/e2e
cp -r /mnt/e/Code/github/automated-testing-pipeline/tests/e2e/* \
      /path/to/your-project/.testing/e2e/

cd /path/to/your-project/.testing/e2e
# 編輯 tests/project.spec.ts 加入專案特定的 UI 測試
```

然後在 `<project>/.testing/testing.yml` 啟用：

```yaml
tests:
  e2e:
    enabled: true
```

## 登入帳密

若 E2E 需要登入，在流水線根目錄 `.env` 加入：

```
E2E_USERNAME=xxx
E2E_PASSWORD=xxx
```

`run-project.sh` 會自動注入給 Playwright 容器。
