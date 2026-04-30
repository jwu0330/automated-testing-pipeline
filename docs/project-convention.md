# Project Convention

Each tested project should contain a `.testing/` directory.

```text
.testing/
  testing.yml
  .env                  optional credentials and notification settings
  api/openapi.yaml      optional OpenAPI input
  api/collections/      optional Postman collections
  e2e/                  optional project-owned Playwright tests
  reports/              generated output
```

## testing.yml

```yaml
schema_version: 2
project:
  name: demo
  target_url: https://example.com
  local_path: /absolute/path/to/project
  php_version: "8.1"
tests: {}
```

## .env

`.env` is optional. Use it for login credentials, SMTP settings, or tool-specific secrets.

```bash
LOGIN_REQUIRED=true
TARGET_UI_URL=https://example.com/login
ADMIN_USERNAME=admin001
ADMIN_PASSWORD=@admin001
```

Login is form-based only. Do not add captured browser-state artifacts to projects.

## Reports

Reports are generated under `.testing/reports/` and ignored by git.