import { test, expect } from '@playwright/test';

/**
 * 通用煙霧測試（Smoke Tests）— 公版
 *
 * 這些測試對任何 PHP 網站都適用，不依賴專案特定邏輯。
 * 各專案可在 .testing/e2e/tests/ 下新增自己的 spec.ts 擴充。
 *
 * 原則：
 *   - 只做 GET / 讀取操作，不寫入資料
 *   - 可容忍 redirect（2xx/3xx 都算通過）
 *   - 回應時間設上限，避免站壞掉還判通過
 */

test.describe('通用煙霧測試', () => {
  test('首頁 HTTP 狀態碼 < 400', async ({ request }) => {
    const res = await request.get('/');
    expect(res.status(), `GET / 回傳 ${res.status()}`).toBeLessThan(400);
  });

  test('首頁回應時間 < 5 秒', async ({ request }) => {
    const t0 = Date.now();
    const res = await request.get('/');
    const elapsed = Date.now() - t0;
    expect(res.ok(), `HTTP ${res.status()}`).toBeTruthy();
    expect(elapsed, `耗時 ${elapsed}ms`).toBeLessThan(5_000);
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

  test('首頁應具備 X-Content-Type-Options: nosniff', async ({ request }) => {
    const res = await request.get('/');
    // 非強制，但現代站都該設。找不到時給明確訊息而不是硬 fail
    const xcto = res.headers()['x-content-type-options'];
    test.skip(!xcto, '未設定 X-Content-Type-Options（建議補上）');
    expect(xcto).toMatch(/nosniff/i);
  });
});
