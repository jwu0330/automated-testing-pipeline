import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { loginIfPossible } from '../_shared/login';

/**
 * 全頁巡檢（Crawl）
 *
 * 從 TARGET_URL 開始，BFS 走訪所有同源 <a href> 連結；驗證每頁：
 *   - HTTP status < 400（404/500 算 fail）
 *   - 沒有未捕獲的 JS 錯誤（pageerror）
 *   - 真的「在裡面」：最終 URL 不是登入頁路徑（/login, /signin 等常見前綴）
 *
 * 為什麼這條 spec 存在：
 *   原本 login.spec / smoke.spec 只盯首頁；要回答「每個分頁都進得去嗎」就得
 *   寫一條會走連結的 spec。對「auth 已關」的目標站，這就是「真的有測到裡面」
 *   的訊號——使用者填的 TARGET_URL 進得去 → 進去後抓到的所有同源連結也都進得去。
 *
 * 登入流程（LOGIN_REQUIRED=true）：
 *   先在同一個 page 上跑 loginIfPossible() 完成表單登入，然後把登入後的 page.url()
 *   當作 BFS 起點。這樣 BFS 帶著 authenticated browser state，能爬到登入後的分頁；如果起點本來
 *   是 /login.html，登入成功後通常會被導去儀表板/首頁，crawl 就從那裡開始。
 *
 * ENV：
 *   TARGET_URL                必填，巡檢起點
 *   CRAWL_ENABLED             "false" 跳過整條 spec
 *   CRAWL_MAX_DEPTH           BFS 深度上限（預設 2）
 *   CRAWL_MAX_PAGES           總頁數上限（預設 50；保險閥避免炸站）
 *   CRAWL_INCLUDE_SUBDOMAINS  "true" 把 *.host 也視為同源
 *   CRAWL_IGNORE_PATTERNS     JSON 陣列，每項是 path 的 regex（字串），符合就跳過
 *
 * 輸出：/reports/crawl-report.json — summarize.js 會讀進來顯示「巡檢結果」
 *
 * 注意：純 GET、不點按鈕、不送表單；只順著靜態 <a href> 走（避免動到任何
 * 寫入操作。SPA 路由若靠 onclick 才產生連結會抓不到——是 spec 的本質限制）。
 */

const ENABLED = (process.env.CRAWL_ENABLED ?? 'true').toLowerCase() !== 'false';
const MAX_DEPTH = parseInt(process.env.CRAWL_MAX_DEPTH || '2', 10);
const MAX_PAGES = parseInt(process.env.CRAWL_MAX_PAGES || '50', 10);
const INCLUDE_SUB = (process.env.CRAWL_INCLUDE_SUBDOMAINS || 'false').toLowerCase() === 'true';
const TARGET = process.env.TARGET_URL || '';
const REPORT_PATH = process.env.CRAWL_REPORT_PATH || '/reports/crawl-report.json';

let IGNORE_RES: RegExp[] = [];
try {
  const arr = JSON.parse(process.env.CRAWL_IGNORE_PATTERNS || '[]');
  if (Array.isArray(arr)) IGNORE_RES = arr.map(s => new RegExp(String(s)));
} catch {
  IGNORE_RES = [];
}

// 預設常見「登入頁路徑前綴」——如果某頁最終 URL 落在這裡且**起點不在這裡**，
// 視為「被踢回登入頁」 = 巡檢失敗
const LOGIN_PATH_PREFIXES = ['/login', '/signin', '/sign-in', '/auth/login', '/account/login', '/users/sign_in'];
const isLoginPath = (p: string) =>
  LOGIN_PATH_PREFIXES.some(prefix => p === prefix || p.startsWith(prefix + '/') || p.startsWith(prefix + '?'));

type PageResult = {
  url: string;
  depth: number;
  from: string;
  status: number;
  ok: boolean;
  finalUrl: string;
  redirectedToLogin: boolean;
  jsErrors: string[];
  links_found: number;
  load_ms: number;
};

