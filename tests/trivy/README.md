# Trivy 供應鏈 / 機敏資料掃描

[Aqua Security Trivy](https://github.com/aquasecurity/trivy)：同時掃 **dependency CVE / 洩漏的 secret / 錯誤配置**。

## 工作原理

1. `run-project.sh <name> trivy` 直接 `docker run aquasec/trivy:latest`（不用 compose，因為要 bind mount `local_path`）
2. 模式 `fs`：掃 `local_path` 下的：
   - `composer.lock` / `package-lock.json` / `requirements.txt` 等 → CVE
   - 原始碼中的 API Key / Token 字串 → Secret
   - `Dockerfile` / k8s YAML → Misconfiguration
3. 輸出 `/reports/trivy-fs.json`
4. `summarize.js` 聚合 severity 分佈 + 列出 critical/high 發現

## 觸發條件

- 需要 `local_path` — 沒有本地原始碼則跳過
- 預設 `enabled: auto`（偵測到 local_path 就開）

## 覆寫設定

於 `<project>/.testing/testing.yml`：

```yaml
tests:
  trivy:
    enabled: true
    severity: CRITICAL,HIGH,MEDIUM      # 逗號分隔（注意大寫）
    scanners: vuln,secret,misconfig     # 可省略某項
    skip_dirs:                          # 額外排除路徑
      - vendor/bin
      - tests/fixtures
```

## 為什麼不掃 image

Trivy 也能掃 Docker image（`trivy image <name>`），但本管線的 image 多為官方 image（php:8.1、mysql:8.0 等），掃出來都是上游責任、難以修。需要時可手動跑：

```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  aquasec/trivy:latest image php:8.1-cli
```
