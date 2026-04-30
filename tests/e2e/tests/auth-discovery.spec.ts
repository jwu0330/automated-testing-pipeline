import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { loginIfPossible } from '../_shared/login';

const TARGET_URL = process.env.TARGET_URL || 'https://example.com';
const REPORT_DIR = process.env.AUTH_DISCOVERY_REPORT_DIR || '/reports';
const MAX_PAGES = parseInt(process.env.AUTH_DISCOVERY_MAX_PAGES || process.env.CRAWL_MAX_PAGES || '12', 10);
const MAX_DEPTH = parseInt(process.env.AUTH_DISCOVERY_MAX_DEPTH || process.env.CRAWL_MAX_DEPTH || '2', 10);

function sameSite(base: URL, next: URL) {
  return next.origin === base.origin;
}

function canonical(u: URL) {
  u.hash = '';
  return u.toString();
}

function toPath(url: string) {
  try {
    const u = new URL(url);
    return u.pathname + (u.search || '');
  } catch {
    return '/';
  }
}

function write(name: string, body: string) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORT_DIR, name), body);
}

// 標準 header 黑名單：這些是瀏覽器/transport 自動送的，轉發給下游工具沒意義
const STANDARD_HEADER_BLACKLIST = new Set([
  'host', 'connection', 'content-length', 'content-type', 'accept', 'accept-encoding',
  'accept-language', 'user-agent', 'referer', 'origin', 'cookie', 'cache-control', 'pragma',
  'upgrade-insecure-requests', 'dnt', 'te',
]);

// 認得「這個 header 看起來是身分用的」— 寬鬆收，寧可錯抓也不要漏抓
function looksLikeAuthHeader(name: string): boolean {
  const n = name.toLowerCase();
  if (n === 'authorization') return true;
  if (n.startsWith('x-') && /(token|auth|api-key|apikey|csrf|session)/.test(n)) return true;
  return false;
}

