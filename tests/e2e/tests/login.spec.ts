import { test, expect } from '@playwright/test';
import { loginIfPossible } from '../_shared/login';

test('form login succeeds when login is required', async ({ page }) => {
  const loginRequired = (process.env.LOGIN_REQUIRED || '').toLowerCase() === 'true';
  test.skip(!loginRequired, 'LOGIN_REQUIRED is not true, so login test is skipped');

  const hasCreds = !!(process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD);
  test.skip(!hasCreds, 'ADMIN_USERNAME / ADMIN_PASSWORD were not provided');

  const r = await loginIfPossible(page);
  console.log(`[login] result: ${JSON.stringify(r)}`);
  expect(r.attempted, `form login was not attempted: ${r.reason}`).toBeTruthy();
  expect(r.success, `form login failed: ${r.reason} (final=${r.finalUrl})`).toBeTruthy();
});
