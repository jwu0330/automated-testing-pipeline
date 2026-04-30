#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════
// send-report-email.js — CLI wrapper around lib/mailer.js
//
// 給 Skill 用：跑完 run-project.sh 後，用同一份寄信邏輯把報告寄出去。
//
// 用法：
//   node tests/scripts/send-report-email.js \
//     --to you@example.com \
//     --report-dir /path/to/.testing/reports \
//     --target https://example.com \
//     [--scope all] [--exit-code 0] [--job-id xxx] [--archive /path/to/reports.tgz]
//
// 環境：
//   - 自動讀取 <pipeline-root>/.env（即本檔上面兩層的 .env）
//   - SMTP_URL / SMTP_USER / SMTP_PASS / SMTP_FROM 必須設好
//
// Exit codes：
//   0  寄送成功
//   1  寄送失敗（curl 非 0 或其他錯誤）
//   2  跳過（SMTP 未設定或無收件人）
//   3  參數錯誤
// ════════════════════════════════════════════════════════════════
const path = require('path');
const { loadDotenv, sendReportEmail } = require('./lib/mailer');

// pipeline root = tests/scripts/.. /..
const PIPELINE_ROOT = path.resolve(__dirname, '..', '..');
loadDotenv(PIPELINE_ROOT);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to')          out.to = argv[++i];
    else if (a === '--report-dir') out.reportDir = argv[++i];
    else if (a === '--target')     out.targetUrl = argv[++i];
    else if (a === '--scope')      out.scope = argv[++i];
    else if (a === '--exit-code')  out.exitCode = parseInt(argv[++i], 10);
    else if (a === '--job-id')     out.jobId = argv[++i];
    else if (a === '--archive')    out.archivePath = argv[++i];
    else if (a === '-h' || a === '--help') out.help = true;
    else { console.error(`unknown arg: ${a}`); process.exit(3); }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('Usage: node send-report-email.js --to <email> --report-dir <path> --target <url> [--scope <s>] [--exit-code <n>] [--job-id <id>] [--archive <path>]');
  process.exit(0);
}
if (!args.to)         { console.error('missing --to'); process.exit(3); }
if (!args.reportDir)  { console.error('missing --report-dir'); process.exit(3); }

(async () => {
  const r = await sendReportEmail(args);
  if (r.skipped) {
    console.error(`[mail] skipped: ${r.reason}`);
    process.exit(2);
  }
  if (r.ok) {
    console.log(`[mail] sent → ${args.to}`);
    process.exit(0);
  }
  console.error(`[mail] failed (curl=${r.code ?? '?'}): ${r.error || ''}`);
  process.exit(1);
})();
