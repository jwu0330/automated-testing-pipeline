import { test, expect } from '@playwright/test';
import { loginIfPossible } from '../_shared/login';

/**
 * 自動登入驗證
 *
 * 兩種模式：
 *   ① Session 模式（推薦，可避開 CAPTCHA / 2FA）
 *      - 使用者上傳 storageState.json（含 cookies + localStorage）
 *      - Playwright config 已套用 storageState，瀏覽器一開就是登入態
 *      - 本測試只驗證：訪問 TARGET_URL 後沒有被導回登入頁
 *
 *   ② 表單模式（fallback）
 *      - 條件啟動：ADMIN_USERNAME / ADMIN_PASSWORD 都有值
 *      - 偵測登入頁的 password 欄位 + 鄰近 username 欄位，填入並送出
 *      - 驗證：URL 變化、password 欄位消失
 *
 * 兩個都沒有時整個 test 跳過。
 */
test('登入應成功（session 或表單）', async ({ page }) => {
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
