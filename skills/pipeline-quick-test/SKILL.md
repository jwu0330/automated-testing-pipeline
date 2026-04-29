---
name: pipeline-quick-test
description: |
  One-shot review of a remote site you don't own. User provides URL, project name, and credentials. The skill creates a self-contained folder at the pipeline root (`<pipeline>/<name>/`), runs the full test suite, and reports stay nested at `<pipeline>/<name>/.testing/reports/`. The folder is locally gitignored via `.git/info/exclude` (does NOT modify the committed `.gitignore`); user deletes manually when review is done.

  TRIGGER when: user types `/pipeline-quick-test`, says "quick review of <site>", "test this URL for me / for someone", "我要幫別人 review 這個站", "run the full suite on <name>".

  SKIP for: long-term projects with source code (use `/pipeline-init` + `/pipeline-run`), reading existing reports, debugging a previous review (just open the folder).
---

# Pipeline Quick Test Skill

A **one-shot** workflow for reviewing remote sites you don't own. No source code expected, no long-term setup. Inputs in, report out, manual cleanup.

**This skill does init + run in a single pass.** Don't split it.

## Step 0 — Detect execution environment (CRITICAL)

The pipeline runs **inside WSL+Docker** on Windows. Route every pipeline command through WSL if Claude Code launched from a Windows-native bash.

```bash
if [ -f /proc/version ] && grep -qi microsoft /proc/version; then
  ENV=wsl
elif command -v wsl.exe >/dev/null 2>&1; then
  ENV=win-with-wsl
elif command -v docker >/dev/null 2>&1; then
  ENV=native
else
  ENV=unknown
fi
```

Helper rule:
- `ENV=wsl` / `native` → run `bash -c '<cmd>'`
- `ENV=win-with-wsl` → run `wsl.exe bash -c '<cmd>'`

**All paths in `testing.yml` and `register-project.sh` calls use WSL-style `/mnt/...`.**

## Step 1 — Gather inputs

Ask the user. Single prompt, list everything you need:

| 必填 | 範例 |
|------|------|
| 網址 (target_url) | `https://xcity.example.com/` |
| 專案名稱 (name) | `xcity` — 英數底線；會用作資料夾名 |
| ADMIN_USERNAME | 留空跳過登入測試 |
| ADMIN_PASSWORD | 留空跳過登入測試 |

If the user gave inputs in their original message, parse them directly — don't re-ask.

## Step 2 — Locate the pipeline

Priority:

1. `$PIPELINE_HOME` env var (translate `/e/...` → `/mnt/e/...`)
2. Default: `/mnt/e/Code/github/automated-testing-pipeline`
3. Ask once if missing

Verify via env helper:

```bash
# ENV=win-with-wsl:
wsl.exe bash -c "test -f '$PIPELINE_HOME/scripts/run-project.sh' && echo ok"
```

## Step 3 — Create the review folder

Check it doesn't already exist (avoid clobbering a previous review):

```bash
# ENV=win-with-wsl:
wsl.exe bash -c "test -d '$PIPELINE_HOME/$NAME' && echo EXISTS || echo NEW"
```

If `EXISTS`, ask user: **overwrite (覆蓋上次 review)、 重新命名、 還是中止？** Wait for explicit answer.

Create the folder structure:

```bash
wsl.exe bash -c "mkdir -p '$PIPELINE_HOME/$NAME/.testing'"
```

Write `<pipeline>/<name>/.testing/testing.yml` (use the **Write** tool from Claude Code; the path on the Windows side is `\\wsl$\<distro>\mnt\e\code\github\automated-testing-pipeline\<name>\.testing\testing.yml` if you need direct file I/O, but it's simpler to write via WSL):

```bash
wsl.exe bash -c "cat > '$PIPELINE_HOME/$NAME/.testing/testing.yml' <<EOF
schema_version: 2
project:
  name: $NAME
  target_url: $TARGET_URL
  local_path: $PIPELINE_HOME/$NAME
  php_version: \"8.1\"
EOF"
```

> `local_path` 指向資料夾自己 — 觸發 LOCAL_MODE，讓報告寫進 `<pipeline>/<name>/.testing/reports/`。沒原始碼的關係，PHPStan / Trivy 會自動跳過。

Write `.env` with the credentials the user gave:

```bash
wsl.exe bash -c "cat > '$PIPELINE_HOME/$NAME/.testing/.env' <<EOF
ADMIN_USERNAME=$ADMIN_USERNAME
ADMIN_PASSWORD=$ADMIN_PASSWORD
EOF"
```

If user left credentials blank, write the file but with empty values (api-test will surface a warning).

## Step 4 — Locally gitignore the folder

The folder must **not** end up in version control. Add it to `.git/info/exclude` (per-clone, not committed) — **do NOT** modify the committed `.gitignore`:

```bash
wsl.exe bash -c "
  EXCLUDE='$PIPELINE_HOME/.git/info/exclude'
  grep -qxF '/$NAME/' \"\$EXCLUDE\" 2>/dev/null || echo '/$NAME/' >> \"\$EXCLUDE\"
"
```

## Step 5 — Register and run (full suite)

```bash
wsl.exe bash -c "
  bash '$PIPELINE_HOME/scripts/register-project.sh' '$NAME' '$PIPELINE_HOME/$NAME' && \
  bash '$PIPELINE_HOME/scripts/run-project.sh' '$NAME' all
"
```

**Stream the output** — quick-test reviews benefit from seeing progress (it's a 5-15 minute operation).

> **Default scope is `all`** for quick-test (review wants full coverage). Don't ask for scope; the user invoked this skill *because* they want everything. If `target_url` looks production-only (no staging/dev/localhost markers), pause and ask once before launching destructive scopes (k6 / ZAP / Nuclei) — but only when ambiguous.

## Step 6 — Surface results

After the run completes:

```bash
REPORT_DIR="$PIPELINE_HOME/$NAME/.testing/reports"

wsl.exe bash -c "test -f '$REPORT_DIR/report.md' && head -80 '$REPORT_DIR/report.md'"
```

In your reply:

1. **Scorecard** — paste the `①…⑪` block from the top of `report.md`
2. **Failures** — list specific failed tests from the detail sections, with file:line where applicable
3. **Warnings** — read `$REPORT_DIR/warnings.txt` if present (precheck skips)

End with the cleanup reminder:

```
📊 Full report:  <pipeline>/<name>/.testing/reports/report.md
📁 Raw outputs:  <pipeline>/<name>/.testing/reports/raw/

🧹 完成 review 後請手動清掉資料夾：
   wsl.exe bash -c "rm -rf '<pipeline>/<name>'"
   （folder 已在 .git/info/exclude，不會被 commit；rm 後從 registry 移除：
    yq -i 'del(.projects.<name>)' <pipeline>/projects.registry.yml）
```

## Boundaries

- **Don't push to git.** Don't `git add .`. Don't commit.
- **Don't modify the committed `.gitignore`.** Use `.git/info/exclude` only.
- **Don't auto-delete the folder.** User cleans up manually after review.
- **Don't fill `.env` beyond what the user provided.** Empty values stay empty.
- **Don't run if the folder already exists** without explicit confirmation (overwrite/rename/abort).
- **Don't split this into init + run.** Quick-test is one-shot by design.
- If the run fails partway, surface the error and stop. Don't retry. The folder + registry entry stay so user can re-run manually with `bash run-project.sh <name> <scope>`.
