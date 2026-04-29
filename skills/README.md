# automated-testing-pipeline — Claude Code Skills

兩個 Claude Code Skill，**獨立發行**，讓你不必把整個 pipeline repo 複製到每個專案裡。

| Skill | 用途 |
|-------|------|
| **`pipeline-init`** | 第一次接入：偵測 OpenAPI、產 `testing.yml` / `.env.example`、註冊專案 |
| **`pipeline-run`** | 執行測試：讀設定、選 scope、跑 pipeline、把結果摘要出來 |

兩個 skill 都假設 **pipeline 本體已經安裝在這台機器某處**（環境變數 `$PIPELINE_HOME` 或預設位置），但你的個別專案不需要 pipeline 的副本，只要這兩個 skill 即可。

---

## 安裝（兩種選一）

### 方式 A：複製到「你的專案」.claude/skills/（專案級）

只在這個專案內可用：

```bash
cd /path/to/your-project
mkdir -p .claude/skills

# 從 GitHub release 下載並解壓
curl -L https://github.com/jwu0330/automated-testing-pipeline/releases/latest/download/skills.tar.gz \
  | tar -xz -C .claude/skills
```

或 git clone 後手動複製：

```bash
git clone --depth 1 git@github.com:jwu0330/automated-testing-pipeline.git /tmp/atp
cp -r /tmp/atp/skills/pipeline-init /tmp/atp/skills/pipeline-run \
      /path/to/your-project/.claude/skills/
rm -rf /tmp/atp
```

### 方式 B：複製到 `~/.claude/skills/`（使用者級，全電腦可用）

所有專案都能呼叫：

```bash
mkdir -p ~/.claude/skills
curl -L https://github.com/jwu0330/automated-testing-pipeline/releases/latest/download/skills.tar.gz \
  | tar -xz -C ~/.claude/skills
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

## 兩個 Skill 的分工

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
                               摘要 reports/<name>/report.md
                               （不改設定、不註冊）
```

設計原則：**init 改設定，run 不改設定**。職責分離；同一動作不要兩個 skill 都做。

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
