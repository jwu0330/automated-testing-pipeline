---
name: pipeline-init
description: |
  Initialize the current project to use the automated-testing-pipeline. Auto-detects OpenAPI specs anywhere in the project, creates `.testing/` with `testing.yml` filled from project context, wires `tests.api-test.openapi` to the detected spec, generates `.env.example`, and registers the project with the pipeline. Does NOT run any tests — that's `/pipeline-run`'s job.

  TRIGGER when: user types `/pipeline-init`, says "initialize automated-testing-pipeline for this project", "set up the testing pipeline kit here", "wire up my OpenAPI to the pipeline", or asks "what do I need to do before I can run the testing pipeline?".

  SKIP for: actually running tests (use `/pipeline-run`), debugging existing reports (point at `<pipeline>/reports/<name>/report.md`), or pipeline-internal questions (point at QUICKSTART.md).
---

# Pipeline Init Skill

You are setting up the **current working directory's project** to use a separately-installed `automated-testing-pipeline`. The pipeline lives once on this machine; this project just needs a `.testing/` kit pointing at it.

**You do not run tests in this skill.** Initialization only.

## Step 0 — Detect execution environment (CRITICAL)

The pipeline runs **inside WSL+Docker** on Windows. `yq` / `docker` / `node` only need to exist in WSL — **not** in your current shell. So if Claude Code was launched from a Windows-native bash (git bash / Cygwin), don't check or run those tools locally; route everything through WSL.

```bash
# Detect environment
if [ -f /proc/version ] && grep -qi microsoft /proc/version; then
  ENV=wsl                     # already inside WSL — run commands directly
elif command -v wsl.exe >/dev/null 2>&1; then
  ENV=win-with-wsl            # Windows-native bash with WSL available
elif command -v docker >/dev/null 2>&1; then
  ENV=native                  # plain Linux/Mac
else
  ENV=unknown
fi
echo "ENV=$ENV"
```

Define a helper for invoking pipeline commands. **Use this for every command that touches the pipeline (yq, register-project.sh, run-project.sh, docker, file checks under `/mnt/...`).**

- `ENV=wsl` or `ENV=native` → run as `bash -c '<cmd>'`
- `ENV=win-with-wsl` → run as `wsl.exe bash -c '<cmd>'`

**Path translation rules (use WSL-style `/mnt/...` paths in `testing.yml` and registry):**

| Input | Output (store this) |
|-------|---------------------|
| `/e/foo/bar` (git bash) | `/mnt/e/foo/bar` |
| `E:\foo\bar` | `/mnt/e/foo/bar` |
| `/mnt/e/foo` | `/mnt/e/foo` (unchanged) |
| `/home/...` (already in WSL) | unchanged |

When `pwd` returns `/e/...`, translate before storing as `local_path`. Same for the pipeline path.

> **Why this matters**: Docker mounts in WSL only see `/mnt/e/...`. Writing `/e/cwe網站/...` to the registry produces a path that won't mount when `run-project.sh` runs in WSL.

## Step 1 — Locate the pipeline

Find the pipeline in this priority order:

