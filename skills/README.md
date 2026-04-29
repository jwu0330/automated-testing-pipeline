# automated-testing-pipeline — Claude Code Skills

三個 Claude Code Skill，**獨立發行**，覆蓋兩種使用情境。

## 哪個 skill 用在哪個情境？

| 情境 | 你有原始碼？ | 重複跑？ | 用哪個 skill |
|---|---|---|---|
| 自家專案的長期測試流水線 | ✅ | ✅ | `/pipeline-init` 一次 + `/pipeline-run` 多次 |
| 一次性 review 別人的網站（沒原始碼） | ❌ | ❌ | `/pipeline-quick-test`（一次到位） |

| Skill | 用途 |
|-------|------|
| **`pipeline-init`** | 長期模式 — 第一次接入：偵測 OpenAPI、產 `testing.yml` / `.env.example`、註冊專案。**不跑測試。** |
| **`pipeline-run`** | 長期模式 — 執行測試：讀設定、選 scope、跑 pipeline、摘要報告。**不改設定。** |
| **`pipeline-quick-test`** | 一次性 review — 給網址 / 帳密 → 建臨時資料夾 → 跑全套 → 出報告。資料夾本地 gitignore，review 完手動刪。 |

三個 skill 都假設 **pipeline 本體已經安裝在這台機器某處**（環境變數 `$PIPELINE_HOME` 或預設位置）。你的個別專案不需要 pipeline 的副本，只要這些 skill 即可。

---

## 安裝（兩種選一）

### 方式 A：複製到「你的專案」.claude/skills/（專案級）

只在這個專案內可用：

```bash
cd /path/to/your-project
mkdir -p .claude/skills/pipeline-init .claude/skills/pipeline-run .claude/skills/pipeline-quick-test

curl -L https://github.com/jwu0330/automated-testing-pipeline/releases/latest/download/pipeline-init_SKILL.md \
  -o .claude/skills/pipeline-init/SKILL.md

curl -L https://github.com/jwu0330/automated-testing-pipeline/releases/latest/download/pipeline-run_SKILL.md \
  -o .claude/skills/pipeline-run/SKILL.md

curl -L https://github.com/jwu0330/automated-testing-pipeline/releases/latest/download/pipeline-quick-test_SKILL.md \
  -o .claude/skills/pipeline-quick-test/SKILL.md
```

### 方式 B：複製到 `~/.claude/skills/`（使用者級，全電腦可用）

所有專案都能呼叫：

```bash
mkdir -p ~/.claude/skills/pipeline-init ~/.claude/skills/pipeline-run ~/.claude/skills/pipeline-quick-test

curl -L https://github.com/jwu0330/automated-testing-pipeline/releases/latest/download/pipeline-init_SKILL.md \
  -o ~/.claude/skills/pipeline-init/SKILL.md

curl -L https://github.com/jwu0330/automated-testing-pipeline/releases/latest/download/pipeline-run_SKILL.md \
  -o ~/.claude/skills/pipeline-run/SKILL.md

curl -L https://github.com/jwu0330/automated-testing-pipeline/releases/latest/download/pipeline-quick-test_SKILL.md \
  -o ~/.claude/skills/pipeline-quick-test/SKILL.md
```

---

## 安裝後

在該專案目錄打開 Claude Code，輸入：

```
/pipeline-init     # 第一次接入
/pipeline-run      # 之後每次跑測試
```

兩個 skill 會自動找到 `$PIPELINE_HOME`（或問你一次後記到 `.testing/testing.yml`）。

---

## 環境前置（兩個 skill 都會檢查）

| 工具 | 為什麼 |
|------|--------|
| `automated-testing-pipeline` 本體 clone 在某處 | skill 會跑 pipeline 的 scripts |
| Docker + Docker Compose v2 | 所有測試容器化 |
| `yq`（Go 版）| 讀 `testing.yml` |
| node | 跑 `summarize.js` 產報告 |

skill 不會自動裝這些，但會明確告訴你缺哪個、該怎麼裝。

---

## 三個 Skill 的分工

### 長期模式（自家專案）

```
你的專案 (pwd)
  │
  ├─ /pipeline-init  ───────►  讀 cwd → 偵測 OpenAPI →
  │                            產 .testing/testing.yml + .env.example →
  │                            註冊到 pipeline 的 projects.registry.yml
  │                            （不跑任何測試）
  │
  └─ /pipeline-run   ───────►  讀 .testing/testing.yml →
                               選 scope（預設 smoke：precheck,ssl）→
                               跑 <pipeline>/scripts/run-project.sh →
                               摘要 <project>/.testing/reports/report.md
                               （不改設定、不註冊）
```

### 一次性 review 模式（review 別人的站）

```
任何 pwd
  │
  └─ /pipeline-quick-test  ───►  問你：URL / name / ADMIN 帳密 →
                                 建 <pipeline>/<name>/.testing/{testing.yml,.env} →
                                 加 /<name>/ 到 .git/info/exclude（本地 gitignore）→
                                 註冊 → 跑 all →
                                 摘要 <pipeline>/<name>/.testing/reports/report.md
                                 （review 完你手動 rm -rf <name>/）
```

設計原則：
- **init 改設定、run 不改設定**（長期模式職責分離）
- **quick-test 一次到位**（review 模式不分階段）
- 不同情境分開，避免單一 skill 變成肥大開關

---

## 安全防護（兩個 skill 都有）

- ❌ 不會自動 `git push` / `git commit`
- ❌ 不會幫你填 `.env` 機密值
- ❌ 不會自動安裝缺少的工具
- ❌ run skill **不對 production-looking URL 自動跑 `all`**（會偵測 url 是否含 staging/dev/localhost；不像就先確認）
- ❌ run skill 預設只跑 smoke（`precheck,ssl`，30 秒內），全套要明確指定

---

## 相關文件

- 完整快速上手：[`docs/QUICKSTART.md`](https://github.com/jwu0330/automated-testing-pipeline/blob/master/docs/QUICKSTART.md)
- 操作手冊：[`docs/run-tests.md`](https://github.com/jwu0330/automated-testing-pipeline/blob/master/docs/run-tests.md)
- 規範：[`docs/project-convention.md`](https://github.com/jwu0330/automated-testing-pipeline/blob/master/docs/project-convention.md)
- 主 repo：<https://github.com/jwu0330/automated-testing-pipeline>
