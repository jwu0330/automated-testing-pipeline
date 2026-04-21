import { test } from '@playwright/test';

/**
 * ═══════════════════════════════════════════════════════════════
 *  預留給專案客製的 UI 測試
 * ═══════════════════════════════════════════════════════════════
 *
 * 此檔案為流水線的「保留空間」。
 * 各專案在 .testing/e2e/tests/ 下建立自己的 spec 時，可參考此範本。
 *
 * 建議撰寫的測試範疇：
 *   1. 使用者流程（登入、註冊、下單…）
 *   2. 表單驗證
 *   3. 關鍵頁面的互動元件
 *   4. 權限控管（未登入無法進入 admin 等）
 *
 * 登入測試可透過環境變數取得帳密：
 *   const user = process.env.E2E_USERNAME;
 *   const pass = process.env.E2E_PASSWORD;
 */

test.skip('專案 UI 測試：請在 <project>/.testing/e2e/tests/ 下自行撰寫', async () => {
  // intentionally empty — this file is a placeholder
});