1. `$PIPELINE_HOME` env var (translate to `/mnt/...` if it's a `/e/...` path)
2. `.testing/testing.yml` → `pipeline.home` field (if `.testing/` already exists)
3. Default: `/mnt/e/Code/github/automated-testing-pipeline`
4. Ask the user (single question, give them the default to accept)

Verify **via the chosen env** (don't `test -f` locally if `ENV=win-with-wsl`):

```bash
# ENV=wsl / native:
test -f "$PIPELINE_HOME/scripts/run-project.sh" && echo ok
# ENV=win-with-wsl:
wsl.exe bash -c "test -f '$PIPELINE_HOME/scripts/run-project.sh' && echo ok"
```

If the pipeline isn't there, stop and tell the user how to get it (`git clone git@github.com:jwu0330/automated-testing-pipeline.git` **inside WSL**, into a path under `/mnt/e/` or `~/`). **Don't clone for them.**

## Step 2 — Verify prerequisites

**The pipeline only requires Docker on the host.** `yq` is auto-downloaded into `<pipeline>/bin/yq` on first script invocation; `node` falls back to a Docker image if missing. So check only Docker:

```bash
# ENV=wsl / native:
docker --version; docker compose version

# ENV=win-with-wsl:
wsl.exe bash -c 'docker --version; docker compose version'
```

If Docker is missing in WSL, surface the install link (<https://docs.docker.com/engine/install/>) and stop. Don't install for the user.

## Step 3 — Gather project context

In the **current working directory** (the user's target project, not the pipeline), determine:

| Field | How to determine |
|-------|------------------|
| `name` | Folder basename, lowercased, non-alphanum→`_`. Show user, let them override. |
| `target_url` | Ask the user. No good default. |
| `local_path` | `pwd` then **translate to `/mnt/...` per Step 0 rules** before storing. |
| `php_version` | If `composer.json` exists, read `require.php`; else `"8.1"`. |

## Step 4 — Auto-detect OpenAPI spec

Search the project for OpenAPI files. Use Glob with these patterns (first match wins):

1. `.testing/api/openapi.{yaml,yml,json}`  ← canonical location
2. `openapi.{yaml,yml,json}` at project root
3. `swagger.{yaml,yml,json}` at project root
4. `docs/openapi.{yaml,yml,json}` / `docs/swagger.{yaml,yml,json}`
5. `api/openapi.{yaml,yml,json}` / `api-spec.{yaml,yml,json}`
6. `**/openapi.{yaml,yml,json}` (broad fallback, exclude `node_modules`, `vendor`, `.git`)

If you find one:
- Verify it's actually an OpenAPI 3.x spec by reading the first ~10 lines and checking for `openapi: 3.` or `"openapi": "3.` (or `swagger: "2.0"` for legacy).
- Note the **path relative to project root**.

If nothing found, that's fine — the project may not have an API. Tell the user; offer two options:
- (a) Drop a spec at `.testing/api/openapi.yaml` later and rerun init
- (b) Continue without API tests (pipeline will skip silently)

## Step 5 — Create `.testing/` kit

If `.testing/` doesn't exist, create the minimum needed structure (do NOT copy from the pipeline; this skill is meant to work standalone):

```
<project>/.testing/
├── testing.yml      # generated from your inputs
├── .env.example     # generated; tells next person what to fill
├── .gitignore       # excludes .env
└── api/             # only if OpenAPI was detected
```

Generate **`.testing/testing.yml`** with the **Write** tool:

```yaml
schema_version: 2

# Pipeline location (override $PIPELINE_HOME if set; auto-found by link.sh otherwise)
# pipeline:
#   home: /absolute/path/to/automated-testing-pipeline

project:
  name: <gathered>
  target_url: <gathered>
  local_path: <gathered>
  php_version: "<gathered>"

tests:
  # Auto-detected; remove this block to disable api-test
  api-test:
    openapi: <relative/or/absolute path>   # only emit this line if OpenAPI was detected
```

If no OpenAPI was found, omit the `tests:` block entirely (the pipeline will auto-skip api-test).

Generate **`.testing/.env.example`**:

```bash
# .testing/.env (copy this file to .env and fill in; .env is gitignored)

# ── API/Auth multi-identity (only needed if you have api-test) ─────────────
# admin = role with full access; user1..user5 = additional roles to validate
# isolation. Each identity that has both USERNAME+PASSWORD will run one full
# collection sweep, producing newman-junit-<id>.xml.
ADMIN_USERNAME=
ADMIN_PASSWORD=

USER1_USERNAME=
USER1_PASSWORD=
USER1_LABEL=

# USER2_..USER5_ same pattern; leave blank to skip that identity

# ── E2E login (Playwright) ────────────────────────────────────────────────
E2E_USERNAME=
E2E_PASSWORD=
```

Generate **`.testing/.gitignore`**:

```
# 測試敏感值
.env

# 測試結果（pipeline 寫進這裡，每次執行覆蓋）
reports/

# 暫存產物
ephemeral/
```

If OpenAPI was detected, ensure `.testing/api/` exists (just `mkdir`; don't move user files into it — the testing.yml `openapi:` field already points at the original location).

## Step 6 — Register the project

Use the env-aware helper from Step 0. **Always pass the WSL-style `/mnt/...` path**, not the git-bash `/e/...` form:

```bash
# ENV=wsl / native:
bash "$PIPELINE_HOME/scripts/register-project.sh" "<name>" "<wsl-path>"

# ENV=win-with-wsl:
wsl.exe bash -c "bash '$PIPELINE_HOME/scripts/register-project.sh' '<name>' '<wsl-path>'"
```

Verify (same env-aware pattern):

```bash
# ENV=wsl / native:
yq ".projects.<name>" "$PIPELINE_HOME/projects.registry.yml"

# ENV=win-with-wsl:
wsl.exe bash -c "yq '.projects.<name>' '$PIPELINE_HOME/projects.registry.yml'"
```

If `ENV=win-with-wsl` and `wsl.exe` isn't found, **don't fall back to local yq** — instead skip register and tell the user exactly how to install WSL (`wsl --install` from PowerShell as admin) or run register manually from a WSL terminal.

## Step 7 — Final report

Give the user a tight summary in this exact shape:

```
✅ Initialized: <project-name>
   Pipeline:    <pipeline path>
   target_url:  <url>
   local_path:  <abs path>

📋 API testing
   <one of:>
   ✅ OpenAPI detected → <relative path> (will be auto-converted to Postman collection)
   ⚠️  No OpenAPI found — api-test will be skipped (drop a spec at .testing/api/openapi.yaml to enable)
   ✅ Existing Postman collection at .testing/api/collections/

🔐 Credentials needed before first run
   - Edit .testing/.env (copy from .env.example)
   - At minimum, fill ADMIN_USERNAME / ADMIN_PASSWORD if you want api-test to validate auth

🚀 Next: run /pipeline-run to execute tests
```

## Boundaries

- **Don't run any test scope.** Init only. Tell the user `/pipeline-run` is next.
- **Don't move or copy the user's OpenAPI file.** Just point `testing.yml` at where it is.
- **Don't fill `.env` secret values.** Only generate `.env.example` with empty values.
- **Don't push to git.** The user commits when ready.
- **Don't modify the pipeline's own files** — only this project's `.testing/` and the pipeline's `projects.registry.yml`.
- **Don't clone the pipeline.** If it's missing, tell the user how.
- If `.testing/testing.yml` already exists, **read it first** and ask before overwriting; offer a non-destructive merge (only fill empty required fields, don't clobber).
