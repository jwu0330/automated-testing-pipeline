---
name: pipeline-onboard
description: |
  Onboard a target project to this automated-testing-pipeline. Verifies prerequisites (Docker, yq, node), creates/validates the project's `.testing/` kit, detects OpenAPI specs, registers the project, and runs a smoke test (precheck + ssl) so the user knows the wiring works before kicking off a full run.

  TRIGGER when: user types `/pipeline-onboard`, says "onboard <project> to the testing pipeline", "set up automated-testing-pipeline for <path>", "validate my .testing/ kit", or asks "is my project ready for the pipeline?".

  SKIP for: questions about how the pipeline works internally (point them at docs/QUICKSTART.md), debugging existing reports (use `bash scripts/run-project.sh <name> summary` directly), or n8n GUI-specific workflows (point them at docs/run-tests.md §7).
---

# Pipeline Onboarding Skill

You are helping a user wire up their project to the `automated-testing-pipeline` repo. The user has already cloned the pipeline and either has, or will create, a target project they want to test. Your job is to verify the setup is correct, then run a small smoke test, **without** kicking off the full 11-test suite (that takes 10+ minutes and can hammer the target site).

## Inputs you need from the user

Ask only what you can't infer:

1. **Pipeline location** — usually `/mnt/e/Code/github/automated-testing-pipeline` on this machine; check `pwd` first if you're already there.
2. **Target project absolute path** — the project they want tested (e.g., `/mnt/e/code/my-site`).
3. **Target URL** — the site to point remote tests at.
4. **Project name** — short, `[a-z0-9_]+`. Default: derive from the project folder name.

If they don't provide these and you can't reasonably infer them, ask **once** in a single message — don't ping-pong.

## Steps

### 1. Verify prerequisites (parallel checks)

Run all in one Bash batch:

```bash
docker --version
docker compose version
yq --version
node --version
bash --version
```

If anything is missing, stop and tell the user exactly which tool to install. Don't try to install for them.

### 2. Verify pipeline is healthy

```bash
cd <pipeline>
test -f scripts/run-project.sh && echo "pipeline ok"
test -f projects.registry.yml || cp projects.registry.example.yml projects.registry.yml
docker compose ps n8n   # optional; n8n is not required for CLI use
```

### 3. Check / create the target project's `.testing/` kit

```bash
ls -la <project>/.testing/ 2>&1 | head
```

- If `.testing/` doesn't exist → copy the kit: `cp -r <pipeline>/.testing <project>/`
- If it exists but `testing.yml` is missing → copy just the template
- If `testing.yml` exists → read its 4 required fields and report what's filled

Use the **Edit** tool (not `sed`) to fill the 4 required fields in `<project>/.testing/testing.yml`:

```yaml
schema_version: 2
project:
  name: <name>
  target_url: <url>
  local_path: <project-absolute-path>   # or "" for URL-only mode
  php_version: "8.1"                    # leave default for non-PHP
```

### 4. Detect API testing mode

Check in this order and tell the user which path will be used:

1. **Existing collection** — `ls <project>/.testing/api/collections/*.postman_collection.json 2>/dev/null`
2. **OpenAPI in testing.yml** — `yq -r '.tests.api-test.openapi // ""' <project>/.testing/testing.yml`
3. **OpenAPI auto-detect** — `<project>/.testing/api/openapi.{yaml,yml,json}`
4. **None** — api-test will be skipped automatically; that's fine for content-only sites

Don't create OpenAPI files for them. If they don't have one and want API testing, point them at [`docs/QUICKSTART.md` §3](../../docs/QUICKSTART.md#3可選api-測試丟-openapi-路徑就好) and stop.

### 5. Register the project

```bash
cd <pipeline>
bash scripts/register-project.sh <name> <project-absolute-path>
yq '.projects' projects.registry.yml   # confirm it landed
```

### 6. Smoke test (precheck + ssl only — under 30 seconds)

```bash
cd <pipeline>
bash scripts/run-project.sh <name> precheck,ssl
```

Then check the output:
- HTTP code on precheck (200/301/302 are healthy)
- `reports/<name>/raw/testssl-*.json` exists
- `reports/<name>/warnings.txt` if present — read it and surface anything actionable

### 7. Report back

Give the user a tight summary:
- ✅ what's wired up
- ⚠️ what's missing or skipped (with exact path / config to fix)
- 🚀 the one command to run a full suite when they're ready: `bash scripts/run-project.sh <name>`

## Boundaries

- **Don't run the full test suite.** That's a 10+ minute, potentially destructive run against the target site. The user should kick it off explicitly.
- **Don't push to git.** Onboarding changes the user's project files; let the user commit when they're ready.
- **Don't fill `.env` for them.** Print the exact lines they need to add to `<project>/.testing/.env` (e.g., `ADMIN_USERNAME=...`) but never type secret values yourself.
- **Don't modify the pipeline's own files** — your scope is the user's target project's `.testing/` and the pipeline's `projects.registry.yml`.
- **Don't try to install Docker / yq / node.** If a prerequisite is missing, surface the exact install command for the user to run.

## Quick reference

- Full walkthrough: `docs/QUICKSTART.md`
- Operator manual: `docs/run-tests.md`
- Convention spec: `docs/project-convention.md`
- Kit README: `.testing/README.md`
