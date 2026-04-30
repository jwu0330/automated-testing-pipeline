#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════
// capture-session.js — CLI wrapper around lib/session-capture.js
//
// 給 Skill 用：跳出 Playwright 視窗讓使用者手動登入（能處理 CAPTCHA / 2FA / SSO），
// 把擷取到的 storageState 寫到指定路徑（通常是 <project>/.testing/storage-state.json）。
//
// run-project.sh 會自動偵測 .testing/storage-state.json，
// 自動 mount + 設 STORAGE_STATE_PATH，e2e / monkey 就會跳過表單登入。
//
// 用法：
//   node tests/scripts/capture-session.js \
//     --url https://example.com/login \
//     --output /abs/path/to/.testing/storage-state.json \
//     [--timeout-min 5] [--ui-cwd /abs/path/to/ui]
//
// 重要：必須在「能顯示桌面 GUI 的 shell」執行 — 在 Windows 從 Git Bash / cmd / PowerShell
// 直接呼叫沒問題；從純 WSL（無 WSLg）會卡死，需從 Windows 端啟動。
//
// Exit codes:
//   0  session 擷取成功，已寫入 outputPath
//   1  失敗（Playwright 未裝 / 啟動失敗 / 讀檔失敗）
//   2  逾時（使用者沒在時限內關視窗）
//   3  參數錯誤
//   4  視窗關閉但沒擷取到 cookie（使用者沒實際登入）
// ════════════════════════════════════════════════════════════════
const path = require('path');
const fs = require('fs');
const { captureSession } = require('./lib/session-capture');

const PIPELINE_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_UI_CWD = path.join(PIPELINE_ROOT, 'ui');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url')              out.url = argv[++i];
    else if (a === '--output')      out.output = argv[++i];
    else if (a === '--timeout-min') out.timeoutMin = parseFloat(argv[++i]);
    else if (a === '--ui-cwd')      out.uiCwd = argv[++i];
    else if (a === '-h' || a === '--help') out.help = true;
    else { console.error(`unknown arg: ${a}`); process.exit(3); }
  }
  return out;
}

function usage() {
  console.log(`Usage:
  node tests/scripts/capture-session.js \\
    --url <login-url> \\
    --output <storage-state.json path> \\
    [--timeout-min 5] \\
    [--ui-cwd ${DEFAULT_UI_CWD}]

跳出 Playwright 視窗讓使用者手動登入；登入完成後關閉視窗，session 寫入 --output。
適合處理需要 CAPTCHA / 2FA / SSO 的站台。

Exit codes: 0=ok, 1=failure, 2=timeout, 3=bad args, 4=no session captured`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) { usage(); process.exit(0); }
if (!args.url || !args.output) { usage(); process.exit(3); }

(async () => {
  const uiCwd = args.uiCwd || DEFAULT_UI_CWD;
  const timeoutMin = args.timeoutMin || 5;

  if (!fs.existsSync(path.join(uiCwd, 'node_modules', 'playwright'))) {
    console.error(`[capture-session] Playwright 未安裝（${uiCwd}/node_modules/playwright 不存在）`);
    console.error(`[capture-session] 修：cd ${uiCwd} && npm install && npx playwright install chromium`);
    process.exit(1);
  }

  console.error(`[capture-session] 即將跳出 Playwright 視窗 — 請手動登入 ${args.url}`);
  console.error(`[capture-session] 登入完成後關閉視窗（最長 ${timeoutMin} 分鐘）`);

  const r = await captureSession({
    loginUrl: args.url,
    outputPath: path.resolve(args.output),
    timeoutMs: timeoutMin * 60 * 1000,
    uiCwd,
    onLog: (s) => process.stderr.write(s),
  });

  if (r.ok) {
    console.error(`[capture-session] ✓ ${r.reason}`);
    console.error(`[capture-session] saved → ${r.outputPath}`);
    process.exit(0);
  }

  console.error(`[capture-session] ✗ ${r.reason}`);
  if (r.hint) console.error(`[capture-session] 💡 ${r.hint}`);

  if (/超過.+未關閉/.test(r.reason)) process.exit(2);
  if (r.storageState) process.exit(4);
  process.exit(1);
})();
