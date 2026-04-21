# Nuclei 深層資安掃描

[ProjectDiscovery Nuclei](https://github.com/projectdiscovery/nuclei)：模板化弱點掃描，補 ZAP baseline 抓不到的 CVE / 錯誤配置 / 洩漏端點。

## 工作原理

1. `run-project.sh <name> nuclei` 觸發 `docker compose --profile nuclei`
2. 直接用官方 image `projectdiscovery/nuclei:latest`
3. 依 `tests.nuclei.severity` 挑選嚴重度（預設 `critical,high,medium`）
4. 輸出 `/reports/nuclei.jsonl`（JSONL，一行一個 finding）
5. `summarize.js` 聚合 severity 分佈 + 列出 critical/high finding

## 覆寫設定

於 `<project>/.testing/testing.yml`：

```yaml
tests:
  nuclei:
    enabled: true
    severity: critical,high,medium     # 逗號分隔；可加 low / info
    rate_limit: 50                     # req/s（共享主機建議 ≤ 50）
    templates: ""                      # 預留：額外指定模板路徑
```

## 注意

- Nuclei 預設會在啟動時檢查模板更新。我們用 `-disable-update-check` 關掉，避免流水線被外網拖慢或卡住。
- 若目標站有 WAF / rate limit，請調低 `rate_limit`。
- 模板更新：定期 `docker pull projectdiscovery/nuclei:latest` 即可取得最新 CVE 模板。
