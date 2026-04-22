import { test, expect } from '@playwright/test';

/**
 * C2 視覺迴歸測試 (Visual Comparison)
 *
 * 用途：
 *   - 抓取頁面截圖並與基準線比對
 *   - 偵測 UI 變化、樣式崩壞、圖片遺失等
 *   - 跨瀏覽器視覺一致性驗證
 *
 * 使用方式：
 *   首次執行會產生基準線截圖（放在 tests/__screenshots__ 或 tests/visual/baselines）：
 *     npx playwright test --update-snapshots
 *
 *   後續執行會比對，若有差異會產生失敗報告與高亮圖片。
 *
 * 各專案在 .testing/e2e/tests/ 可自行新增 visual.spec.ts 或其他 spec
 * 只需在 snapshot 比對處加入頁面路由即可。
 */

/**
 * 通用視覺基準線：只對首頁 `/` 做截圖比對。
 * 各專案若要對其他頁面做視覺迴歸，請複製此檔到 .testing/e2e/tests/ 並加入自己的路由。
 */
test.describe('C2 視覺迴歸測試', () => {
  test('首頁全頁面視覺基準線（初次執行時產生基準、後續進行比對）', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

    await expect(page).toHaveScreenshot('homepage-full.png', {
      fullPage: true,
      maxDiffPixelRatio: 0.05, // 容許最多 5% 像素差異
    });
  });

  test('首頁可視區截圖（不含 fold 以下）', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

    await expect(page).toHaveScreenshot('homepage-viewport.png', {
      fullPage: false,
      maxDiffPixelRatio: 0.05,
    });
  });
});

test.describe('C3 瀏覽器相容性測試', () => {
  test('不同瀏覽器首頁載入（需在 playwright.config.ts 啟用 firefox/webkit）', async ({
    page,
    browserName,
  }) => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // 驗證頁面在各瀏覽器上都能正常載入
    const title = await page.title();
    expect(title).toBeTruthy();

    // 可針對特定瀏覽器做客製驗證
    if (browserName === 'firefox') {
      // Firefox 特有驗證（例如某些 API 差異）
      expect(true).toBeTruthy();
    } else if (browserName === 'webkit') {
      // Safari 特有驗證
      expect(true).toBeTruthy();
    }
  });

  test('響應式設計：不同視口大小', async ({ page }) => {
    const viewports = [
      { width: 1920, height: 1080, name: 'desktop' },
      { width: 768, height: 1024, name: 'tablet' },
      { width: 375, height: 667, name: 'mobile' },
    ];

    for (const vp of viewports) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const title = await page.title();
      expect(title, `${vp.name} viewport should load`).toBeTruthy();

      // 可選：針對各視口做截圖比對
      // await expect(page).toHaveScreenshot(`homepage-${vp.name}.png`, { fullPage: true });
    }
  });
});
