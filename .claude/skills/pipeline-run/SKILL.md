---
name: pipeline-run
description: |
  Execute automated-testing-pipeline tests for the current project. Reads the project's `.testing/testing.yml`, locates the pipeline, dispatches the requested scope (default: a safe smoke set, NOT the full destructive sweep), surfaces failures from the report, and prints the report path. Assumes `/pipeline-init` has already been run; if not, refuses and points there.

  TRIGGER when: user types `/pipeline-run`, says "run the pipeline", "test this project with the pipeline", "run api-test", "kick off SSL/security/lighthouse for this project".

  SKIP for: initial setup (use `/pipeline-init`), reading existing reports (just `cat <pipeline>/reports/<name>/report.md`), or pipeline-internal questions (point at QUICKSTART.md).
---

# Pipeline Run Skill

You execute tests against the **current project** using a separately-installed `automated-testing-pipeline`. This skill assumes `/pipeline-init` has been run successfully.

## Step 0 — Detect execution environment (CRITICAL)

The pipeline runs **inside WSL+Docker** on Windows. `yq` / `docker` / `node` only need to exist in WSL. If Claude Code launched from a Windows-native bash (git bash), route every pipeline command through WSL — don't check tools locally.

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

**Always use WSL-style `/mnt/...` paths** when invoking pipeline scripts (the registry stores them this way; Docker mounts only see this form).

## Step 1 — Sanity check

This one is local — `.testing/testing.yml` lives in the user's project, accessible from any shell:

```bash
test -f .testing/testing.yml && echo ok || echo "NOT INITIALIZED"
```

If `.testing/testing.yml` doesn't exist, **stop**. Tell the user to run `/pipeline-init` first.

## Step 2 — Locate the pipeline

Same priority as `/pipeline-init`:

1. `$PIPELINE_HOME` (translate `/e/...` → `/mnt/e/...`)
2. `.testing/testing.yml` → `pipeline.home`
3. Default: `/mnt/e/Code/github/automated-testing-pipeline`
4. Ask once if all the above fail.

Verify via the chosen env:

```bash
# ENV=wsl / native:
test -f "$PIPELINE_HOME/tests/scripts/run-project.sh" && echo ok
# ENV=win-with-wsl:
wsl.exe bash -c "test -f '$PIPELINE_HOME/tests/scripts/run-project.sh' && echo ok"
```

## Step 3 — Verify project is registered

Reading `testing.yml` is local (the file is in the project). Reading the registry (`projects.registry.yml` under the pipeline) goes through the env helper:

```bash
# Local: read project name from testing.yml — yq via env helper since yq lives in WSL
# ENV=wsl / native:
NAME=$(yq -r .project.name .testing/testing.yml)
REGISTERED=$(yq -r ".projects.${NAME}.path // \"\"" "$PIPELINE_HOME/projects.registry.yml")

# ENV=win-with-wsl:
NAME=$(wsl.exe bash -c "yq -r .project.name '$(pwd -W 2>/dev/null || pwd)/.testing/testing.yml'" | tr -d '\r')
REGISTERED=$(wsl.exe bash -c "yq -r '.projects.${NAME}.path // \"\"' '$PIPELINE_HOME/projects.registry.yml'" | tr -d '\r')
```

If empty, register on the fly (use `local_path` from `testing.yml`, which is already `/mnt/...`):

```bash
# ENV=wsl / native:
bash "$PIPELINE_HOME/tests/scripts/register-project.sh" "$NAME" "$LOCAL_PATH"

# ENV=win-with-wsl:
wsl.exe bash -c "bash '$PIPELINE_HOME/tests/scripts/register-project.sh' '$NAME' '$LOCAL_PATH'"
```

## Step 3.5 — Ask about Email (optional)

If the user didn't already say where to send the report, ask **once**:

> 跑完要把報告寄到哪個 Email？（直接按 Enter 跳過）

