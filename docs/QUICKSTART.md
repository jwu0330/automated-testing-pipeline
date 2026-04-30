# Quickstart

## 1. Prepare Tools

Install Docker, Docker Compose v2, bash, yq, and node.

## 2. Register A Local Project

```bash
mkdir -p /path/to/project/.testing
cp tests/scripts/testing-yml-template.yml /path/to/project/.testing/testing.yml
bash tests/scripts/register-project.sh demo /path/to/project
```

Edit `/path/to/project/.testing/testing.yml` and set the target URL.

## 3. Add Login Credentials When Needed

```bash
cat > /path/to/project/.testing/.env <<'EOF'
LOGIN_REQUIRED=true
TARGET_UI_URL=https://example.com/login
ADMIN_USERNAME=admin001
ADMIN_PASSWORD=@admin001
EOF
```

Login is performed through the form. Captured browser-state replay is not supported.

## 4. Run

```bash
bash tests/scripts/run-project.sh demo all
bash tests/scripts/run-project.sh demo ssl,e2e,lighthouse
```

## 5. Use The Web UI

```bash
node ui/server.js
```

Open `http://localhost:8080` and submit a job from the form.

## 6. Read Reports

```text
/path/to/project/.testing/reports/report.md
/path/to/project/.testing/reports/report.json
/path/to/project/.testing/reports/raw/
```