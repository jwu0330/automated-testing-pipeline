import { test, expect } from '@playwright/test';

/**
 * Gremlins.js monkey test
 *
 * 對每個頁面：
 *   1. 訪問頁面
 *   2. 注入 gremlins.js
 *   3. 放出 gremlins（隨機點擊 / 打字 / 滾動）
 *   4. 監聽 window 'error' 與 console.error
 *   5. 若出現未處理的 JS error 則 fail
 */
const PAGES = (process.env.MONKEY_PAGES || '/').split(',').map(s => s.trim()).filter(Boolean);
const ATTACKS = parseInt(process.env.MONKEY_ATTACKS || '500', 10);
const DELAY_MS = parseInt(process.env.MONKEY_DELAY_MS || '10', 10);
const GREMLINS_CDN = 'https://unpkg.com/gremlins.js@2.2.0/dist/gremlins.min.js';

for (const pagePath of PAGES) {
  test(`monkey attack on ${pagePath}`, async ({ page }) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    const failedReqs: { url: string; failure: string }[] = [];

    page.on('pageerror', e => pageErrors.push(`${e.name}: ${e.message}`));
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('requestfailed', req => {
      failedReqs.push({ url: req.url(), failure: req.failure()?.errorText || 'unknown' });
    });

    const response = await page.goto(pagePath, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    expect(response, `should get a response for ${pagePath}`).not.toBeNull();
    expect(response!.status(), `initial load should be < 500`).toBeLessThan(500);

    await page.addScriptTag({ url: GREMLINS_CDN });

    const summary = await page.evaluate(
      async ({ attacks, delay }) => {
        // @ts-expect-error — gremlins global injected via CDN
        const g = window.gremlins;
        const horde = g.createHorde({
          strategies: [g.strategies.distribution({ nb: attacks, delay })],
          mogwais: [g.mogwais.alert(), g.mogwais.fps(), g.mogwais.gizmo()],
        });
        const t0 = Date.now();
        await horde.unleash();
        return { elapsedMs: Date.now() - t0, attacks };
      },
      { attacks: ATTACKS, delay: DELAY_MS }
    );

    await test.info().attach('monkey-summary.json', {
      body: JSON.stringify(
        { page: pagePath, summary, pageErrors, consoleErrors, failedReqs },
        null,
        2
      ),
      contentType: 'application/json',
    });

    // 放寬 console.error — 第三方 SDK 常亂叫；只硬失敗在 pageerror（真正未捕獲例外）
    expect(
      pageErrors,
      `uncaught page errors after monkey attack on ${pagePath}:\n${pageErrors.join('\n')}`
    ).toHaveLength(0);
  });
}
