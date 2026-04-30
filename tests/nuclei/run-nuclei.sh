#!/bin/sh
# run-nuclei.sh - Nuclei scanner wrapper.
# Captured-state replay is intentionally unsupported; scans run anonymously.
set -e

if [ -z "${TARGET_URL:-}" ]; then
  echo "TARGET_URL is required" >&2
  exit 2
fi

nuclei \
  -target "$TARGET_URL" \
  -jsonl-export /reports/nuclei.jsonl \
  -severity "${NUCLEI_SEVERITY:-critical,high,medium}" \
  -rate-limit "${NUCLEI_RATE_LIMIT:-50}" \
  -stats-interval 10 \
  -no-color \
  -silent \
  || echo "nuclei exit $?"