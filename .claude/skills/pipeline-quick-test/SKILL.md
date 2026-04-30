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

| 欄位 | 必填 | 範例 |
|------|------|------|
| 網址 (target_url) | ✅ | `https://xcity.example.com/` |
| 專案名稱 (name) | ✅ | `xcity` — 英數底線；會用作資料夾名 |
| ADMIN_USERNAME | 選填 | 留空跳過登入測試 |
| ADMIN_PASSWORD | 選填 | 留空跳過登入測試 |
| Email | 選填 | 填了會在跑完後把報告（含 `reports.tgz` 附件）寄到這個信箱 |

If the user gave inputs in their original message, parse them directly — don't re-ask.

> Email 走的是 `<pipeline>/.env` 裡的 `SMTP_URL/USER/PASS/FROM`（與 Web UI 共用同一份設定）。沒設定的話 CLI 會回 exit=2 並印 `email skipped: SMTP_URL/USER/PASS 未設定`，**不影響測試本身的成敗**。

## Step 2 — Locate the pipeline

Priority:

1. `$PIPELINE_HOME` env var (translate `/e/...` → `/mnt/e/...`)
2. Default: `/mnt/e/Code/github/automated-testing-pipeline`
3. Ask once if missing

Verify via env helper:

```bash
# ENV=win-with-wsl:
wsl.exe bash -c "test -f '$PIPELINE_HOME/tests/scripts/run-project.sh' && echo ok"
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

## Step 3.5 — Capture login session via real browser (only if needed)

**When this applies**: target site has CAPTCHA / 2FA / SSO / 前端密碼加密，純表單登入會失敗。If user只給 ADMIN_USERNAME/PASSWORD 而站台沒這些保護，跳過本步——`run_e2e` 會自己用表單登入。

**Trigger**: 使用者主動說「需要手動登入」/「有 CAPTCHA」/「2FA」/「SSO」/「Google 登入」/「session key 要自己抓」，或你看到登入測試在前一輪 fail 了。

**為什麼有獨立步驟**：UI 路徑（`/api/prelogin-browser`）跟這個 CLI 走 **同一份共用模組** `tests/scripts/lib/session-capture.js`，行為一致；run-project.sh 自動偵測 `<project>/.testing/storage-state.json`，有 session 檔就跳過表單登入。

```bash
# ⚠️ 這支 CLI 必須能顯示桌面 GUI——不能走 wsl.exe（WSL 無 WSLg 時會卡死）。
# Claude Code 應該已經跑在 Windows-native shell（git bash / cmd / pwsh），
# 直接呼叫 node 即可（path 用 Git Bash 風格 /e/... 或 Windows 風格 E:\...）。

node "$PIPELINE_HOME/tests/scripts/capture-session.js" \
  --url "$TARGET_URL" \
  --output "$PIPELINE_HOME/$NAME/.testing/storage-state.json" \
  --timeout-min 5
```

行為：
- 跳出 Playwright 控制的瀏覽器視窗
- 使用者手動登入（解 CAPTCHA / 輸 OTP / 走 SSO 都可以）
- 登入完成後**手動關閉視窗**
- session（cookies + localStorage）寫到 `--output`，e2e/monkey 自動接手

Exit codes:
- `0` 成功 → 繼續 Step 4
- `2` 超過 5 分鐘逾時 → 問使用者要不要重試
- `4` 視窗關了但沒擷到 cookie（沒實際登入） → 提示使用者重新跑這步並真的登入
- `1` Playwright 沒裝 → 在 `<pipeline>/ui` 跑 `npm install && npx playwright install chromium`，然後重試

**不要強制每次都跑這步**——只在使用者明確需要時才執行。多數狀況下 ADMIN_USERNAME/PASSWORD 表單登入就夠了。

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
  bash '$PIPELINE_HOME/tests/scripts/register-project.sh' '$NAME' '$PIPELINE_HOME/$NAME' && \
  bash '$PIPELINE_HOME/tests/scripts/run-project.sh' '$NAME' all
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

### Step 6.1 — Email report (only if user gave Email in Step 1)

Same backend as the Web UI — both go through `tests/scripts/lib/mailer.js`. Just call the CLI wrapper:

```bash
# ENV=wsl / native:
node "$PIPELINE_HOME/tests/scripts/send-report-email.js" \
  --to "$EMAIL" \
  --report-dir "$REPORT_DIR" \
  --target "$TARGET_URL" \
  --scope all \
  --exit-code "$RUN_EXIT_CODE" \
  --job-id "$NAME"

# ENV=win-with-wsl:
wsl.exe bash -c "node '$PIPELINE_HOME/tests/scripts/send-report-email.js' \
  --to '$EMAIL' \
  --report-dir '$REPORT_DIR' \
  --target '$TARGET_URL' \
  --scope all \
  --exit-code '$RUN_EXIT_CODE' \
  --job-id '$NAME'"
```

CLI exit codes:
- `0` 寄送成功 → 在回覆裡告訴使用者 `📧 已寄至 <email>`
- `2` 跳過（SMTP 未設定）→ 提示使用者去 `<pipeline>/.env` 補 `SMTP_URL/USER/PASS`，但**不要**重跑測試
- `1` 失敗 → 把 stderr 裡的 `[mail] failed (curl=XX): ...` 原話貼給使用者，附常見錯誤對照（`67`=密碼錯，`28`=網路擋 port）

`$EMAIL` 沒填就**整段跳過 Step 6.1**，不要呼叫 CLI。

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
