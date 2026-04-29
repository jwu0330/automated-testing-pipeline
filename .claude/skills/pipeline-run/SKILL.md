---
name: pipeline-run
description: |
  Execute automated-testing-pipeline tests for the current project. Reads the project's `.testing/testing.yml`, locates the pipeline, dispatches the requested scope (default: a safe smoke set, NOT the full destructive sweep), surfaces failures from the report, and prints the report path. Assumes `/pipeline-init` has already been run; if not, refuses and points there.

  TRIGGER when: user types `/pipeline-run`, says "run the pipeline", "test this project with the pipeline", "run api-test", "kick off SSL/security/lighthouse for this project".

  SKIP for: initial setup (use `/pipeline-init`), reading existing reports (just `cat <pipeline>/reports/<name>/report.md`), or pipeline-internal questions (point at QUICKSTART.md).
---

# Pipeline Run Skill

You execute tests against the **current project** using a separately-installed `automated-testing-pipeline`. This skill assumes `/pipeline-init` has been run successfully.

## Step 1 — Sanity check

```bash
test -f .testing/testing.yml && echo ok || echo "NOT INITIALIZED"
```

If `.testing/testing.yml` doesn't exist, **stop**. Tell the user to run `/pipeline-init` first.

## Step 2 — Locate the pipeline

Same priority as `/pipeline-init`:

1. `$PIPELINE_HOME`
2. `.testing/testing.yml` → `pipeline.home`
3. Default: `/mnt/e/Code/github/automated-testing-pipeline`
4. Ask once if all the above fail.

Verify:

```bash
test -f "$PIPELINE_HOME/scripts/run-project.sh" && echo ok
```

## Step 3 — Verify project is registered

```bash
NAME=$(yq -r .project.name .testing/testing.yml)
yq -r ".projects.${NAME}.path // \"\"" "$PIPELINE_HOME/projects.registry.yml"
```

If empty, register on the fly:

```bash
bash "$PIPELINE_HOME/scripts/register-project.sh" "$NAME" "$(pwd)"
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

```bash
cd "$PIPELINE_HOME"
bash scripts/run-project.sh "$NAME" "$SCOPE"
```

Stream output. Don't `&` / background — the user wants to see progress.

## Step 6 — Surface results

After it finishes, parse the report:

```bash
REPORT_DIR="$PIPELINE_HOME/reports/$NAME"
test -f "$REPORT_DIR/report.md" && head -60 "$REPORT_DIR/report.md"
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
