# Automated Testing Pipeline

A Docker-based testing pipeline for web targets. It can run SSL/TLS checks, ZAP baseline scans, Nuclei templates, k6 load tests, Lighthouse, Lychee link checks, PHPStan, Trivy, Playwright E2E, Monkey tests, Newman API tests, and a summary report.

## Current Entry Points

### Web UI

```bash
node ui/server.js
# open http://localhost:8080
```

The UI creates a temporary project, writes `.testing/testing.yml` and `.testing/.env`, runs the selected scopes, streams logs, and packages reports for download.

Login is supported through form credentials only. The pipeline does not capture, store, mount, or replay captured browser state.

### CLI

```bash
bash tests/scripts/register-project.sh <name> <absolute-project-path>
bash tests/scripts/run-project.sh <name> all
bash tests/scripts/run-project.sh <name> ssl,e2e,lighthouse
```

Available scopes:

`all | ssl | security | stress | static | e2e | api-test | nuclei | lighthouse | monkey | trivy | links | summary`

## Repository Layout

```text
Dockerfile
docker-compose.yml
projects.registry.example.yml
start.bat
ui/                         Web UI server and static assets
tests/scripts/              orchestration, registration, reporting
tests/ssl/                  testssl.sh wrapper
tests/security/             OWASP ZAP wrapper
tests/nuclei/               Nuclei wrapper
tests/stress/               k6 load test
tests/lighthouse/           Lighthouse runner
tests/links/                Lychee runner
tests/static/               PHPStan config
tests/trivy/                Trivy docs/config
tests/api/                  Newman/Postman support
tests/e2e/                  Playwright E2E tests
tests/monkey/               Gremlins/Playwright monkey tests
docs/                       operator docs
```

## Reports

Reports are written to `<project>/.testing/reports/` for registered local projects. URL-only UI jobs use `.tmp-reports/<name>/` inside this repository.

## Docs

- [Quickstart](./docs/QUICKSTART.md)
- [Operator manual](./docs/run-tests.md)
- [Project convention](./docs/project-convention.md)
- [Setup](./docs/setup.md)