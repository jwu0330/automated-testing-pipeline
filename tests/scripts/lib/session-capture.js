// ════════════════════════════════════════════════════════════════
// tests/scripts/lib/session-capture.js — 共用 session 擷取（UI + Skill 共用）
//
// 流程：spawn `npx playwright open --save-storage` → 使用者在跳出的真瀏覽器
//   手動登入（CAPTCHA / 2FA / SSO 都行）→ 關閉視窗 → 讀 storageState 回來
//
// 對外 API：
//   captureSession({ loginUrl, outputPath, timeoutMs?, uiCwd, onLog? })
//     — loginUrl   : 要開的目標頁
//     — outputPath : Playwright 寫 storageState 的位置
//     — timeoutMs  : 視窗最長存活時間，預設 5 分鐘
//     — uiCwd      : Playwright 安裝目錄（必須含 node_modules/playwright）
//     — onLog      : 收 child stdout/stderr 的 callback（選填）
//     回傳 { ok, reason, storageState?, outputPath?, hint?, stderr? }
//
// 為什麼 Playwright 在 ui/：歷史原因，UI 先用，沒必要為 Skill 重裝一份。
// 兩邊都從 <root>/ui 啟動，靠 cwd 找 node_modules/playwright。
// ════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

function captureSession({ loginUrl, outputPath, timeoutMs, uiCwd, onLog }) {
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

    try { fs.mkdirSync(path.dirname(outputPath), { recursive: true }); } catch {}

    let stderr = '';
    let timedOut = false;

    // Node 20+ 在 Windows 直接 spawn .cmd 會 EINVAL；shell:true 是必要的。
    // 引號 loginUrl 避免 query string 的 & 被 shell 當作分隔符切斷。
    const args = ['playwright', 'open', `--save-storage="${outputPath}"`, `"${loginUrl}"`];
    const cmdline = `npx ${args.join(' ')}`;
    log(`[session-capture] $ ${cmdline}\n[session-capture] cwd=${uiCwd}\n`);

    const child = spawn(cmdline, [], {
      cwd: uiCwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
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
