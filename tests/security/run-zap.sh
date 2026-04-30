#!/bin/sh
# run-zap.sh - OWASP ZAP baseline wrapper.
# Captured-state replay is intentionally unsupported; scans run anonymously.
set -e

if [ -z "${TARGET_URL:-}" ]; then
  echo "TARGET_URL is required" >&2
  exit 2
fi

exec zap-baseline.py -t "$TARGET_URL" -r zap-report.html -J zap-report.json -l WARN