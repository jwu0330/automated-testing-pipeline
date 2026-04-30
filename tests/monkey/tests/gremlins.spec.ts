import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { loginIfPossible } from '../_shared/login';

/**
 * Gremlins.js monkey test
 *
 * 對每個頁面：
 *   1. 若有 ADMIN_USERNAME/PASSWORD → 先登入（避開「整站被權限封住，monkey 只在登入頁亂點」）
 *   2. 訪問頁面（已登入時，authenticated browser state 會帶下去）
 *   3. 注入 gremlins.js（self-hosted，避免 CSP script-src 擋外部 CDN）
 *   4. 放出 gremlins（隨機點擊 / 打字 / 滾動）
 *   5. 監聽 window 'error' 與 console.error
 *   6. 若出現未處理的 JS error 則 fail
 */
const PAGES = (process.env.MONKEY_PAGES || '/').split(',').map(s => s.trim()).filter(Boolean);
const ATTACKS = parseInt(process.env.MONKEY_ATTACKS || '500', 10);
const DELAY_MS = parseInt(process.env.MONKEY_DELAY_MS || '10', 10);

// 從 node_modules 讀 gremlins.min.js — 用 page.evaluate(<code>) 注入（走 CDP，
// 不會建立 <script> 元素，因此不受目標站 CSP script-src 限制）
const GREMLINS_PATH = path.join(__dirname, '..', 'node_modules', 'gremlins.js', 'dist', 'gremlins.min.js');
const GREMLINS_CODE = fs.readFileSync(GREMLINS_PATH, 'utf-8');

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

    // ① 先登入（若提供帳密）— 不成功也不擋執行，但會記錄到 attachment
    const loginResult = await loginIfPossible(page);
    console.log(`[monkey] login: ${JSON.stringify(loginResult)}`);

    const response = await page.goto(pagePath, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });
    expect(response, `should get a response for ${pagePath}`).not.toBeNull();
    expect(response!.status(), `initial load should be < 500`).toBeLessThan(500);

    // 注入 gremlins.js — 用 evaluate 而非 addScriptTag，避開 CSP
    await page.evaluate(GREMLINS_CODE);

    const summary = await page.evaluate(
      async ({ attacks, delay }) => {
        // @ts-expect-error — gremlins global injected via evaluate
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
        { page: pagePath, login: loginResult, summary, pageErrors, consoleErrors, failedReqs },
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
