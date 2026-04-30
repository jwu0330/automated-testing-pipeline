import { defineConfig } from '@playwright/test';

/**
 * Monkey（Gremlins.js）測試設定
 *
 * 讀取環境變數：
 *   TARGET_URL          目標站 baseURL（必填）
 *   MONKEY_PAGES        逗號分隔頁面清單（預設 "/"）
 *   MONKEY_ATTACKS      攻擊次數（預設 500）
 *   MONKEY_DELAY_MS     每次攻擊間隔（預設 10ms）
 */
export default defineConfig({
  testDir: './tests',
  // 每個頁面預留 5 分鐘：gremlins 會跑 attacks * delay 毫秒
  timeout: 300_000,
  expect: { timeout: 5_000 },

  fullyParallel: false,
  retries: 0,
  workers: 1,

  reporter: [
    ['list'],
    ['json', { outputFile: '/reports/monkey-report.json' }],
    ['html', { outputFolder: '/reports/monkey-html', open: 'never' }],
  ],

  use: {
    baseURL: process.env.TARGET_URL || 'https://example.com',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    ignoreHTTPSErrors: true,
    // 若使用者上傳了 session（cookies + localStorage），Playwright 直接帶著進站 →
    // 完全跳過登入頁，不會觸發 CAPTCHA / 2FA。沒提供時為 undefined（走 spec 內的表單登入）。
    storageState: process.env.STORAGE_STATE_PATH || undefined,
  },
});
