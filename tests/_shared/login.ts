import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

export type LoginMode = 'session' | 'form' | 'anonymous';

export type LoginAttempt = {
  // ① 在什麼情況下
  scenario: {
    targetUrl: string;
    landingUrl: string;
    mode: LoginMode;
    hasStorageState: boolean;
    hasCreds: boolean;
  };
  // ② 做了什麼事情
  actions: string[];
  // ③ 回報內容
  result: {
    attempted: boolean;
    success: boolean;
    reason: string;
    finalUrl?: string;
  };
  timestamp: string;
};

export type LoginResult = LoginAttempt['result'];

/**
 * 啟發式登入。優先順序：
 *   1. 有 STORAGE_STATE_PATH（Playwright config 已套用）→ 視為已登入，跳過表單
 *   2. 有 ADMIN_USERNAME/PASSWORD → 偵測登入頁表單，自動填入並送出
 *   3. 都沒有 → 視為匿名測試
 *
 * 每次呼叫都會寫 /reports/login-status.json，summarize.js 會讀取後組成報告區塊。
 */
export async function loginIfPossible(
  page: Page,
  opts?: { uiUrl?: string; user?: string; pass?: string; timeoutMs?: number }
): Promise<LoginResult> {
  const targetUrl = opts?.uiUrl ?? process.env.TARGET_UI_URL ?? process.env.TARGET_URL ?? '';
  const hasStorageState = !!process.env.STORAGE_STATE_PATH;
  const user = opts?.user ?? process.env.ADMIN_USERNAME ?? '';
  const pass = opts?.pass ?? process.env.ADMIN_PASSWORD ?? '';
  const hasCreds = !!(user && pass);

  const actions: string[] = [];
  const attempt: LoginAttempt = {
    scenario: {
      targetUrl,
      landingUrl: '',
      mode: hasStorageState ? 'session' : (hasCreds ? 'form' : 'anonymous'),
      hasStorageState,
      hasCreds,
    },
    actions,
    result: { attempted: false, success: false, reason: '' },
    timestamp: new Date().toISOString(),
  };
  const finalize = (r: LoginResult) => {
    attempt.result = r;
    writeLoginStatus(attempt);
    return r;
  };

  // ① Session 模式：Playwright config 已套用 storageState，瀏覽器一開就帶 cookie
  if (hasStorageState) {
    actions.push(`使用上傳的 session 檔（STORAGE_STATE_PATH=${process.env.STORAGE_STATE_PATH}）`);
    if (!targetUrl) {
      return finalize({ attempted: false, success: false, reason: 'session 已套用但無 TARGET_URL，無法驗證' });
    }
    actions.push(`訪問 ${targetUrl} 驗證 session 有效性`);
    try {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: opts?.timeoutMs ?? 30_000 });
    } catch (e: any) {
      return finalize({ attempted: true, success: false, reason: `訪問目標頁失敗：${e.message}` });
    }
    attempt.scenario.landingUrl = page.url();
    const stillHasPw = (await page.locator('input[type=password]').count()) > 0;
    if (stillHasPw) {
      actions.push('偵測到頁面仍有 input[type=password] → 推斷 session 已過期或未對應到目標站');
      return finalize({
        attempted: true,
        success: false,
        reason: 'session 失效：訪問後仍出現登入頁的 password 欄位（cookie 過期 / domain 不符 / 未含 HttpOnly session）',
        finalUrl: page.url(),
      });
    }
    return finalize({ attempted: true, success: true, reason: '使用上傳 session，訪問後未見登入頁', finalUrl: page.url() });
  }

  // ② 匿名（沒帳密）
  if (!hasCreds) {
    actions.push('未提供 ADMIN_USERNAME / ADMIN_PASSWORD，也未上傳 session → 以匿名身份繼續');
    return finalize({ attempted: false, success: false, reason: 'no creds and no session — running anonymously' });
  }

  // ③ 表單模式
  if (!targetUrl) {
    return finalize({ attempted: false, success: false, reason: 'no TARGET_URL' });
  }
  const navTimeout = opts?.timeoutMs ?? 30_000;
  actions.push(`訪問 ${targetUrl} 找登入表單`);
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: navTimeout });
  } catch (e: any) {
    return finalize({ attempted: true, success: false, reason: `訪問目標頁失敗：${e.message}` });
  }
  attempt.scenario.landingUrl = page.url();

  const pwField = page.locator('input[type=password]').first();
  if (!(await pwField.count())) {
    actions.push('頁面上找不到 input[type=password] → 可能首頁本身就是登入後狀態，或登入入口在其他路徑');
    return finalize({
      attempted: false,
      success: false,
      reason: '目標頁無 password 欄位，無法自動登入（請改用 session 上傳，或檢查 TARGET_UI_URL 是否指向登入頁）',
      finalUrl: page.url(),
    });
  }

  const userSelectors = [
    'input[type=email]',
    'input[name*="user" i]',  'input[name*="account" i]', 'input[name*="login" i]', 'input[name*="email" i]',
    'input[id*="user" i]',    'input[id*="account" i]',   'input[id*="login" i]',   'input[id*="email" i]',
    'input[type=text]:not([type=hidden])',
  ];
  let userField: any = null;
  let usedSelector = '';
  for (const sel of userSelectors) {
    const cand = page.locator(sel).first();
    if (await cand.count()) { userField = cand; usedSelector = sel; break; }
  }
  if (!userField) {
    actions.push('找到 password 欄位但找不到任何文字/Email 輸入欄 → 此頁可能不是標準登入表單');
    return finalize({
      attempted: false,
      success: false,
      reason: '找到 password 但找不到 username 欄位（可能是非標準登入頁、或有 CAPTCHA 前置）',
      finalUrl: page.url(),
    });
  }
  actions.push(`找到欄位：username 用選擇器「${usedSelector}」，password 用「input[type=password]」`);
  actions.push(`填入帳號 ${user}，密碼長度 ${pass.length}`);
  await userField.fill(user);
  await pwField.fill(pass);

  const beforeUrl = page.url();
  const submitBtn = page.locator('button[type=submit], input[type=submit], button:has-text("登入"), button:has-text("Login"), button:has-text("Sign in")').first();
  const settled = page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  if (await submitBtn.count()) {
    actions.push('找到 submit 按鈕，點擊送出');
    await submitBtn.click().catch((e: any) => actions.push(`submit 點擊例外：${e.message}`));
  } else {
    actions.push('沒有 submit 按鈕，改在 password 欄位按 Enter');
    await pwField.press('Enter').catch((e: any) => actions.push(`Enter 例外：${e.message}`));
  }
  await settled;

  const stillHasPw = (await page.locator('input[type=password]').count()) > 0;
  const urlChanged = page.url() !== beforeUrl;
  actions.push(`送出後 URL ${urlChanged ? '已變化' : '未變化'}（${beforeUrl} → ${page.url()}），password 欄位${stillHasPw ? '仍存在' : '消失'}`);

  const success = urlChanged && !stillHasPw;
  return finalize({
    attempted: true,
    success,
    reason: success
      ? '表單登入成功'
      : `表單登入失敗 — URL 變化=${urlChanged}、password 殘留=${stillHasPw}（常見原因：帳密錯誤、CAPTCHA、需要 2FA、登入頁有 JS 防護）`,
    finalUrl: page.url(),
  });
}

function writeLoginStatus(attempt: LoginAttempt) {
  const out = process.env.LOGIN_STATUS_PATH || '/reports/login-status.json';
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(attempt, null, 2));
  } catch {
    // 不影響測試本身
  }
}
