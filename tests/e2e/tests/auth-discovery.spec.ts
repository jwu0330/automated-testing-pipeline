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

test('auth discovery: login and collect reachable pages', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

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
  const okPages = pages.filter(p => p.ok && p.sameOrigin);
  const urls = okPages.map(p => p.finalUrl || p.url);
  const paths = Array.from(new Set(urls.map(toPath))).slice(0, MAX_PAGES);
  const journeys = [{
    name: 'auth_discovered',
    weight: 100,
    auth: !!cookieHeader,
    steps: paths.map(p => `GET ${p}`),
  }];

  const discovery = {
    target: TARGET_URL,
    login,
    startUrl,
    maxPages: MAX_PAGES,
    maxDepth: MAX_DEPTH,
    cookieHeaderPresent: !!cookieHeader,
    discoveredAt: new Date().toISOString(),
    pages,
  };

  write('auth-discovery.json', JSON.stringify(discovery, null, 2));
  write('auth-urls.txt', urls.join('\n') + (urls.length ? '\n' : ''));
  write('auth-paths.txt', paths.join('\n') + (paths.length ? '\n' : ''));
  write('auth-journeys.json', JSON.stringify(journeys, null, 2));
  write('auth-cookie-header.txt', cookieHeader);

  await context.close();
});
