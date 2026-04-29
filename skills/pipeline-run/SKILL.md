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
test -f "$PIPELINE_HOME/scripts/run-project.sh" && echo ok
# ENV=win-with-wsl:
wsl.exe bash -c "test -f '$PIPELINE_HOME/scripts/run-project.sh' && echo ok"
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
bash "$PIPELINE_HOME/scripts/register-project.sh" "$NAME" "$LOCAL_PATH"

# ENV=win-with-wsl:
wsl.exe bash -c "bash '$PIPELINE_HOME/scripts/register-project.sh' '$NAME' '$LOCAL_PATH'"
```

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

## Step 5 — Run

Always invoke through the env helper (Docker is in WSL):

```bash
# ENV=wsl / native:
cd "$PIPELINE_HOME" && bash scripts/run-project.sh "$NAME" "$SCOPE"

# ENV=win-with-wsl:
wsl.exe bash -c "cd '$PIPELINE_HOME' && bash scripts/run-project.sh '$NAME' '$SCOPE'"
```

Stream output. Don't `&` / background — the user wants to see progress.

## Step 6 — Surface results

After it finishes, read the report (via env helper since reports live under the WSL-side pipeline path):

```bash
REPORT_DIR="$PIPELINE_HOME/reports/$NAME"

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
📊 Full report: <pipeline>/reports/<name>/report.md
📁 Raw outputs: <pipeline>/reports/<name>/raw/
```

If `report.json` shows `overallScore < 80` or has parse errors, end with a single sentence stating what to fix first.

## Boundaries

- **Don't run if not initialized.** Refuse and point at `/pipeline-init`.
- **Default to a smoke test, not the full sweep.** Live sites get hammered by k6/ZAP/Nuclei. Make the user opt in.
- **Never auto-confirm `all` against production-looking URLs** (heuristic: if `target_url` doesn't contain `staging`/`dev`/`localhost`/`test`, ask once before running `all`).
- **Don't push to git.** Don't commit reports.
- **Don't modify `testing.yml` or `.env`.** That's `/pipeline-init`'s job.
- If the run fails, **don't retry automatically**. Surface the error, suggest the diagnostic command, and stop.