`$EMAIL` 留空就不寄；填了就在 Step 6 之後呼叫 `send-report-email.js`（與 Web UI 走同一份 backend，見 Step 7）。

## Step 4 — Decide scope

Ask the user what to run **only if they didn't say**. Defaults:

| User intent | Scope to use |
|-------------|-------------|
| Not specified, first time | **Smoke test**: `precheck,ssl` (≤30s, harmless) |
| "everything" / "full" / "all" | `all` — but **warn** this can be 10+ minutes and may hit the live site hard (k6, ZAP, Nuclei) |
| "API tests" | `api-test` |
| "security" | `ssl,security,nuclei,trivy` |
| "frontend" | `lighthouse,links,e2e,monkey` |
| Specific scope | Pass through verbatim |

Show the user what you're about to run **before** running it, especially for destructive scopes. If they say "go" / accept, proceed.

Valid scope tokens: `precheck`, `ssl`, `security`, `stress`, `static`, `e2e`, `api-test`, `auth-test`, `visual-test`, `browser-compat`, `nuclei`, `lighthouse`, `monkey`, `trivy`, `links`, `summary`. Presets: `all`, `remote-only`, `local-only`. Comma-separate multiples.

## Step 4.5 — Capture login session via real browser (only if needed)

**Skip this step entirely** unless 兩個條件**都**符合：

1. Scope 包含 `e2e`、`monkey`、或 `all`（其他 scope 不需要登入態）
2. 目標站需要 CAPTCHA / 2FA / SSO / 前端加密密碼，**或**使用者明確說「session 要自己抓」

如果只是普通帳號密碼登入，run-project.sh 已經會用 `.testing/.env` 裡的 `ADMIN_USERNAME/PASSWORD` 走表單登入——直接跳到 Step 5。

**為什麼是獨立步驟**：UI 路徑跟這個 CLI 走同一份模組（`tests/scripts/lib/session-capture.js`）；run-project.sh 自動偵測 `<project>/.testing/storage-state.json`，有檔就跳過表單登入。

```bash
# ⚠️ 必須在能顯示桌面 GUI 的 shell 跑——不要透過 wsl.exe（WSL 無 WSLg 會卡死）。
# Claude Code 從 Windows git bash 啟動就直接 node 即可。
# 從純 WSL 啟動的話，請先在 Windows 端開個 shell 跑這支，再回來繼續。

LOCAL_PATH=$(yq -r '.project.local_path // ""' .testing/testing.yml)
[ -z "$LOCAL_PATH" ] && LOCAL_PATH=$(pwd)

node "$PIPELINE_HOME/tests/scripts/capture-session.js" \
  --url "$(yq -r .project.target_url .testing/testing.yml)" \
  --output "$LOCAL_PATH/.testing/storage-state.json" \
  --timeout-min 5
```

> **路徑注意**：`--output` 給原生路徑（Git Bash `/e/...` 或 Windows `E:\...`）。如果 `LOCAL_PATH` 是 `/mnt/e/...`（WSL 形式），先換成 `/e/...` 再傳。

Exit codes:
- `0` → 進入 Step 5
- `2` 逾時 / `4` 沒登入 → 問使用者要不要重試這步
- `1` Playwright 沒裝 → `cd $PIPELINE_HOME/ui && npm install && npx playwright install chromium`

**重要**：把 `.testing/storage-state.json` 加到 user 的 `.gitignore`（`echo '.testing/storage-state.json' >> .gitignore`），它含登入 cookie，**絕不能** commit。如果 `.testing/` 整包已經 ignore 就免做。

## Step 5 — Run

Always invoke through the env helper (Docker is in WSL):

```bash
# ENV=wsl / native:
cd "$PIPELINE_HOME" && bash tests/scripts/run-project.sh "$NAME" "$SCOPE"

# ENV=win-with-wsl:
wsl.exe bash -c "cd '$PIPELINE_HOME' && bash tests/scripts/run-project.sh '$NAME' '$SCOPE'"
```