test('auth discovery: login and collect reachable pages', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  // ─── 攔截登入後的 API request，抓真實送出的 header ───
  // 為什麼：很多現代系統不靠 cookie 帶身分，而是把 token 存 sessionStorage / localStorage，
  // 然後在 fetch/XHR 時動態組成 Authorization / X-Admin-Token 等自訂 header。
  // 純粹複製 cookie 給下游工具會失效——必須抓到「實際送出的 header」才能轉發。
  const RUNTIME_HEADERS: Record<string, string> = {};
  page.on('request', req => {
    const t = req.resourceType();
    if (t !== 'xhr' && t !== 'fetch') return; // 只看 API 流量
    const h = req.headers();
    for (const name of Object.keys(h)) {
      const value = h[name];
      const lower = name.toLowerCase();
      if (STANDARD_HEADER_BLACKLIST.has(lower)) continue;
      if (lower.startsWith(':')) continue; // HTTP/2 pseudo headers
      if (!value) continue;
      if (looksLikeAuthHeader(name)) {
        RUNTIME_HEADERS[name] = value; // 後到的覆蓋前面 — token refresh 取最新
      }
    }
  });

  const login = await loginIfPossible(page);
  const startUrl = login.success ? page.url() : TARGET_URL;
  const start = new URL(startUrl);

  const queue: { url: string; depth: number; from: string }[] = [
    { url: canonical(start), depth: 0, from: '(entry)' },
  ];
  const seen = new Set<string>();
  const pages: any[] = [];

  while (queue.length && pages.length < MAX_PAGES) {
    const item = queue.shift()!;
    if (seen.has(item.url)) continue;
    seen.add(item.url);

    let responseStatus = 0;
    let finalUrl = item.url;
    let title = '';
    let error = '';
    let links: string[] = [];
    let forms: any[] = [];
    let buttons: string[] = [];
    let inputs: any[] = [];

    try {
      const response = await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
      responseStatus = response?.status() || 0;
      finalUrl = page.url();
      title = await page.title().catch(() => '');
      links = await page.$$eval('a[href]', anchors =>
        (anchors as HTMLAnchorElement[])
          .map(a => a.href)
          .filter(Boolean)
      ).catch(() => []);
      forms = await page.$$eval('form', els =>
        (els as HTMLFormElement[]).map((form, index) => ({
          index,
          action: form.action || '',
          method: (form.method || 'get').toUpperCase(),
          inputs: Array.from(form.querySelectorAll('input, select, textarea')).map((el: any) => ({
            tag: el.tagName?.toLowerCase() || '',
            type: el.type || '',
            name: el.name || '',
            id: el.id || '',
            required: !!el.required,
          })),
        }))
      ).catch(() => []);
      buttons = await page.$$eval('button, input[type=button], input[type=submit]', els =>
        (els as HTMLElement[]).map((el: any) => (el.innerText || el.value || el.getAttribute('aria-label') || '').trim()).filter(Boolean).slice(0, 30)
      ).catch(() => []);
      inputs = await page.$$eval('input, select, textarea', els =>
        (els as HTMLElement[]).map((el: any) => ({
          tag: el.tagName?.toLowerCase() || '',
          type: el.type || '',
          name: el.name || '',
          id: el.id || '',
          required: !!el.required,
        })).slice(0, 80)
      ).catch(() => []);
    } catch (e: any) {
      error = e.message || String(e);
    }

    let current = start;
    try {
      current = new URL(finalUrl === 'about:blank' ? item.url : finalUrl);
    } catch {
      current = start;
    }
    for (const href of links) {
      if (pages.length + queue.length >= MAX_PAGES) break;
      let next: URL;
      try {
        next = new URL(href);
      } catch {
        continue;
      }
      if (!sameSite(start, next)) continue;
      if (!/^https?:$/.test(next.protocol)) continue;
      const key = canonical(next);
      if (seen.has(key) || queue.some(q => q.url === key)) continue;
      if (item.depth + 1 <= MAX_DEPTH) {
        queue.push({ url: key, depth: item.depth + 1, from: item.url });
      }
    }

    pages.push({
      url: item.url,
      finalUrl,
      path: toPath(finalUrl),
      from: item.from,
      depth: item.depth,
      status: responseStatus,
      ok: !error && responseStatus > 0 && responseStatus < 400,
      title,
      forms,
      buttons,
      inputs,
      linksFound: links.length,
      error,
      sameOrigin: sameSite(start, current),
    });
  }

  const cookies = await context.cookies();
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  // 撈 sessionStorage / localStorage — 純粹 debug 用，幫你看「token 到底存在哪」
  const storageDump = await page.evaluate(() => {
    const dump = (s: Storage) => {
      const out: Record<string, string> = {};
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k) out[k] = s.getItem(k) || '';
      }
      return out;
    };
    return {
      sessionStorage: dump(window.sessionStorage),
      localStorage: dump(window.localStorage),
    };
  }).catch(() => ({ sessionStorage: {}, localStorage: {} }));

  // 整合 auth headers — 從 runtime 攔到的（含 Authorization / X-Admin-Token 等）
  const authHeaders = { ...RUNTIME_HEADERS };
  // 給下游 shell 工具用的格式：「Name: Value」每行一個（不含 Cookie，cookie 走 auth-cookie-header.txt）
  const extraHeadersText = Object.entries(authHeaders)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  const okPages = pages.filter(p => p.ok && p.sameOrigin);
  const urls = okPages.map(p => p.finalUrl || p.url);
  const paths = Array.from(new Set(urls.map(toPath))).slice(0, MAX_PAGES);
  const hasAnyAuth = !!cookieHeader || Object.keys(authHeaders).length > 0;
  const journeys = [{
    name: 'auth_discovered',
    weight: 100,
    auth: hasAnyAuth,
    steps: paths.map(p => `GET ${p}`),
  }];

  const discovery = {
    target: TARGET_URL,
    login,
    startUrl,
    maxPages: MAX_PAGES,
    maxDepth: MAX_DEPTH,
    cookieHeaderPresent: !!cookieHeader,
    extraHeadersPresent: Object.keys(authHeaders).length > 0,
    extraHeaderNames: Object.keys(authHeaders),
    sessionStorageKeys: Object.keys(storageDump.sessionStorage),
    localStorageKeys: Object.keys(storageDump.localStorage),
    discoveredAt: new Date().toISOString(),
    pages,
  };

  write('auth-discovery.json', JSON.stringify(discovery, null, 2));
  write('auth-urls.txt', urls.join('\n') + (urls.length ? '\n' : ''));
  write('auth-paths.txt', paths.join('\n') + (paths.length ? '\n' : ''));
  write('auth-journeys.json', JSON.stringify(journeys, null, 2));
  write('auth-cookie-header.txt', cookieHeader);
  write('auth-headers.json', JSON.stringify(authHeaders, null, 2));
  write('auth-extra-headers.txt', extraHeadersText);
  write('auth-storage.json', JSON.stringify(storageDump, null, 2));

  await context.close();
});
