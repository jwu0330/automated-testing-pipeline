import { test, expect } from '@playwright/test';
import { loginIfPossible } from '../_shared/login';

/**
 * 登入驗證 spec — 2026-04-30 起預設停用。
 *
 * 目標站多數已關後端 auth：
 *   - 預設（LOGIN_REQUIRED 未設或 false）：整支 spec skip，登入交給 crawl.spec 用
 *     「最終 URL 不在登入頁路徑」這套真正的「進得去」判定。
 *   - 設 `LOGIN_REQUIRED=true` 才走原本的 session / 表單登入流程（保留為 fallback）。
 */
test('登入應成功（session 或表單）', async ({ page }) => {
  const loginRequired = (process.env.LOGIN_REQUIRED || '').toLowerCase() === 'true';
  test.skip(!loginRequired, 'LOGIN_REQUIRED 未設 → 目標站視為無 auth，整條登入測試 skip');

  const hasSession = !!process.env.STORAGE_STATE_PATH;
  const hasCreds = !!(process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD);
  test.skip(!hasSession && !hasCreds, '未提供 session 也未提供帳密，略過登入測試');

  if (hasSession) {
    // Session 模式：訪問首頁，驗證沒被踢回登入頁
    const target = process.env.TARGET_UI_URL || process.env.TARGET_URL || '/';
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const stillOnLogin = (await page.locator('input[type=password]').count()) > 0;
    expect(stillOnLogin, `session 失效：訪問 ${target} 後仍出現 password 欄位（可能 cookie 已過期，請重新匯出）`).toBeFalsy();
    return;
  }

  const r = await loginIfPossible(page);
  console.log(`[login] result: ${JSON.stringify(r)}`);
  expect(r.attempted, `表單登入未嘗試：${r.reason}`).toBeTruthy();
  expect(r.success, `表單登入失敗：${r.reason} (final=${r.finalUrl})`).toBeTruthy();
});
