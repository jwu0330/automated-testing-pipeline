// ════════════════════════════════════════════════════════════════
// tests/scripts/lib/session-capture.js — 共用 session 擷取（UI + Skill 共用）
//
// 流程：spawn `ui/lib/prelogin-browser.js`（自寫 Playwright 腳本）→
//   開窗 → goto loginUrl → 若提供帳密就自動填 → 等使用者解 CAPTCHA / 2FA、按送出 →
//   關閉視窗 → 讀 storageState 回來
//
// 對外 API：
//   captureSession({ loginUrl, outputPath, timeoutMs?, uiCwd, onLog?, username?, password? })
//     — loginUrl   : 要開的目標頁
//     — outputPath : 把 storageState 寫到這
//     — timeoutMs  : 視窗最長存活時間，預設 5 分鐘
//     — uiCwd      : Playwright 安裝目錄（必須含 node_modules/playwright + lib/prelogin-browser.js）
//     — onLog      : 收 child stdout/stderr 的 callback（選填）
//     — username/password : 選填；提供時 prelogin-browser 會自動填表，使用者只需處理 CAPTCHA/2FA
//     回傳 { ok, reason, storageState?, outputPath?, hint?, stderr? }
// ════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function captureSession({ loginUrl, outputPath, timeoutMs, uiCwd, onLog, username, password }) {
  return new Promise((resolve) => {
    const log = onLog || (() => {});
    timeoutMs = timeoutMs || DEFAULT_TIMEOUT_MS;

    if (!loginUrl || !/^https?:\/\//i.test(loginUrl)) {
      resolve({ ok: false, reason: '需提供合法 http(s) URL' });
      return;
    }
    if (!outputPath) {
      resolve({ ok: false, reason: 'outputPath 必填' });
      return;
    }
    if (!uiCwd || !fs.existsSync(path.join(uiCwd, 'node_modules', 'playwright'))) {
      resolve({
        ok: false,
        reason: `Playwright 未安裝（找不到 ${uiCwd}/node_modules/playwright）`,
        hint: `在 ${uiCwd} 執行：npm install && npx playwright install chromium`,
      });
      return;
    }
    const scriptPath = path.join(uiCwd, 'lib', 'prelogin-browser.js');
    if (!fs.existsSync(scriptPath)) {
      resolve({
        ok: false,
        reason: `找不到 prelogin 腳本：${scriptPath}`,
      });
      return;
    }

    try { fs.mkdirSync(path.dirname(outputPath), { recursive: true }); } catch {}

    let stderr = '';
    let timedOut = false;

    // 直接 spawn node binary 跑自寫腳本：避免 npx 包一層 shell，也避免 .cmd / quoting 雷。
    // username/password 走 argv 而非環境變數，讓使用者在 server log 看不到密碼明文（child argv 不寫 log）。
    const argv = [scriptPath, '--url', loginUrl, '--save', outputPath];
    if (username && password) argv.push('--user', username, '--pass', password);
    log(`[session-capture] $ node lib/prelogin-browser.js --url ${loginUrl} --save ${outputPath}${username ? ' --user *** --pass ***' : ''}\n[session-capture] cwd=${uiCwd}\n`);

    const child = spawn(process.execPath, argv, {
      cwd: uiCwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Playwright 的訊息 stdout / stderr 都會走，全部累積給 caller 看
    child.stderr.on('data', (d) => { const s = d.toString(); stderr += s; log(s); });
    child.stdout.on('data', (d) => { const s = d.toString(); stderr += s; log(s); });

    const killer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(killer);
      resolve({
        ok: false,
        reason: `無法啟動 Playwright：${e.message}`,
        hint: `在 ${uiCwd} 執行：npm install && npx playwright install chromium`,
      });
    });

    child.on('close', (code) => {
      clearTimeout(killer);
      if (timedOut) {
        resolve({ ok: false, reason: `超過 ${Math.round(timeoutMs / 60000)} 分鐘未關閉視窗，已強制終止` });
        return;
      }
      if (!fs.existsSync(outputPath)) {
        resolve({
          ok: false,
          reason: `視窗結束但無 session 檔（exit=${code}）`,
          stderr: stderr.slice(-500),
          hint: `Playwright 可能未安裝或 chromium 缺失：在 ${uiCwd} 執行 npm install && npx playwright install chromium`,
        });
        return;
      }
      let ss;
      try { ss = JSON.parse(fs.readFileSync(outputPath, 'utf8')); }
      catch (e) { resolve({ ok: false, reason: '讀取 session 檔失敗：' + e.message }); return; }

      const cookieCount = Array.isArray(ss.cookies) ? ss.cookies.length : 0;
      const originCount = Array.isArray(ss.origins) ? ss.origins.length : 0;
      if (cookieCount === 0 && originCount === 0) {
        resolve({
          ok: false,
          reason: '視窗關閉時沒擷取到任何 cookie / storage — 可能視窗開了但沒實際登入',
          storageState: ss,
          outputPath,
        });
        return;
      }
      resolve({
        ok: true,
        reason: `擷取到 ${cookieCount} 個 cookie + ${originCount} 個 origin storage`,
        storageState: ss,
        outputPath,
      });
    });
  });
}

module.exports = { captureSession, DEFAULT_TIMEOUT_MS };
