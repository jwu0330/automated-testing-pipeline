// ════════════════════════════════════════════════════════════════
// http-login.js — 純 Node HTTP 模擬登入
//
// 流程：GET login 頁 → 解析 form action + 隱藏欄位（CSRF）→ POST → 跟隨 redirect
//   → 累積 Set-Cookie → 包成 Playwright storageState
//
// 成功定義：最終回應的 HTML 不再有 input[type=password]
//
// 限制：
//   - 對 JS-heavy 登入（React/Vue 表單透過 XHR 自訂格式）無效
//   - 對 CAPTCHA / reCAPTCHA 無效
//   - 對 password 前端加密（雜湊後再送出）的站台無效
//   失敗時回傳明確 reason，呼叫端再 fallback 到 Cookie-Editor 貼上路徑
// ════════════════════════════════════════════════════════════════
const http  = require('http');
const https = require('https');
const { URL } = require('url');

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 20_000;

function get(urlStr, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      method,
      protocol: u.protocol,
      hostname: u.hostname,
      port:     u.port || (u.protocol === 'https:' ? 443 : 80),
      path:     u.pathname + u.search,
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; ATP-PreLogin/1.0)',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...headers,
      },
      timeout: TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
        url: urlStr,
      }));
    });
    req.on('timeout', () => { req.destroy(new Error(`timeout after ${TIMEOUT_MS}ms`)); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// 累積式 cookie jar：headers 為 key→value 字串（單一網域簡化）
class CookieJar {
  constructor() { this.byName = new Map(); this.detail = []; }
  ingest(setCookieHeader, currentUrl) {
    if (!setCookieHeader) return;
    const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    const u = new URL(currentUrl);
    for (const h of headers) {
      const parts = h.split(';').map(s => s.trim());
      const [nv, ...attrs] = parts;
      const eq = nv.indexOf('=');
      if (eq < 0) continue;
      const name = nv.slice(0, eq);
      const value = nv.slice(eq + 1);
      const cookie = {
        name, value,
        domain: u.hostname,
        path: '/',
        expires: -1,
        httpOnly: false,
        secure: u.protocol === 'https:',
        sameSite: 'Lax',
      };
      for (const a of attrs) {
        const [k, v] = a.split('=').map(s => s && s.trim());
        const lk = k.toLowerCase();
        if (lk === 'domain' && v)   cookie.domain = v.startsWith('.') ? v : v;
        else if (lk === 'path' && v) cookie.path = v;
        else if (lk === 'httponly')  cookie.httpOnly = true;
        else if (lk === 'secure')    cookie.secure = true;
        else if (lk === 'samesite' && v) {
          const ss = v.toLowerCase();
          cookie.sameSite = ss === 'strict' ? 'Strict' : ss === 'none' ? 'None' : 'Lax';
        } else if (lk === 'expires' && v) {
          const t = Date.parse(v);
          if (!Number.isNaN(t)) cookie.expires = Math.floor(t / 1000);
        } else if (lk === 'max-age' && v) {
          const ma = parseInt(v, 10);
          if (!Number.isNaN(ma)) cookie.expires = Math.floor(Date.now() / 1000) + ma;
        }
      }
      this.byName.set(cookie.name, cookie);
    }
  }
  toHeader() {
    return [...this.byName.values()].map(c => `${c.name}=${c.value}`).join('; ');
  }
  toPlaywright() { return [...this.byName.values()]; }
}

// 從 HTML 抽出第一個包含 password 的 form：action / method / 所有 input
function parseLoginForm(html, baseUrl) {
  const formRe = /<form\b[^>]*>([\s\S]*?)<\/form>/gi;
  let m;
  while ((m = formRe.exec(html)) !== null) {
    const formTag = m[0].slice(0, m[0].indexOf('>') + 1);
    const formInner = m[1];
    if (!/<input\b[^>]*\btype\s*=\s*["']?password/i.test(formInner)) continue;

    const actionM = formTag.match(/\baction\s*=\s*["']([^"']*)["']/i);
    const methodM = formTag.match(/\bmethod\s*=\s*["']([^"']*)["']/i);
    const action = actionM ? new URL(actionM[1], baseUrl).toString() : baseUrl;
    const method = (methodM ? methodM[1] : 'POST').toUpperCase();

    const inputs = [];
    const inputRe = /<input\b([^>]*)>/gi;
    let im;
    while ((im = inputRe.exec(formInner)) !== null) {
      const attrs = im[1];
      const nameM  = attrs.match(/\bname\s*=\s*["']([^"']*)["']/i);
      const typeM  = attrs.match(/\btype\s*=\s*["']([^"']*)["']/i);
      const valueM = attrs.match(/\bvalue\s*=\s*["']([^"']*)["']/i);
      const idM    = attrs.match(/\bid\s*=\s*["']([^"']*)["']/i);
      if (!nameM) continue;
      inputs.push({
        name:  nameM[1],
        type:  typeM ? typeM[1].toLowerCase() : 'text',
        value: valueM ? valueM[1] : '',
        id:    idM ? idM[1] : '',
      });
    }
    return { action, method, inputs };
  }
  return null;
}

// 從 inputs 找出最可能的 username/password 欄位名
function pickFieldNames(inputs) {
  const pw = inputs.find(i => i.type === 'password');
  if (!pw) return null;
  const userKeywords = /(user|account|login|email|name|帳號|帳户)/i;
  let user = inputs.find(i => i.type === 'email')
        || inputs.find(i => i.type !== 'password' && i.type !== 'hidden' && userKeywords.test(i.name + ' ' + i.id));
  if (!user) {
    user = inputs.find(i => i.type === 'text');
  }
  return user ? { user: user.name, pass: pw.name } : null;
}

async function httpLogin({ loginUrl, username, password }) {
  const debug = [];
  const jar = new CookieJar();

  // ① GET 登入頁
  let res;
  try {
    res = await get(loginUrl);
    jar.ingest(res.headers['set-cookie'], loginUrl);
    debug.push(`GET ${loginUrl} → ${res.status}（cookies 累積=${jar.byName.size}）`);
  } catch (e) {
    return { ok: false, reason: `GET 登入頁失敗：${e.message}`, debug };
  }
  // GET redirect
  let redirects = 0;
  let currentUrl = loginUrl;
  while ([301, 302, 303, 307, 308].includes(res.status) && redirects < MAX_REDIRECTS) {
    const next = new URL(res.headers.location, currentUrl).toString();
    debug.push(`  redirect → ${next}`);
    res = await get(next, { headers: { cookie: jar.toHeader() } });
    jar.ingest(res.headers['set-cookie'], next);
    currentUrl = next;
    redirects++;
  }

  // ② 解析 form
  const form = parseLoginForm(res.body, currentUrl);
  if (!form) {
    return { ok: false, reason: '在登入頁找不到含 password 欄位的 <form>（可能是 JS 動態渲染表單，HTTP 模擬不行）', debug };
  }
  debug.push(`找到 form：action=${form.action} method=${form.method} inputs=${form.inputs.length}`);

  const fields = pickFieldNames(form.inputs);
  if (!fields) {
    return { ok: false, reason: '找到 form 但無法判斷 username 欄位名稱（可能是非標準命名）', debug };
  }
  debug.push(`欄位對應：username 欄位名「${fields.user}」、password 欄位名「${fields.pass}」`);

  // ③ 組 POST body：所有 input 預設值 + 帳密覆蓋
  const params = new URLSearchParams();
  for (const inp of form.inputs) {
    if (inp.name === fields.user)      params.set(inp.name, username);
    else if (inp.name === fields.pass) params.set(inp.name, password);
    else                                params.set(inp.name, inp.value);
  }

  // ④ POST
  try {
    res = await get(form.action, {
      method: form.method,
      headers: {
        cookie: jar.toHeader(),
        'content-type': 'application/x-www-form-urlencoded',
        referer: currentUrl,
      },
      body: params.toString(),
    });
    jar.ingest(res.headers['set-cookie'], form.action);
    currentUrl = form.action;
    debug.push(`${form.method} ${form.action} → ${res.status}（cookies=${jar.byName.size}）`);
  } catch (e) {
    return { ok: false, reason: `POST 登入失敗：${e.message}`, debug };
  }

  // ⑤ POST redirect
  redirects = 0;
  while ([301, 302, 303, 307, 308].includes(res.status) && redirects < MAX_REDIRECTS) {
    const next = new URL(res.headers.location, currentUrl).toString();
    debug.push(`  redirect → ${next}`);
    res = await get(next, { headers: { cookie: jar.toHeader() } });
    jar.ingest(res.headers['set-cookie'], next);
    currentUrl = next;
    redirects++;
  }

  // ⑥ 驗證：最終頁不應再有 password 欄位
  const stillHasPw = /<input\b[^>]*\btype\s*=\s*["']?password/i.test(res.body);
  if (stillHasPw) {
    return {
      ok: false,
      reason: '送出帳密後最終頁仍有 password 欄位 — 帳密錯誤、或站台有 CAPTCHA / 前端加密 / 動態 token',
      debug,
      finalStatus: res.status,
      finalUrl: currentUrl,
    };
  }

  const cookies = jar.toPlaywright();
  if (cookies.length === 0) {
    return { ok: false, reason: '登入流程結束但沒擷取到任何 cookie（站台可能用 JWT / localStorage）', debug };
  }

  return {
    ok: true,
    reason: `成功擷取 ${cookies.length} 個 cookie`,
    storageState: { cookies, origins: [] },
    debug,
    finalStatus: res.status,
    finalUrl: currentUrl,
  };
}

module.exports = { httpLogin };