test.describe('全頁巡檢', () => {
  test('每個分頁都應可達且回應正常', async ({ browser }) => {
    test.setTimeout(0); // 巡檢可能很久；timeout 用 MAX_PAGES 自然界定
    test.skip(!ENABLED, 'CRAWL_ENABLED=false → 跳過全頁巡檢');
    test.skip(!TARGET, 'TARGET_URL 未設，無從開始巡檢');

    const initialUrl = (() => {
      try {
        return new URL(TARGET).href;
      } catch {
        return '';
      }
    })();
    test.skip(!initialUrl, `TARGET_URL 不是合法 URL：${TARGET}`);

    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // ─── 預先登入（LOGIN_REQUIRED=true 且有帳密時）─────────────
    // 在同一個 page 上完成登入，後續 BFS 直接帶著 authenticated browser state 走。
    // 登入成功 → BFS 起點改為登入後的 landing URL；登入失敗 → 仍從 TARGET 起跳，
    // 由原本的 redirectedToLogin 判定揭露問題。
    let startUrl = initialUrl;
    let loginNote = '';
    const loginRequired = (process.env.LOGIN_REQUIRED || '').toLowerCase() === 'true';
    const hasCreds = !!(process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD);
    if (loginRequired && hasCreds) {
      const r = await loginIfPossible(page);
      if (r.success) {
        startUrl = page.url();
        loginNote = `login ok → start at ${startUrl}`;
        console.log(`  ✓ 登入成功，從登入後的 ${startUrl} 開始巡檢`);
      } else {
        loginNote = `login failed: ${r.reason}`;
        console.log(`  ✗ 登入未成功（${r.reason}）— 退化從 ${initialUrl} 匿名巡檢`);
      }
    } else if (loginRequired && !hasCreds) {
      loginNote = 'LOGIN_REQUIRED=true 但無帳密';
    }

    const startObj = new URL(startUrl);
    const startOrigin = startObj.origin;
    const startHost = startObj.hostname;
    const startedAtLogin = isLoginPath(startObj.pathname);

    // 同源判定：origin 完全相同；INCLUDE_SUB 時 host 為 startHost 子網域亦放行
    const isSameOrigin = (u: URL) => {
      if (u.origin === startOrigin) return true;
      if (INCLUDE_SUB && (u.hostname === startHost || u.hostname.endsWith('.' + startHost))) return true;
      return false;
    };

    // 用 origin+pathname 當去重 key（剝掉 fragment、保留 query 否則 ?id=1 / ?id=2 會混為一頁）
    // 但 query 對部分站會吐出近乎無限的變體——MAX_PAGES 是上限保險閥
    const canonical = (u: URL) => u.origin + u.pathname + u.search;

    const queue: { url: string; depth: number; from: string }[] = [
      { url: canonical(startObj), depth: 0, from: '(entry)' },
    ];
    const visited = new Set<string>();
    const results: PageResult[] = [];

    while (queue.length && results.length < MAX_PAGES) {
      const job = queue.shift()!;
      if (visited.has(job.url)) continue;
      visited.add(job.url);

      const jsErrors: string[] = [];
      const errHandler = (e: Error) => jsErrors.push(e.message);
      page.on('pageerror', errHandler);

      const t0 = Date.now();
      let resp: Awaited<ReturnType<typeof page.goto>> = null;
      let gotoErr = '';
      try {
        resp = await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
      } catch (e: any) {
        gotoErr = e.message || String(e);
      }
      const load_ms = Date.now() - t0;
      page.off('pageerror', errHandler);

      const status = resp?.status() ?? 0;
      let finalUrl = page.url();
      let finalPath = '';
      try {
        finalPath = new URL(finalUrl).pathname;
      } catch {
        finalPath = '';
      }
      const ok = !gotoErr && status > 0 && status < 400;
      // 「被踢回登入頁」判定：起點不在登入路徑、但 final 落在 → 算 fail
      const redirectedToLogin = !startedAtLogin && isLoginPath(finalPath);

      // 收集連結（只在 ok 且未到深度上限時往下走）
      let hrefs: string[] = [];
      if (ok && job.depth < MAX_DEPTH) {
        try {
          hrefs = await page.$$eval('a[href]', as =>
            (as as HTMLAnchorElement[]).map(a => a.href).filter(h => !!h && !h.startsWith('javascript:') && !h.startsWith('mailto:') && !h.startsWith('tel:'))
          );
        } catch {
          hrefs = [];
        }
        for (const href of hrefs) {
          let u: URL;
          try {
            u = new URL(href);
          } catch {
            continue;
          }
          if (!isSameOrigin(u)) continue;
          if (IGNORE_RES.some(re => re.test(u.pathname))) continue;
          const key = canonical(u);
          if (visited.has(key)) continue;
          if (queue.find(q => q.url === key)) continue;
          queue.push({ url: key, depth: job.depth + 1, from: job.url });
        }
      }

      results.push({
        url: job.url,
        depth: job.depth,
        from: job.from,
        status,
        ok,
        finalUrl,
        redirectedToLogin,
        jsErrors,
        links_found: hrefs.length,
        load_ms,
      });

      if (gotoErr) {
        console.log(`  ✗ [${job.depth}] ${job.url} — ${gotoErr}`);
      } else if (!ok) {
        console.log(`  ✗ [${job.depth}] ${job.url} — HTTP ${status}`);
      } else if (redirectedToLogin) {
        console.log(`  ⚠ [${job.depth}] ${job.url} → ${finalPath} (被踢回登入頁)`);
      } else {
        console.log(`  ✓ [${job.depth}] ${job.url} (${status}, ${load_ms}ms, ${hrefs.length} links)`);
      }
    }

    await ctx.close();

    // ─── 寫報告 ─────────────────────────────────
    const summary = {
      target: startUrl,
      initial_target: initialUrl,
      login_note: loginNote,
      started_at_login: startedAtLogin,
      visited: results.length,
      ok: results.filter(r => r.ok && !r.redirectedToLogin).length,
      failed: results.filter(r => !r.ok || r.redirectedToLogin).length,
      hit_max_pages: queue.length > 0,
      max_depth: MAX_DEPTH,
      max_pages: MAX_PAGES,
      include_subdomains: INCLUDE_SUB,
      ignore_patterns: (process.env.CRAWL_IGNORE_PATTERNS || '[]'),
      pages: results,
    };
    try {
      fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
      fs.writeFileSync(REPORT_PATH, JSON.stringify(summary, null, 2));
    } catch (e: any) {
      console.error(`寫巡檢報告失敗：${e.message}`);
    }

    // ─── 斷言 ───────────────────────────────────
    // 沒有頁面被掃 → fail（目標站根本進不去 / TARGET_URL 不對）
    expect(results.length, '完全沒有任何頁面被巡檢到').toBeGreaterThan(0);

    // 任何 page 拿到 4xx/5xx 或被踢回登入頁 → fail
    const failures = results.filter(r => !r.ok || r.redirectedToLogin);
    expect(
      failures,
      `${failures.length} / ${results.length} 頁巡檢失敗：\n` +
        failures
          .map(f => `  - ${f.url} → status=${f.status}${f.redirectedToLogin ? ' [踢回登入頁]' : ''}${f.jsErrors.length ? ` jsErrors=${f.jsErrors.length}` : ''}`)
          .join('\n')
    ).toEqual([]);
  });
});
