#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════
// ui/lib/prelogin-browser.js
//
// 開一個 Playwright 控制的瀏覽器視窗，自動把帳密填到登入表單，
// 然後等使用者解 CAPTCHA / 2FA、按送出。視窗關閉時把 storageState 寫到 --save。
//
// 取代原本的 `npx playwright open` —— 後者沒有自動填表的 hook。
//
// CLI:
//   node prelogin-browser.js --url <loginUrl> --save <storageStatePath>
//                            [--user <username> --pass <password>]
//
// stdout 會印出進度行（[prelogin] ...），server.js 會轉成 SSE 給 UI 顯示。
// ════════════════════════════════════════════════════════════════
const { chromium } = require('playwright');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url')  out.url  = argv[++i];
    else if (a === '--save') out.save = argv[++i];
    else if (a === '--user') out.user = argv[++i];
    else if (a === '--pass') out.pass = argv[++i];
  }
  return out;
}

// 先試一串 selector，第一個「可見」的 fill 進去；都不中回 null
async function tryFillBySelectors(page, selectors, value) {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ state: 'visible', timeout: 1500 });
      await loc.fill(value);
      return sel;
    } catch {
      // not visible or not found — try next
    }
  }
  return null;
}

async function autofillCredentials(page, user, pass) {
  // 等 DOM 穩一點再找欄位（SPA 可能還在 render）
  try { await page.waitForLoadState('domcontentloaded', { timeout: 10000 }); } catch {}
  // 找 password 欄位是最穩的錨點
  const passLoc = page.locator('input[type="password"]').first();
  const passReady = await passLoc.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
  if (!passReady) {
    console.log('[prelogin] no password field — please fill the form manually');
    return false;
  }

  // 帳號欄位：優先 name/id 命名，再來中英文 placeholder，最後 DOM-fallback
  const userSelectors = [
    // 英文 name / id
    'input[name*="user" i]:not([type="hidden"])',
    'input[id*="user" i]:not([type="hidden"])',
    'input[name*="account" i]:not([type="hidden"])',
    'input[id*="account" i]:not([type="hidden"])',
    'input[name*="login" i]:not([type="hidden"])',
    'input[id*="login" i]:not([type="hidden"])',
    'input[name*="phone" i]:not([type="hidden"])',
    'input[name*="mobile" i]:not([type="hidden"])',
    'input[name*="email" i]:not([type="hidden"])',
    'input[type="email"]',
    'input[autocomplete="username"]',
    'input[autocomplete="email"]',
    // 中文 placeholder（babydodofun / 標準後台常見）
    'input[placeholder*="帳號"]:not([type="password"])',
    'input[placeholder*="使用者"]:not([type="password"])',
    'input[placeholder*="管理員"]:not([type="password"])',
    'input[placeholder*="手機"]:not([type="password"])',
    'input[placeholder*="電話"]:not([type="password"])',
    'input[placeholder*="信箱"]:not([type="password"])',
    'input[placeholder*="郵箱"]:not([type="password"])',
    // 英文 placeholder
    'input[placeholder*="user" i]:not([type="password"])',
    'input[placeholder*="email" i]:not([type="password"])',
    'input[placeholder*="account" i]:not([type="password"])',
  ];

  let usedSel = await tryFillBySelectors(page, userSelectors, user);
  if (usedSel) {
    console.log(`[prelogin] filled username (matched: ${usedSel})`);
  } else {
    // Fallback：在 DOM 上找排在 password 之前最近的可見 text-like input
    const fallbackSel = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const passIdx = inputs.findIndex(i => (i.type || '').toLowerCase() === 'password');
      if (passIdx <= 0) return null;
      const skip = new Set(['hidden', 'checkbox', 'radio', 'submit', 'button', 'file', 'image', 'reset']);
      const isVisible = (el) =>
        !!(el.offsetParent || el.getClientRects().length) &&
        getComputedStyle(el).visibility !== 'hidden';
      for (let i = passIdx - 1; i >= 0; i--) {
        const el = inputs[i];
        if (skip.has((el.type || 'text').toLowerCase())) continue;
        if (!isVisible(el)) continue;
        // 給它一個唯一的 data-attr 讓 Locator 抓得到
        const tag = '__atp_user_' + Math.random().toString(36).slice(2, 8);
        el.setAttribute('data-atp-target', tag);
        return `input[data-atp-target="${tag}"]`;
      }
      return null;
    });
    if (fallbackSel) {
      try {
        await page.locator(fallbackSel).fill(user);
        console.log(`[prelogin] filled username (DOM fallback: input before password)`);
      } catch (e) {
        console.log('[prelogin] username DOM-fallback fill failed: ' + e.message);
      }
    } else {
      console.log('[prelogin] username field not found — please fill manually');
    }
  }

  try {
    await passLoc.fill(pass);
    console.log('[prelogin] filled password');
  } catch (e) {
    console.log('[prelogin] password fill failed: ' + e.message);
  }
  return true;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url || !args.save) {
    console.error('usage: prelogin-browser.js --url <loginUrl> --save <storageStatePath> [--user <u> --pass <p>]');
    process.exit(2);
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: false });
  } catch (e) {
    console.error('[prelogin] launch failed: ' + e.message);
    console.error('[prelogin] hint: 在 ui/ 執行 `npx playwright install chromium`');
    process.exit(3);
  }

  const context = await browser.newContext();
  const page = await context.newPage();

  console.log('[prelogin] navigating to ' + args.url);
  try {
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.log('[prelogin] goto warning: ' + e.message);
  }

  if (args.user && args.pass) {
    await autofillCredentials(page, args.user, args.pass).catch(e => {
      console.log('[prelogin] autofill error: ' + e.message);
    });
    console.log('[prelogin] 請在視窗內處理 CAPTCHA / 2FA、按送出，然後關閉視窗');
  } else {
    console.log('[prelogin] no credentials provided — please log in manually, then close the window');
  }

  // 每次主框架導航都存一次 storageState；最終以登入後的快照為準
  // 視窗關閉的瞬間 context 也會關，那時再呼叫 storageState 會拿不到 — 所以靠中間每次都存
  const saveState = async () => {
    try {
      await context.storageState({ path: args.save });
    } catch {}
  };
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) saveState(); });
  context.on('page', (newPage) => {
    newPage.on('framenavigated', (frame) => { if (frame === newPage.mainFrame()) saveState(); });
  });

  // 等使用者關閉視窗
  await new Promise((resolve) => {
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };
    browser.on('disconnected', done);
    context.on('close', done);
  });

  // 收尾：browser 已 disconnected，這次 storageState 會丟錯，但中間每次 framenavigated 都已寫過
  await saveState();
  console.log('[prelogin] done');
  process.exit(0);
})().catch((e) => {
  console.error('[prelogin] fatal: ' + (e && e.stack || e));
  process.exit(1);
});
