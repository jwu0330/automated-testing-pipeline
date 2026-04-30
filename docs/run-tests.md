# Operator Manual

## Requirements

- Docker and Docker Compose v2
- bash
- yq
- node

On Windows, run the scripts from WSL or use the Web UI, which calls WSL for the shell-based pipeline.

## Register A Project

```bash
mkdir -p /path/to/project/.testing
cp tests/scripts/testing-yml-template.yml /path/to/project/.testing/testing.yml
bash tests/scripts/register-project.sh your-project /path/to/project
```

Edit `.testing/testing.yml` for `project.target_url`, `project.local_path`, and tool-specific options.

## Run Scopes

```bash
bash tests/scripts/run-project.sh your-project all
bash tests/scripts/run-project.sh your-project ssl,e2e,lighthouse
bash tests/scripts/run-project.sh your-project REMOTE_ONLY
bash tests/scripts/run-project.sh your-project LOCAL_ONLY
```

Scopes:

| scope | tool | purpose |
|---|---|---|
| `ssl` | testssl.sh | SSL/TLS checks |
| `security` | OWASP ZAP | baseline web security scan |
| `nuclei` | Nuclei | template-based vulnerability scan |
| `stress` | k6 | load test |
| `lighthouse` | Lighthouse | performance/accessibility/best-practices/SEO |
| `links` | Lychee | broken link check |
| `static` | PHPStan | PHP static analysis |
| `trivy` | Trivy fs | dependency, secret, and misconfiguration scan |
| `e2e` | Playwright | browser flow tests and crawl checks |
| `api-test` | Newman | Postman/OpenAPI API tests |
| `monkey` | Gremlins.js | random UI interaction smoke test |
| `summary` | summarize.js | final report generation |

Presets:

- `ALL`: all supported scopes plus summary.
- `REMOTE_ONLY`: URL-based scopes.
- `LOCAL_ONLY`: source-code scopes.

## Authentication

Login is form-based only. Put credentials in `<project>/.testing/.env`:

```bash
LOGIN_REQUIRED=true
TARGET_UI_URL=https://example.com/login
ADMIN_USERNAME=admin001
ADMIN_PASSWORD=@admin001
```

The pipeline does not capture or replay captured browser state. E2E login attempts submit the configured credentials through the target UI.

## Web UI

```bash
node ui/server.js
```

Open `http://localhost:8080`, fill in the target URL, login credentials, optional email, selected scopes, and optional OpenAPI file.

## Reports

Main outputs:

```text
<project>/.testing/reports/report.md
<project>/.testing/reports/report.json
<project>/.testing/reports/raw/
```

The Web UI also packages reports as `reports.tgz` for download.