Stream output. Don't `&` / background — the user wants to see progress.

## Step 6 — Surface results

After it finishes, read the report. **v0.6+ stores reports inside the project**, not the pipeline:

- 有 `local_path` 的專案 → `<local_path>/.testing/reports/report.md`
- 無 `local_path`（純遠端測試） → `<pipeline>/.tmp-reports/<name>/report.md`

Resolve the right one from `testing.yml`:

```bash
LOCAL_PATH=$(yq -r '.project.local_path // ""' .testing/testing.yml)
if [ -n "$LOCAL_PATH" ]; then
    REPORT_DIR="$LOCAL_PATH/.testing/reports"
else
    REPORT_DIR="$PIPELINE_HOME/.tmp-reports/$NAME"
fi

# ENV=wsl / native:
test -f "$REPORT_DIR/report.md" && head -60 "$REPORT_DIR/report.md"

# ENV=win-with-wsl:
wsl.exe bash -c "test -f '$REPORT_DIR/report.md' && head -60 '$REPORT_DIR/report.md'"
```

Highlight in your reply:

- **Scorecard summary line** (the `①…⑪` block at the top of `report.md`)
- **Any `❌` / `parse-error` / failed counts** — surface specific failed test names from the detail sections, not just "X failures"
- **Warnings** — read `$REPORT_DIR/warnings.txt` if it exists; these are pre-flight skips that may be load-bearing (e.g. "api-test: no OpenAPI → skipped")
- **Trend arrows** — if `[↓-N 改善]` or `[↑+N 退步]` appear in the scorecard, mention them; that's progress relative to last run

End with:

```
📊 Full report: <REPORT_DIR>/report.md
📁 Raw outputs: <REPORT_DIR>/raw/
```

(`<REPORT_DIR>` is the path resolved above — typically `<your-project>/.testing/reports/`.)

If `report.json` shows `overallScore < 80` or has parse errors, end with a single sentence stating what to fix first.

## Step 7 — Email report (only if user gave Email in Step 3.5)

跟 Web UI 走同一份 backend（`tests/scripts/lib/mailer.js`）；CLI 在這：

```bash
# ENV=wsl / native:
node "$PIPELINE_HOME/tests/scripts/send-report-email.js" \
  --to "$EMAIL" \
  --report-dir "$REPORT_DIR" \
  --target "$(yq -r .project.target_url .testing/testing.yml)" \
  --scope "$SCOPE" \
  --exit-code "$RUN_EXIT_CODE" \
  --job-id "$NAME"

# ENV=win-with-wsl:
wsl.exe bash -c "node '$PIPELINE_HOME/tests/scripts/send-report-email.js' \
  --to '$EMAIL' \
  --report-dir '$REPORT_DIR' \
  --target '$TARGET_URL' \
  --scope '$SCOPE' \
  --exit-code '$RUN_EXIT_CODE' \
  --job-id '$NAME'"
```

CLI exit codes:
- `0` 成功 → `📧 已寄至 <email>`
- `2` SMTP 未設定（提示去 `<pipeline>/.env` 補 `SMTP_URL/USER/PASS`，**不要**重跑測試）
- `1` 失敗（`67`=密碼錯，`28`=網路擋 port，`6`=DNS）

`$EMAIL` 沒填就**整段跳過**，不要呼叫 CLI。

## Boundaries

- **Don't run if not initialized.** Refuse and point at `/pipeline-init`.
- **Default to a smoke test, not the full sweep.** Live sites get hammered by k6/ZAP/Nuclei. Make the user opt in.
- **Never auto-confirm `all` against production-looking URLs** (heuristic: if `target_url` doesn't contain `staging`/`dev`/`localhost`/`test`, ask once before running `all`).
- **Don't push to git.** Don't commit reports.
- **Don't modify `testing.yml` or `.env`.** That's `/pipeline-init`'s job.
- If the run fails, **don't retry automatically**. Surface the error, suggest the diagnostic command, and stop.
