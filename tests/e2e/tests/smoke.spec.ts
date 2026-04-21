import { test, expect } from '@playwright/test';

/**
 * 通用煙霧測試（Smoke Tests）
 *
 * 這些測試對任何 PHP 網站都適用，不依賴專案特定邏輯。
 * 各專案可在 .testing/e2e/tests/ 下新增自己的 spec.ts 擴充。
 */

test.describe('通用煙霧測試', () => {
  test('首頁 HTTP 狀態碼 < 400', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status(), `GET / 回傳 ${res.status()}`).toBeLessThan(400);
  });

  test('首頁能在瀏覽器載入', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBeLessThan(400);
  });

  test('首頁有 <title>', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/.+/);
  });

  test('首頁沒有 JavaScript 錯誤', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    expect(errors, `發現 JS 錯誤：\n${errors.join('\n')}`).toEqual([]);
  });
});

test.describe('安全標頭檢查', () => {
  test('首頁回應含有 Content-Type', async ({ request }) => {
    const res = await request.get('/');
    expect(res.headers()['content-type']).toBeTruthy();
  });

  test('首頁若使用 HTTPS 應具備 Strict-Transport-Security', async ({ request }) => {
    const res = await request.get('/');
    test.skip(!res.url().startsWith('https://'), '非 HTTPS，略過');
    expect(res.headers()['strict-transport-security']).toBeTruthy();
  });
});
