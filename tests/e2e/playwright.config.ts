import { defineConfig, devices } from '@playwright/test';

/**
 * 通用 Playwright 設定
 *
 * 讀取環境變數：
 *   TARGET_URL    - 測試目標網址（預設 https://example.com）
 *   E2E_USERNAME  - 登入測試用帳號（選填）
 *   E2E_PASSWORD  - 登入測試用密碼（選填）
 *
 * 各專案應複製此檔到 <project>/.testing/e2e/ 並依需求覆寫。
 */
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },

  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 2 : undefined,

  reporter: [
    ['list'],
    ['html', { outputFolder: '/reports/playwright', open: 'never' }],
    ['junit', { outputFile: '/reports/playwright-junit.xml' }],
  ],

  use: {
    baseURL: process.env.TARGET_URL || 'https://example.com',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ignoreHTTPSErrors: false,
    // 若使用者上傳了 session（cookies + localStorage），Playwright 直接帶著進站 →
    // 完全跳過登入頁，不會觸發 CAPTCHA / 2FA。沒提供時為 undefined（走 spec 內的表單登入）。
    storageState: process.env.STORAGE_STATE_PATH || undefined,
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit',   use: { ...devices['Desktop Safari'] } },
  ],
});
