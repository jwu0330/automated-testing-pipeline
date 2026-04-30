import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

export type LoginMode = 'form' | 'anonymous';

export type LoginAttempt = {
  scenario: {
    targetUrl: string;
    landingUrl: string;
    mode: LoginMode;
    hasCapturedState: false;
    hasCreds: boolean;
  };
  actions: string[];
  result: {
    attempted: boolean;
    success: boolean;
    reason: string;
    finalUrl?: string;
  };
  timestamp: string;
};

export type LoginResult = LoginAttempt['result'];

/**
 * Shared form-login helper for Playwright based tests.
 *
 * Captured browser-state login was removed on 2026-04-30.
 * The pipeline still supports login, but only by submitting credentials to the target UI.
 * No captured cookie or token is mounted or replayed.
 */
export async function loginIfPossible(
  page: Page,
  opts?: { uiUrl?: string; user?: string; pass?: string; timeoutMs?: number }
): Promise<LoginResult> {
  const targetUrl = opts?.uiUrl ?? process.env.TARGET_UI_URL ?? process.env.TARGET_URL ?? '';
  const loginRequired = (process.env.LOGIN_REQUIRED || '').toLowerCase() === 'true';
  const user = opts?.user ?? process.env.ADMIN_USERNAME ?? '';
  const pass = opts?.pass ?? process.env.ADMIN_PASSWORD ?? '';
  const hasCreds = !!(user && pass);

  const actions: string[] = [];
  const attempt: LoginAttempt = {
    scenario: {
      targetUrl,
      landingUrl: '',
      mode: loginRequired && hasCreds ? 'form' : 'anonymous',
      hasCapturedState: false,
      hasCreds,
    },
    actions,
    result: { attempted: false, success: false, reason: '' },
    timestamp: new Date().toISOString(),
  };
  const finalize = (r: LoginResult) => {
    attempt.result = r;
    writeLoginStatus(attempt);
    return r;
  };

  if (!loginRequired) {
    actions.push('LOGIN_REQUIRED is not true, so login is skipped.');
    return finalize({
      attempted: false,
      success: false,
      reason: 'login disabled (LOGIN_REQUIRED!=true)',
    });
  }

  if (!hasCreds) {
    actions.push('ADMIN_USERNAME / ADMIN_PASSWORD were not provided.');
    return finalize({ attempted: false, success: false, reason: 'no credentials provided' });
  }

  if (!targetUrl) {
    return finalize({ attempted: false, success: false, reason: 'no TARGET_URL or TARGET_UI_URL' });
  }

  const navTimeout = opts?.timeoutMs ?? 30_000;
  actions.push(`Navigate to ${targetUrl}`);
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: navTimeout });
  } catch (e: any) {
    return finalize({ attempted: true, success: false, reason: `navigation failed: ${e.message}` });
  }
  attempt.scenario.landingUrl = page.url();

  const pwField = page.locator('input[type=password]').first();
  if (!(await pwField.count())) {
    actions.push('No password field was found; target may already be public or the login page differs.');
    return finalize({
      attempted: false,
      success: false,
      reason: 'no password field found for form login',
      finalUrl: page.url(),
    });
  }

  const userSelectors = [
    'input[type=email]',
    'input[name*="user" i]', 'input[name*="account" i]', 'input[name*="login" i]', 'input[name*="email" i]',
    'input[id*="user" i]', 'input[id*="account" i]', 'input[id*="login" i]', 'input[id*="email" i]',
    'input[type=text]:not([type=hidden])',
  ];
  let userField: any = null;
  let usedSelector = '';
  for (const sel of userSelectors) {
    const cand = page.locator(sel).first();
    if (await cand.count()) { userField = cand; usedSelector = sel; break; }
  }
  if (!userField) {
    actions.push('Password field found, but no username/email field was detected.');
    return finalize({
      attempted: false,
      success: false,
      reason: 'password field found but username field missing',
      finalUrl: page.url(),
    });
  }

  actions.push(`Fill username via ${usedSelector} and password via input[type=password]`);
  await userField.fill(user);
  await pwField.fill(pass);

  const beforeUrl = page.url();
  const submit = page.locator('button[type=submit], input[type=submit], button:has-text("登入"), button:has-text("Login"), button:has-text("Sign in")').first();
  const settled = page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  if (await submit.count()) {
    await submit.click().catch((e: any) => actions.push(`submit click failed: ${e.message}`));
  } else {
    await pwField.press('Enter').catch((e: any) => actions.push(`Enter submit failed: ${e.message}`));
  }
  await settled;

  const stillHasPw = (await page.locator('input[type=password]').count()) > 0;
  const urlChanged = page.url() !== beforeUrl;
  const success = urlChanged && !stillHasPw;
  actions.push(`After submit: urlChanged=${urlChanged}, stillHasPassword=${stillHasPw}`);

  return finalize({
    attempted: true,
    success,
    reason: success
      ? 'form login succeeded'
      : `form login failed: urlChanged=${urlChanged}, stillHasPassword=${stillHasPw}`,
    finalUrl: page.url(),
  });
}

function writeLoginStatus(attempt: LoginAttempt) {
  const out = process.env.LOGIN_STATUS_PATH || '/reports/login-status.json';
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(attempt, null, 2));
  } catch {
    // Reporting must never break the test itself.
  }
}
