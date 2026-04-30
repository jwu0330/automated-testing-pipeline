#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════
// summarize.js — 產生統一測試報告
//
// 讀取：reports/<project>/raw/ 下的工具原始輸出
// 產出：
//   - reports/<project>/report.md    ← 人類可讀（摘要 + 詳細一檔）
//   - reports/<project>/report.json  ← structured report
//   - reports/<project>/history.jsonl ← 歷史紀錄（append-only）
//
// 用法：node tests/scripts/summarize.js <project-name> [--json]
// ════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const project = args.find(a => !a.startsWith('--'));
const asJson = args.includes('--json');
if (!project) {
  console.error('用法：node tests/scripts/summarize.js <project-name> [--json]');
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '..');

// 報告目錄解析：優先使用環境變數（由 run-project.sh 設定指向專案 .testing/reports/），
// 否則退回舊路徑（pipeline/reports/<project>）以保向後相容
const REPORT_DIR = process.env.REPORTS_DIR
  ? path.resolve(process.env.REPORTS_DIR)
  : path.join(ROOT, 'reports', project);
const RAW = path.join(REPORT_DIR, 'raw');

if (!fs.existsSync(REPORT_DIR)) {
  console.error(`找不到報告目錄：${REPORT_DIR}`);
  process.exit(1);
}
// raw/ 若不存在但有舊檔案，視為 v1 結構（back-compat）
if (!fs.existsSync(RAW)) {
  fs.mkdirSync(RAW, { recursive: true });
}

const exists = p => fs.existsSync(p);
const read = p => fs.readFileSync(p, 'utf-8');
const pad = (s, w) => String(s).padEnd(w);

// ─── 在 raw/ 找檔；找不到回退到 REPORT_DIR（v1 舊路徑相容）──
function findRaw(basename) {
  const inRaw = path.join(RAW, basename);
  if (exists(inRaw)) return inRaw;
  const inOld = path.join(REPORT_DIR, basename);
  if (exists(inOld)) return inOld;
  return null;
}
function findRawGlob(regex) {
  const candidates = [RAW, REPORT_DIR];
  for (const dir of candidates) {
    if (!exists(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => regex.test(f));
    if (files.length) return files.map(f => path.join(dir, f)).sort();
  }
  return [];
}

// ─── 歷史檔（新：history.jsonl；舊：run-history.jsonl）────
const HISTORY = exists(path.join(REPORT_DIR, 'run-history.jsonl'))
  ? path.join(REPORT_DIR, 'run-history.jsonl')
  : path.join(REPORT_DIR, 'history.jsonl');

function readHistory() {
  if (!exists(HISTORY)) return [];
  return read(HISTORY).trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}
function appendHistory(entry) {
  fs.appendFileSync(HISTORY, JSON.stringify(entry) + '\n');
}
function trend(cur, prev, lowerIsBetter = true) {
  if (prev == null || cur == null) return '';
  if (cur === prev) return '  [=]';
  const d = cur - prev;
  const good = lowerIsBetter ? d < 0 : d > 0;
  const arrow = d > 0 ? '↑' : '↓';
  const sign = d > 0 ? '+' : '';
  return `  [${arrow}${sign}${d}${good ? ' 改善' : ' 惡化'}]`;
}

// ─── ① SSL ────────────────────────────────────────────────
function parseSSL() {
  // 新格式：固定檔名 testssl.html；舊格式 testssl-<timestamp>.html 也接（向後相容）
  let target = findRaw('testssl.html');
  if (!target) {
    const files = findRawGlob(/^testssl-.*\.html$/);
    if (!files.length) return { status: 'no-report' };
    target = files[files.length - 1];
  }
  const html = read(target);
  const grade = (html.match(/Overall Grade\s*<\/span>\s*<span[^>]*>([A-F][+\-]?)/) || [])[1] || 'N/A';
  const score = (html.match(/Final Score\s*<\/span>\s*(\d+)/) || [])[1] || 'N/A';
  return { grade, score, file: path.basename(target) };
}

// ─── ② PHPStan ───────────────────────────────────────────
function parsePHPStan() {
  const p = findRaw('phpstan.json');
  if (!p || fs.statSync(p).size === 0) return { status: 'no-report' };
  try {
    const data = JSON.parse(read(p));
    const total = data.totals?.file_errors ?? 0;
    const files = Object.entries(data.files || {})
      .map(([fullPath, v]) => ({
        relative: fullPath.replace(/^\/project\//, ''),
        file: path.basename(fullPath),
        errors: v.errors ?? 0,
        messages: (v.messages || []).map(m => ({
          line: m.line ?? null,
          message: m.message ?? '',
        })),
      }))
      .sort((a, b) => b.errors - a.errors);
    return { total, files };
  } catch (e) {
    return { status: 'parse-error', error: e.message };
  }
}

// ─── ③ ZAP（優先讀 JSON，退回 HTML 抓計數）─────────────────
function parseZAP() {
  const pJson = findRaw('zap-report.json');
  if (pJson) {
    try {
      const data = JSON.parse(read(pJson));
      const counts = { High: 0, Medium: 0, Low: 0, Informational: 0 };
      const alerts = [];
      const sites = data.site || [];
      for (const site of sites) {
        for (const a of (site.alerts || [])) {
          const level = ['Informational', 'Low', 'Medium', 'High'][parseInt(a.riskcode, 10)] || 'Informational';
          counts[level]++;
          alerts.push({
            level,
            name: a.name || a.alert || '',
            url: (a.instances || [])[0]?.uri || site['@name'] || '',
            cwe: a.cweid ?? null,
          });
        }
      }
      return { ...counts, alerts };
    } catch (e) { /* fall through */ }
  }
  const pHtml = findRaw('zap-report.html');
  if (!pHtml) return { status: 'no-report' };
  const html = read(pHtml);
  const counts = { High: 0, Medium: 0, Low: 0, Informational: 0 };
  const summary = (html.match(/Summary of Alerts[\s\S]*?(?=<h3|$)/) || [''])[0];
  for (const row of (summary.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [])) {
    const rm = row.match(/class="risk-(\d)"/);
    const nm = row.match(/<td\s+align="center"[^>]*>\s*<div>(\d+)/);
    if (rm && nm) {
      const level = ['Informational', 'Low', 'Medium', 'High'][parseInt(rm[1], 10)];
      counts[level] += parseInt(nm[1], 10);
    }
  }
  return { ...counts, alerts: [] };
}

// ─── ④ k6 ────────────────────────────────────────────────
// 同時抽 per-journey 指標：load-test.js 給每個 scenario 加了 `{journey:NAME}` tag，
// k6 summary 會出現 `http_req_duration{journey:foo}` 這種子 metric。
function parseK6() {
  const p = findRaw('k6-summary.json');
  if (!p) return { status: 'no-report' };
  try {
    const m = JSON.parse(read(p)).metrics || {};
    const pick = (obj, ...keys) => {
      for (const k of keys) if (obj?.[k] != null) return obj[k];
      return null;
    };
    const v = (key, ...subs) => {
      const obj = m[key];
      if (!obj) return null;
      return pick(obj, ...subs) ?? pick(obj.values || {}, ...subs);
    };
    // 全域指標（保留向後相容）
    const overall = {
      totalReqs: v('http_reqs', 'count') ?? 0,
      avgMs: v('http_req_duration', 'avg') ?? 0,
      p95Ms: v('http_req_duration', 'p(95)') ?? 0,
      failedPct: (v('http_req_failed', 'rate') ?? 0) * 100,
    };
    // per-journey：掃所有 `http_req_duration{journey:X}` 與 `http_reqs{journey:X}`
    const journeys = {};
    for (const key of Object.keys(m)) {
      const tagMatch = key.match(/^([a-z_]+)\{journey:([^,}]+)(?:,[^}]*)?\}$/i);
      if (!tagMatch) continue;
      const [, metric, jname] = tagMatch;
      if (!journeys[jname]) journeys[jname] = {};
      if (metric === 'http_req_duration') {
        journeys[jname].avgMs = v(key, 'avg') ?? 0;
        journeys[jname].p95Ms = v(key, 'p(95)') ?? 0;
      } else if (metric === 'http_reqs') {
        journeys[jname].reqs = v(key, 'count') ?? 0;
      } else if (metric === 'http_req_failed') {
        journeys[jname].failedPct = (v(key, 'rate') ?? 0) * 100;
      }
    }
    return {
      ...overall,
      journeys: Object.entries(journeys).map(([name, x]) => ({ name, ...x })),
    };
  } catch (e) { return { status: 'parse-error', error: e.message }; }
}

// ─── 認證上下文（2026-04-30 起預設停用；保留 parser 為了讀舊報告）──────
function parseAuthContext() {
  const p = findRaw('auth-context.json');
  if (!p) return null;
  try { return JSON.parse(read(p)); } catch { return null; }
}

function parseAuthDiscovery() {
  const p = findRaw('auth-discovery.json');
  if (!p) return null;
  try {
    const data = JSON.parse(read(p));
    const pages = Array.isArray(data.pages) ? data.pages : [];
    return {
      status: 'ok',
      login: data.login || null,
      pages,
      okPages: pages.filter(p => p.ok).length,
      formPages: pages.filter(p => Array.isArray(p.forms) && p.forms.length).length,
      buttonPages: pages.filter(p => Array.isArray(p.buttons) && p.buttons.length).length,
      cookieHeaderPresent: !!data.cookieHeaderPresent,
      startUrl: data.startUrl || '',
    };
  } catch (e) {
    return { status: 'parse-error', error: e.message };
  }
}

// ─── ⑫ E2E 全頁巡檢（crawl）──────────────────────────────
function parseCrawl() {
  const p = findRaw('crawl-report.json');
  if (!p) return { status: 'no-report' };
  try {
    const data = JSON.parse(read(p));
    return {
      target: data.target,
      visited: data.visited || 0,
      ok: data.ok || 0,
      failed: data.failed || 0,
      hit_max_pages: !!data.hit_max_pages,
      max_depth: data.max_depth,
      max_pages: data.max_pages,
      pages: Array.isArray(data.pages) ? data.pages : [],
      failures: Array.isArray(data.pages)
        ? data.pages.filter(p => !p.ok || p.redirectedToLogin)
        : [],
    };
  } catch (e) {
    return { status: 'parse-error', error: e.message };
  }
}

// 數 testcase 元素（比解析 testsuite 聚合屬性更穩，因為 Newman/Playwright
// JUnit XML 的 testsuite 可能多層巢狀，聚合值放的位置不固定）
function countJUnit(xml) {
  // 只算葉子 testcase（不含 nested）
  const testcases = (xml.match(/<testcase\b/g) || []).length;
  const failures = (xml.match(/<failure\b/g) || []).length;
  const errors = (xml.match(/<error\b/g) || []).length;
  return { tests: testcases, failures, errors };
}

function extractFails(xml, withClassname = true) {
  const fails = [];
  // 個別擷取 failure 與 error
  for (const tag of ['failure', 'error']) {
    const re = withClassname
      ? new RegExp(`<testcase[^>]*?name="([^"]+)"[^>]*?classname="([^"]+)"[\\s\\S]*?<${tag}[^>]*?>([\\s\\S]*?)<\\/${tag}>`, 'g')
      : new RegExp(`<testcase[^>]*?name="([^"]+)"[\\s\\S]*?<${tag}[^>]*?>([\\s\\S]*?)<\\/${tag}>`, 'g');
    for (const fm of xml.matchAll(re)) {
      const entry = withClassname
        ? { class: fm[2], test: fm[1], message: (fm[3] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim().split('\n')[0].slice(0, 200) }
        : { test: fm[1], message: (fm[2] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim().split('\n')[0].slice(0, 200) };
      fails.push(entry);
    }
  }
  return fails;
}

// ─── ⑤ API 測試 (Newman, 多身分) ───────────────────────
function parseAPI() {
  const files = findRawGlob(/^newman-junit-.+\.xml$/);
  if (!files.length) return { status: 'no-report' };
  const identities = [];
  let total = 0, totalFails = 0;
  for (const f of files) {
    // newman-junit-admin.xml → admin；newman-junit-user1-line_signup.xml → user1-line_signup
    const idMatch = path.basename(f).match(/^newman-junit-(.+)\.xml$/);
    const identity = idMatch ? idMatch[1] : path.basename(f);
    try {
      const xml = read(f);
      const { tests, failures, errors } = countJUnit(xml);
      const fails = extractFails(xml, false).slice(0, 10); // 前 10 個失敗
      identities.push({ identity, tests, failures: failures + errors, fails });
      total += tests;
      totalFails += failures + errors;
    } catch (e) {
      identities.push({ identity, status: 'parse-error', error: e.message });
    }
  }
  return { identities, total, totalFails };
}

// ─── ⑥ Playwright ────────────────────────────────────────
function parsePlaywright() {
  const p = findRaw('playwright-junit.xml');
  if (!p) return { status: 'no-report' };
  try {
    const xml = read(p);
    const { tests, failures } = countJUnit(xml);
    if (tests === 0) return { status: 'parse-error', error: 'no testcases found' };
    return { tests, failures, fails: extractFails(xml, false) };
  } catch (e) { return { status: 'parse-error', error: e.message }; }
}

// ─── ⑦ Nuclei (JSONL) ────────────────────────────────────
function parseNuclei() {
  const p = findRaw('nuclei.jsonl');
  if (!p) return { status: 'no-report' };
  try {
    const lines = read(p).split('\n').filter(Boolean);
    const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0, unknown: 0 };
    const findings = [];
    for (const ln of lines) {
      try {
        const f = JSON.parse(ln);
        const sev = (f.info?.severity || 'unknown').toLowerCase();
        if (counts[sev] == null) counts[sev] = 0;
        counts[sev]++;
        findings.push({
          severity: sev,
          name: f.info?.name || f['template-id'] || '',
          templateId: f['template-id'] || '',
          url: f['matched-at'] || f.host || '',
        });
      } catch { /* skip malformed line */ }
    }
    return { ...counts, total: findings.length, findings };
  } catch (e) { return { status: 'parse-error', error: e.message }; }
}

// ─── ⑧ Lighthouse (manifest) ─────────────────────────────
function parseLighthouse() {
  const p = findRaw('lighthouse-manifest.json');
  if (!p) return { status: 'no-report' };
  try {
    const arr = JSON.parse(read(p));
    if (!Array.isArray(arr) || !arr.length) return { status: 'parse-error', error: 'empty manifest' };
    const avg = { performance: 0, accessibility: 0, best_practices: 0, seo: 0 };
    for (const e of arr) {
      for (const k of Object.keys(avg)) avg[k] += (e.scores?.[k] ?? 0);
    }
    for (const k of Object.keys(avg)) avg[k] = Math.round(avg[k] / arr.length);
    return { pages: arr, avg };
  } catch (e) { return { status: 'parse-error', error: e.message }; }
}

// ─── ⑨ Monkey (Playwright JSON reporter) ─────────────────
function parseMonkey() {
  const p = findRaw('monkey-report.json');
  if (!p) return { status: 'no-report' };
  try {
    const data = JSON.parse(read(p));
    const stats = data.stats || {};
    const tests = (stats.expected || 0) + (stats.unexpected || 0) + (stats.skipped || 0) + (stats.flaky || 0);
    const failures = stats.unexpected || 0;
    const errors = [];
    const walk = (suites) => {
      for (const s of (suites || [])) {
        for (const spec of (s.specs || [])) {
          for (const t of (spec.tests || [])) {
            for (const r of (t.results || [])) {
              if (r.status && r.status !== 'passed' && r.status !== 'skipped') {
                const msg = r.error?.message ? r.error.message.split('\n')[0].slice(0, 200) : 'failed';
                errors.push({ test: spec.title, message: msg });
              }
            }
          }
        }
        walk(s.suites);
      }
    };
    walk(data.suites);
    if (tests === 0) return { status: 'parse-error', error: 'no tests found' };
    return { tests, failures, errors };
  } catch (e) { return { status: 'parse-error', error: e.message }; }
}

// ─── ⑩ Trivy (fs) ────────────────────────────────────────
function parseTrivy() {
  const p = findRaw('trivy-fs.json');
  if (!p) return { status: 'no-report' };
  try {
    const data = JSON.parse(read(p));
    const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 };
    const vulns = [];
    const secrets = [];
    const misconfigs = [];
    for (const r of (data.Results || [])) {
      for (const v of (r.Vulnerabilities || [])) {
        const sev = (v.Severity || 'UNKNOWN').toUpperCase();
        if (counts[sev] == null) counts[sev] = 0;
        counts[sev]++;
        vulns.push({
          id: v.VulnerabilityID,
          pkg: v.PkgName,
          installed: v.InstalledVersion,
          fixed: v.FixedVersion || '',
          severity: sev,
          title: (v.Title || '').slice(0, 120),
          target: r.Target,
        });
      }
      for (const s of (r.Secrets || [])) {
        secrets.push({
          title: s.Title,
          severity: (s.Severity || 'UNKNOWN').toUpperCase(),
          target: r.Target,
          line: s.StartLine,
        });
      }
      for (const m of (r.Misconfigurations || [])) {
        misconfigs.push({
          id: m.ID,
          title: m.Title,
          severity: (m.Severity || 'UNKNOWN').toUpperCase(),
          target: r.Target,
        });
      }
    }
    return { ...counts, vulns, secrets, misconfigs, total: vulns.length };
  } catch (e) { return { status: 'parse-error', error: e.message }; }
}

// ─── ⑪ Lychee (broken links) ─────────────────────────────
function parseLychee() {
  const p = findRaw('lychee.json');
  if (!p) return { status: 'no-report' };
  try {
    const data = JSON.parse(read(p));
    const broken = [];
    for (const [source, entries] of Object.entries(data.error_map || {})) {
      for (const e of (entries || [])) {
        let statusStr = 'error';
        if (e.status != null) {
          if (typeof e.status === 'object') {
            statusStr = e.status.code ?? e.status.text ?? Object.keys(e.status)[0] ?? 'error';
          } else {
            statusStr = String(e.status);
          }
        }
        broken.push({ url: e.url, status: statusStr, source });
      }
    }
    return {
      total: data.total || 0,
      successful: data.successful || 0,
      errors: data.errors || 0,
      timeouts: data.timeouts || 0,
      excluded: data.excluded || 0,
      broken,
    };
  } catch (e) { return { status: 'parse-error', error: e.message }; }
}

// ─── ⓪ Warnings（來自 run-project.sh 的 WARNINGS[] / precheck）──
function parseWarnings() {
  const p = path.join(REPORT_DIR, 'warnings.txt');
  if (!exists(p)) return [];
  return read(p).split('\n').map(l => l.trim()).filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════
// 解析
// ═══════════════════════════════════════════════════════════════
const warnings = parseWarnings();
const authCtx = parseAuthContext();
const authDiscovery = parseAuthDiscovery();
const crawl = parseCrawl();
const s  = parseSSL();
const ps = parsePHPStan();
const z  = parseZAP();
const k  = parseK6();
const api = parseAPI();
const pw = parsePlaywright();
const nu = parseNuclei();
const lh = parseLighthouse();
const mk = parseMonkey();
const tv = parseTrivy();
const lc = parseLychee();

const history = readHistory();
const prev = history.length ? history[history.length - 1] : null;
const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

// ═══════════════════════════════════════════════════════════════
// 組 report.md
// ═══════════════════════════════════════════════════════════════
const L = [];
L.push(`# ${project} 測試報告`);
L.push('');
L.push(`**${now}** · 第 ${history.length + 1} 次執行`);
L.push('');

// ─── 前置檢查警告（若有）──────────────────────────────────
if (warnings.length) {
  L.push('## 前置檢查警告');
  L.push('');
  L.push(`共 ${warnings.length} 條警告（來自 run-project.sh 或 precheck）：`);
  L.push('');
  for (const w of warnings) {
    L.push(`- ⚠️  ${w}`);
  }
  L.push('');
}

// ─── 全頁巡檢覆蓋（取代過去的「認證後測試覆蓋」區塊）─────────
// 這是「真的有測到裡面」的關鍵訊號：起點頁進得去、所有同源連結也都進得去
if (!crawl.status) {
  L.push('## 全頁巡檢覆蓋');
  L.push('');
  const total = crawl.visited;
  const ok = crawl.ok;
  const failed = crawl.failed;
  if (failed === 0 && total > 0) {
    L.push(`- ✅ **${ok} / ${total}** 個分頁皆可達（深度 ≤ ${crawl.max_depth}）`);
  } else {
    L.push(`- ⚠ **${ok} / ${total}** 個分頁正常；${failed} 頁失敗（4xx/5xx 或被踢回登入頁）`);
  }
  if (crawl.hit_max_pages) {
    L.push(`- 已達 max_pages=${crawl.max_pages} 上限 → 還有未巡到的頁，調 \`tests.e2e.crawl.max_pages\` 放寬`);
  }
  L.push('');
}

if (authCtx) {
  L.push('## Scope Coverage / Auth');
  L.push('');
  L.push(`- Login mode: **${authCtx.login_mode || 'unknown'}** (LOGIN_REQUIRED=${authCtx.login_required ? 'true' : 'false'}, credentials=${authCtx.has_credentials ? 'present' : 'missing'})`);
  if (authCtx.auto_enabled_login_required) {
    L.push('- LOGIN_REQUIRED was auto-enabled because credentials were provided.');
  }
  if (authDiscovery?.status === 'ok') {
    L.push(`- Auth discovery: **${authDiscovery.okPages}/${authDiscovery.pages.length}** logged-in pages reachable; forms on ${authDiscovery.formPages} pages; buttons/actions on ${authDiscovery.buttonPages} pages.`);
    L.push(`- Same-job Cookie header for non-browser tools: **${authDiscovery.cookieHeaderPresent ? 'available' : 'not available'}**.`);
  } else if (authDiscovery?.status === 'parse-error') {
    L.push(`- Auth discovery parse error: ${authDiscovery.error}`);
  } else {
    L.push('- Auth discovery: no report.');
  }
  L.push('- Browser-authenticated scopes: `e2e`, `monkey` use form login when mode is `form`.');
  L.push('- Auth-discovery scopes: `stress`, `security`/ZAP, `nuclei`, `lighthouse`, `links` can use discovered logged-in URLs and same-job Cookie header when available.');
  L.push('- `api-test` / `auth-test` can use credentials only through API collections; they are separate from browser login.');
  L.push('- `ssl` / `precheck` do not have an application-login concept; TLS is checked before HTTP login exists.');
  L.push('');
  L.push('| Scope | Auth behavior | What it means |');
  L.push('|------|------|------|');
  L.push('| `e2e` | form login when enabled | Smoke checks plus crawl can start after login. |');
  L.push('| `monkey` | form login when enabled | UI interaction fuzzing can run on a logged-in browser page. |');
  L.push('| `stress` | auth discovery when available | k6 hits discovered logged-in paths with the same-job Cookie header. |');
  L.push('| `security` / ZAP | auth discovery when available | ZAP starts from a logged-in URL and injects the same-job Cookie header. |');
  L.push('| `nuclei` | auth discovery when available | Nuclei scans the discovered logged-in URL list with the same-job Cookie header. |');
  L.push('| `lighthouse` | auth discovery when available | Lighthouse audits logged-in pages for performance and accessibility. |');
  L.push('| `links` | auth discovery when available | Lychee checks links discovered from logged-in pages. |');
  L.push('| `ssl` / `precheck` | no app login | TLS and basic reachability only. |');
  L.push('');
}

// ─── 摘要 ────────────────────────────────────────────────
L.push('## 摘要');
L.push('');
L.push('```');

// ①
const sslTrend = (prev?.ssl?.grade && s.grade && s.grade !== 'N/A')
  ? (prev.ssl.grade === s.grade ? '  [=]' : `  [${prev.ssl.grade} → ${s.grade}]`) : '';
L.push(`① SSL/TLS         ${s.status === 'no-report' ? '(無報告)' : `${s.grade}  (${s.score}/100)${sslTrend}`}`);

// ② 靜態分析：URL-only 模式（無 local_path）整段省略 — 沒原始碼就跑不了 PHPStan
const urlOnly = process.env.URL_ONLY === 'true';
if (!urlOnly || ps.status !== 'no-report') {
  if (ps.status === 'no-report') {
    L.push('② 靜態分析        (無報告)');
  } else if (ps.status === 'parse-error') {
    L.push(`② 靜態分析        解析失敗：${ps.error}`);
  } else {
    L.push(`② 靜態分析        ${ps.total} 個錯誤${trend(ps.total, prev?.static)}`);
  }
}

// ③
const zapTotal = (z.High || 0) + (z.Medium || 0) + (z.Low || 0) + (z.Informational || 0);
const prevZapTotal = prev?.zap ? prev.zap.H + prev.zap.M + prev.zap.L + prev.zap.I : null;
if (z.status === 'no-report') {
  L.push('③ 資安掃描        (無報告)');
} else {
  L.push(`③ 資安掃描        H=${z.High} M=${z.Medium} L=${z.Low} I=${z.Informational}${trend(zapTotal, prevZapTotal)}`);
}

// ④
if (k.status === 'no-report') {
  L.push('④ 壓力測試        (無報告)');
} else if (k.status === 'parse-error') {
  L.push(`④ 壓力測試        解析失敗：${k.error}`);
} else {
  const p95 = Math.round(k.p95Ms);
  L.push(`④ 壓力測試        p95=${p95}ms  fail=${k.failedPct.toFixed(2)}%  reqs=${k.totalReqs}${trend(p95, prev?.k6?.p95)}`);
}

// ⑤ API 測試（多身分）
if (api.status === 'no-report') {
  L.push('⑤ API 測試        (無報告／未啟用)');
} else {
  const passLine = api.identities
    .filter(i => i.tests != null)
    .map(i => `${i.identity}: ${i.tests - i.failures}/${i.tests}`)
    .join('  ');
  L.push(`⑤ API 測試        ${passLine}${trend(api.totalFails, prev?.api?.totalFails)}`);
}

// ⑥ E2E：URL-only 模式下用 pipeline 內建泛用 spec（smoke + 安全標頭 + 登入驗證），
// 所以即使無 local_path 也會有報告 → 一律顯示
if (pw.status === 'no-report') {
  L.push('⑥ E2E             (無報告)');
} else if (pw.status === 'parse-error') {
  L.push(`⑥ E2E             解析失敗：${pw.error}`);
} else {
  const pass = pw.tests - pw.failures;
  L.push(`⑥ E2E             ${pass}/${pw.tests} pass${trend(pw.failures, prev?.e2e?.failures)}`);
}

// ⑦ Nuclei
const nuTotal = nu.status ? null : (nu.total ?? 0);
if (nu.status === 'no-report') {
  L.push('⑦ 深層資安        (無報告)');
} else if (nu.status === 'parse-error') {
  L.push(`⑦ 深層資安        解析失敗：${nu.error}`);
} else {
  L.push(`⑦ 深層資安        C=${nu.critical} H=${nu.high} M=${nu.medium} L=${nu.low}${trend(nuTotal, prev?.nuclei?.total)}`);
}

// ⑧ Lighthouse
if (lh.status === 'no-report') {
  L.push('⑧ 前端品質        (無報告)');
} else if (lh.status === 'parse-error') {
  L.push(`⑧ 前端品質        解析失敗：${lh.error}`);
} else {
  L.push(`⑧ 前端品質        Perf=${lh.avg.performance} A11y=${lh.avg.accessibility} BP=${lh.avg.best_practices} SEO=${lh.avg.seo}${trend(lh.avg.performance, prev?.lighthouse?.perf, false)}`);
}

// ⑨ Monkey
if (mk.status === 'no-report') {
  L.push('⑨ 互動探測        (無報告)');
} else if (mk.status === 'parse-error') {
  L.push(`⑨ 互動探測        解析失敗：${mk.error}`);
} else {
  const pass = mk.tests - mk.failures;
  L.push(`⑨ 互動探測        ${pass}/${mk.tests} pass${trend(mk.failures, prev?.monkey?.failures)}`);
}

// ⑩ Trivy：URL-only 模式整段省略 — 需要本地原始碼樹掃 lockfile/Dockerfile
const tvTotal = tv.status ? null : (tv.total + (tv.secrets?.length || 0) + (tv.misconfigs?.length || 0));
if (!urlOnly || tv.status !== 'no-report') {
  if (tv.status === 'no-report') {
    L.push('⑩ 供應鏈          (未啟用)');
  } else if (tv.status === 'parse-error') {
    L.push(`⑩ 供應鏈          解析失敗：${tv.error}`);
  } else {
    const secCnt = tv.secrets?.length || 0;
    const misCnt = tv.misconfigs?.length || 0;
    L.push(`⑩ 供應鏈          C=${tv.CRITICAL} H=${tv.HIGH} M=${tv.MEDIUM}  secrets=${secCnt}  misconfig=${misCnt}${trend(tvTotal, prev?.trivy?.total)}`);
  }
}

// ⑪ Lychee
if (lc.status === 'no-report') {
  L.push('⑪ 連結檢查        (無報告)');
} else if (lc.status === 'parse-error') {
  L.push(`⑪ 連結檢查        解析失敗：${lc.error}`);
} else {
  L.push(`⑪ 連結檢查        ${lc.total - lc.errors}/${lc.total} OK  broken=${lc.errors}${trend(lc.errors, prev?.links?.errors)}`);
}

// ⑫ Crawl 全頁巡檢
if (crawl.status === 'no-report') {
  L.push('⑫ 全頁巡檢        (無報告)');
} else if (crawl.status === 'parse-error') {
  L.push(`⑫ 全頁巡檢        解析失敗：${crawl.error}`);
} else {
  const trendStr = trend(crawl.failed, prev?.crawl?.failed);
  L.push(`⑫ 全頁巡檢        ${crawl.ok}/${crawl.visited} 可達  fail=${crawl.failed}${trendStr}`);
}

L.push('```');
L.push('');

// ─── 登入狀態（若有跑 monkey 或 e2e）─────────────────────
// login.ts 在 container 內寫到 /reports/login-status.json，host 端就在 raw/login-status.json
const loginStatusPath = path.join(RAW, 'login-status.json');
if (fs.existsSync(loginStatusPath)) {
  try {
    const ls = JSON.parse(read(loginStatusPath));
    const r = ls.result || {};
    const sc = ls.scenario || {};
    L.push('## 登入狀態');
    L.push('');
    if (r.success) {
      L.push(`- ✅ 登入成功（模式：**${sc.mode}**）`);
      if (r.finalUrl) L.push(`- 最終 URL：\`${r.finalUrl}\``);
    } else {
      L.push(`- ⚠️ 登入未成功 — 不影響後續測試，但**已登入後才能看到的內容掃不到**`);
      L.push('');
      L.push('**情境**');
      L.push(`- 目標 URL：\`${sc.targetUrl || '(未提供)'}\``);
      L.push(`- 模式：**${sc.mode}**（captured_state=${sc.hasCapturedState ? '有' : '無'}，帳密=${sc.hasCreds ? '有' : '無'}）`);
      if (sc.landingUrl) L.push(`- 訪問後 landing URL：\`${sc.landingUrl}\``);
      L.push('');
      L.push('**動作**');
      for (const a of (ls.actions || [])) L.push(`- ${a}`);
      L.push('');
      L.push('**回報**');
      L.push(`- 是否嘗試登入：${r.attempted ? '是' : '否（前置條件不足）'}`);
      L.push(`- 失敗原因：${r.reason}`);
      if (r.finalUrl) L.push(`- 最終 URL：\`${r.finalUrl}\``);
      L.push('');
      L.push('**建議**');
      if (sc.mode === 'form') {
      } else {
        L.push('- 目前是匿名模式，未提供帳密也未提供帳密 — 若需要登入後才能看到的測試覆蓋，請補上其中一個');
      }
    }
    L.push('');
  } catch (e) {
    L.push('## 登入狀態');
    L.push('');
    L.push(`- 解析 \`raw/login-status.json\` 失敗：${e.message}`);
    L.push('');
  }
}

// ─── 詳細 ────────────────────────────────────────────────
L.push('## 詳細');
L.push('');

// ① SSL
if (s.status !== 'no-report') {
  L.push('### ① SSL/TLS (testssl.sh)');
  L.push('');
  L.push(`- Grade：**${s.grade}**  |  Score：**${s.score}/100**`);
  L.push(`- 原始報告：[\`raw/${s.file}\`](raw/${s.file})`);
  L.push('');
}

// ② PHPStan
if (!ps.status && ps.files?.length) {
  L.push(`### ② 靜態分析 PHPStan (${ps.total} errors)`);
  L.push('');
  for (const f of ps.files) {
    L.push(`**${f.relative}** (${f.errors})`);
    L.push('');
    for (const m of f.messages) {
      L.push(`- L${m.line}  ${m.message}`);
    }
    L.push('');
  }
} else if (!ps.status && ps.total === 0) {
  L.push('### ② 靜態分析 PHPStan');
  L.push('');
  L.push('無錯誤 🎉');
  L.push('');
}

// ③ ZAP
if (z.status !== 'no-report' && zapTotal > 0) {
  L.push(`### ③ 資安掃描 OWASP ZAP (${zapTotal} 警告)`);
  L.push('');
  if (z.alerts?.length) {
    const byLevel = { High: [], Medium: [], Low: [], Informational: [] };
    for (const a of z.alerts) byLevel[a.level]?.push(a);
    for (const lvl of ['High', 'Medium', 'Low', 'Informational']) {
      if (!byLevel[lvl].length) continue;
      L.push(`**${lvl} (${byLevel[lvl].length})**`);
      L.push('');
      for (const a of byLevel[lvl]) {
        L.push(`- ${a.name}${a.cwe ? ` (CWE-${a.cwe})` : ''}  —  \`${a.url}\``);
      }
      L.push('');
    }
  } else {
    L.push('（詳細警告需 `raw/zap-report.json`；目前只解析到計數）');
    L.push('');
  }
}

// ④ k6
if (!k.status) {
  L.push('### ④ 壓力測試 k6');
  L.push('');
  L.push(`- 總請求：${k.totalReqs}`);
  L.push(`- avg：${Math.round(k.avgMs)}ms  |  p95：${Math.round(k.p95Ms)}ms`);
  L.push(`- 失敗率：${k.failedPct.toFixed(2)}%`);
  L.push('');
  if (k.journeys?.length) {
    L.push('**Per-journey 指標**');
    L.push('');
    L.push('| Journey | reqs | avg | p95 | failed |');
    L.push('|---------|----:|----:|----:|-------:|');
    for (const j of k.journeys) {
      const avg = j.avgMs != null ? `${Math.round(j.avgMs)}ms` : '—';
      const p95 = j.p95Ms != null ? `${Math.round(j.p95Ms)}ms` : '—';
      const fp = j.failedPct != null ? `${j.failedPct.toFixed(2)}%` : '—';
      L.push(`| \`${j.name}\` | ${j.reqs ?? '—'} | ${avg} | ${p95} | ${fp} |`);
    }
    L.push('');
  }
}

// ⑤ API 測試
if (api.status !== 'no-report' && api.identities?.length) {
  L.push(`### ⑤ API 測試 Newman (${api.identities.length} 身分, ${api.total - api.totalFails}/${api.total} pass)`);
  L.push('');
  for (const id of api.identities) {
    if (id.status === 'parse-error') {
      L.push(`- **${id.identity}**：解析失敗 — ${id.error}`);
      continue;
    }
    L.push(`**${id.identity}** — ${id.tests - id.failures}/${id.tests} pass${id.failures ? `, ${id.failures} fail` : ''}`);
    L.push('');
    if (id.fails?.length) {
      for (const f of id.fails) {
        L.push(`- ❌ ${f.test}${f.message ? `  —  ${f.message}` : ''}`);
      }
      L.push('');
    }
    L.push(`- 原始報告：[\`raw/newman-junit-${id.identity}.xml\`](raw/newman-junit-${id.identity}.xml)`);
    L.push('');
  }
}

// ⑥ Playwright failures
if (!pw.status) {
  L.push('### ⑥ E2E Playwright');
  L.push('');
  L.push(`- ${pw.tests} tests, ${pw.tests - pw.failures} pass, ${pw.failures} fail`);
  if (pw.fails.length) {
    L.push('');
    L.push('**失敗：**');
    L.push('');
    for (const f of pw.fails) {
      L.push(`- \`${f.test}\` — ${f.message}`);
    }
  }
  L.push('');
}

// ⑦ Nuclei findings
if (!nu.status && nu.total > 0) {
  L.push(`### ⑦ 深層資安 Nuclei (${nu.total} findings)`);
  L.push('');
  const byLvl = { critical: [], high: [], medium: [], low: [], info: [], unknown: [] };
  for (const f of nu.findings) (byLvl[f.severity] || byLvl.unknown).push(f);
  for (const lvl of ['critical', 'high', 'medium', 'low']) {
    if (!byLvl[lvl].length) continue;
    L.push(`**${lvl.toUpperCase()} (${byLvl[lvl].length})**`);
    L.push('');
    for (const f of byLvl[lvl].slice(0, 20)) {
      L.push(`- ${f.name}  —  \`${f.templateId}\`  —  \`${f.url}\``);
    }
    if (byLvl[lvl].length > 20) L.push(`- _（餘 ${byLvl[lvl].length - 20} 筆見 raw/nuclei.jsonl）_`);
    L.push('');
  }
}

// ⑧ Lighthouse per-page
if (!lh.status) {
  L.push('### ⑧ 前端品質 Lighthouse');
  L.push('');
  L.push('| 頁面 | Auth | Perf | A11y | BP | SEO | LCP | CLS | TBT |');
  L.push('|------|:----:|:----:|:----:|:--:|:---:|----:|----:|----:|');
  for (const pg of lh.pages) {
    const relPath = (() => {
      try { return new URL(pg.url).pathname; } catch { return pg.url; }
    })();
    const auth = pg.auth ? '🔒' : '';
    const lcp = pg.metrics?.lcp_ms != null ? `${Math.round(pg.metrics.lcp_ms)}ms` : '—';
    const cls = pg.metrics?.cls != null ? pg.metrics.cls.toFixed(3) : '—';
    const tbt = pg.metrics?.tbt_ms != null ? `${Math.round(pg.metrics.tbt_ms)}ms` : '—';
    L.push(`| \`${relPath}\` | ${auth} | ${pg.scores.performance} | ${pg.scores.accessibility} | ${pg.scores.best_practices} | ${pg.scores.seo} | ${lcp} | ${cls} | ${tbt} |`);
  }
  L.push('');
  L.push(`平均：Perf=${lh.avg.performance} · A11y=${lh.avg.accessibility} · BP=${lh.avg.best_practices} · SEO=${lh.avg.seo}`);
  if (lh.pages.some(p => p.auth)) {
    L.push('');
    L.push('🔒 = 該頁帶 cookie 載入（需登入態）；分數低於匿名頁多半反映後台真實 perf。');
  }
  L.push('');
}

// ⑨ Monkey failures
if (!mk.status) {
  L.push('### ⑨ 互動探測 Monkey (Gremlins.js)');
  L.push('');
  L.push(`- ${mk.tests} tests, ${mk.tests - mk.failures} pass, ${mk.failures} fail`);
  if (mk.errors.length) {
    L.push('');
    L.push('**失敗：**');
    L.push('');
    for (const e of mk.errors) {
      L.push(`- \`${e.test}\` — ${e.message}`);
    }
  }
  L.push('');
  L.push(`HTML 報告：[\`raw/monkey-html/index.html\`](raw/monkey-html/index.html)`);
  L.push('');
}

// ⑩ Trivy findings
if (!tv.status && (tv.vulns.length + tv.secrets.length + tv.misconfigs.length) > 0) {
  L.push(`### ⑩ 供應鏈 Trivy (${tv.vulns.length} vulns, ${tv.secrets.length} secrets, ${tv.misconfigs.length} misconfig)`);
  L.push('');
  if (tv.vulns.length) {
    const byLvl = { CRITICAL: [], HIGH: [], MEDIUM: [], LOW: [], UNKNOWN: [] };
    for (const v of tv.vulns) (byLvl[v.severity] || byLvl.UNKNOWN).push(v);
    for (const lvl of ['CRITICAL', 'HIGH', 'MEDIUM']) {
      if (!byLvl[lvl].length) continue;
      L.push(`**${lvl} (${byLvl[lvl].length})**`);
      L.push('');
      for (const v of byLvl[lvl].slice(0, 15)) {
        const fix = v.fixed ? ` → fixed in \`${v.fixed}\`` : '';
        L.push(`- \`${v.pkg}@${v.installed}\` — ${v.id}${fix}  \`${v.target}\``);
      }
      if (byLvl[lvl].length > 15) L.push(`- _（餘 ${byLvl[lvl].length - 15} 筆見 raw/trivy-fs.json）_`);
      L.push('');
    }
  }
  if (tv.secrets.length) {
    L.push(`**Secrets (${tv.secrets.length})**`);
    L.push('');
    for (const s of tv.secrets.slice(0, 10)) {
      L.push(`- \`${s.target}\`:L${s.line} — ${s.title}`);
    }
    L.push('');
  }
  if (tv.misconfigs.length) {
    L.push(`**Misconfig (${tv.misconfigs.length})**`);
    L.push('');
    for (const m of tv.misconfigs.slice(0, 10)) {
      L.push(`- [${m.severity}] ${m.id} — ${m.title}  \`${m.target}\``);
    }
    L.push('');
  }
}

// ⑪ Lychee broken links
if (!lc.status && lc.broken.length > 0) {
  L.push(`### ⑪ 連結檢查 Lychee (${lc.broken.length} broken / ${lc.total} total)`);
  L.push('');
  for (const b of lc.broken.slice(0, 30)) {
    L.push(`- [${b.status}] \`${b.url}\`  ← from \`${b.source}\``);
  }
  if (lc.broken.length > 30) L.push(`- _（餘 ${lc.broken.length - 30} 筆見 raw/lychee.json）_`);
  L.push('');
}

// ⑫ E2E 全頁巡檢
if (!crawl.status && crawl.pages.length) {
  L.push(`### ⑫ 全頁巡檢 Crawl (${crawl.ok}/${crawl.visited} 通過)`);
  L.push('');
  L.push('| 路徑 | 深度 | 狀態 | 載入 (ms) | 連結數 | 結果 |');
  L.push('|------|:----:|:----:|---------:|------:|:----:|');
  for (const p of crawl.pages.slice(0, 100)) {
    let pathOnly = p.url;
    try { pathOnly = new URL(p.url).pathname + (new URL(p.url).search || ''); } catch {}
    const verdict = p.redirectedToLogin
      ? '⚠ 踢回登入'
      : p.ok ? '✓' : '✗';
    L.push(`| \`${pathOnly}\` | ${p.depth} | ${p.status || '—'} | ${p.load_ms ?? '—'} | ${p.links_found ?? 0} | ${verdict} |`);
  }
  if (crawl.pages.length > 100) {
    L.push(`- _（餘 ${crawl.pages.length - 100} 筆見 raw/crawl-report.json）_`);
  }
  L.push('');
  if (crawl.failures.length) {
    L.push('**失敗詳情：**');
    L.push('');
    for (const f of crawl.failures.slice(0, 30)) {
      const msg = f.redirectedToLogin
        ? `被踢回登入頁（final=${f.finalUrl}）`
        : `HTTP ${f.status}${f.jsErrors?.length ? `；${f.jsErrors.length} JS 錯誤` : ''}`;
      L.push(`- \`${f.url}\` ← from \`${f.from}\` — ${msg}`);
    }
    L.push('');
  }
}

// ─── 歷史 ────────────────────────────────────────────────
L.push('## 最近執行');
L.push('');
L.push('```');
const entry = {
  ts: new Date().toISOString(),
  ssl: s.status === 'no-report' ? null : { grade: s.grade, score: parseInt(s.score, 10) || null },
  static: ps.status ? null : (ps.total ?? null),
  zap: z.status === 'no-report' ? null : { H: z.High, M: z.Medium, L: z.Low, I: z.Informational },
  k6: k.status ? null : {
    p95: Math.round(k.p95Ms),
    fail: +k.failedPct.toFixed(2),
    reqs: k.totalReqs,
    journeys: (k.journeys || []).length,
  },
  e2e: pw.status ? null : { tests: pw.tests, failures: pw.failures },
  api: api.status ? null : {
    identities: api.identities.length, total: api.total, totalFails: api.totalFails,
  },
  nuclei: nu.status ? null : {
    total: nu.total, critical: nu.critical, high: nu.high, medium: nu.medium, low: nu.low,
  },
  lighthouse: lh.status ? null : {
    perf: lh.avg.performance, a11y: lh.avg.accessibility,
    bp: lh.avg.best_practices, seo: lh.avg.seo,
  },
  monkey: mk.status ? null : { tests: mk.tests, failures: mk.failures },
  trivy: tv.status ? null : {
    total: tv.total, critical: tv.CRITICAL, high: tv.HIGH, medium: tv.MEDIUM,
    secrets: tv.secrets.length, misconfigs: tv.misconfigs.length,
  },
  links: lc.status ? null : { total: lc.total, errors: lc.errors },
  crawl: crawl.status ? null : {
    visited: crawl.visited, ok: crawl.ok, failed: crawl.failed,
    hit_max_pages: crawl.hit_max_pages,
  },
};
const recent = history.slice(-4).concat([entry]);
for (const e of recent) {
  const t = new Date(e.ts).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei', hour12: false,
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).replace(/,/, '');
  const ssl = e.ssl?.grade ?? '—';
  const st = e.static != null ? `${e.static}e` : '—';
  const zap = e.zap ? `${e.zap.H}H/${e.zap.M}M/${e.zap.L}L` : '—';
  const k6 = e.k6 ? `${e.k6.p95}ms` : '—';
  const mark = e === entry ? '▶' : ' ';
  L.push(`${mark} ${t}  SSL=${ssl}  PHPStan=${st}  ZAP=${zap}  k6=${k6}`);
}
L.push('```');
L.push('');
L.push(`累計 **${history.length + 1}** 次執行（▶ 為本次）`);
L.push('');
L.push('## 原始輸出');
L.push('');
L.push('所有工具原始輸出於 [`raw/`](raw/)：');
L.push('');
L.push('| 檔案 | 用途 |');
L.push('|------|------|');
L.push('| `raw/testssl.html/.json` | SSL 詳細 |');
L.push('| `raw/phpstan.json` | PHPStan 原始 JSON |');
L.push('| `raw/zap-report.html/.json` | ZAP 完整報告 |');
L.push('| `raw/k6-summary.json` | k6 metrics |');
L.push('| `raw/newman-junit-*.xml` | API 測試（每身分一份）|');
L.push('| `raw/playwright/index.html` | Playwright HTML 報告 |');
L.push('| `raw/nuclei.jsonl` | Nuclei findings（JSONL）|');
L.push('| `raw/lighthouse-manifest.json` `raw/lighthouse-*.report.html` | Lighthouse 摘要 + 每頁 HTML |');
L.push('| `raw/monkey-report.json` `raw/monkey-html/index.html` | Monkey (Gremlins) JSON + HTML |');
L.push('| `raw/trivy-fs.json` | Trivy 供應鏈掃描 |');
L.push('| `raw/lychee.json` | Lychee 壞連結清單 |');
L.push('| `raw/crawl-report.json` | E2E 全頁巡檢：每個分頁的可達狀態 / JS 錯誤 / 載入時間 |');
L.push('| `raw/auth-discovery.json` `raw/auth-urls.txt` | 登入後黑箱探索結果，供壓測、ZAP、Nuclei、Lighthouse、Lychee 使用 |');
L.push('');

// ─── 寫檔 ────────────────────────────────────────────────
appendHistory(entry);
const out = L.join('\n');
fs.writeFileSync(path.join(REPORT_DIR, 'report.md'), out);

const structured = {
  project,
  timestamp: now,
  run_count: history.length + 1,
  warnings,
  auth_context: authCtx,
  ssl: s.status ? { status: s.status } : { grade: s.grade, score: parseInt(s.score, 10) || null },
  static: ps.status ? { status: ps.status } : {
    errors: ps.total,
    files: ps.files.map(f => ({ path: f.relative, errors: f.errors, messages: f.messages })),
  },
  security: z.status ? { status: z.status } : {
    high: z.High, medium: z.Medium, low: z.Low, info: z.Informational, alerts: z.alerts || [],
  },
  stress: k.status ? { status: k.status } : {
    p95_ms: Math.round(k.p95Ms),
    avg_ms: Math.round(k.avgMs),
    failed_pct: +k.failedPct.toFixed(2),
    total_reqs: k.totalReqs,
    journeys: k.journeys || [],
  },
  e2e: pw.status ? { status: pw.status } : {
    tests: pw.tests, failures: pw.failures, fails: pw.fails,
  },
  api: api.status ? { status: api.status } : {
    identities: api.identities,
    total: api.total,
    total_failures: api.totalFails,
  },
  nuclei: nu.status ? { status: nu.status } : {
    total: nu.total, critical: nu.critical, high: nu.high,
    medium: nu.medium, low: nu.low, info: nu.info,
    findings: nu.findings,
  },
  lighthouse: lh.status ? { status: lh.status } : {
    avg: lh.avg,
    pages: lh.pages,
  },
  monkey: mk.status ? { status: mk.status } : {
    tests: mk.tests, failures: mk.failures, errors: mk.errors,
  },
  trivy: tv.status ? { status: tv.status } : {
    total: tv.total, critical: tv.CRITICAL, high: tv.HIGH, medium: tv.MEDIUM,
    low: tv.LOW, unknown: tv.UNKNOWN,
    vulns: tv.vulns, secrets: tv.secrets, misconfigs: tv.misconfigs,
  },
  links: lc.status ? { status: lc.status } : {
    total: lc.total, successful: lc.successful, errors: lc.errors,
    timeouts: lc.timeouts, excluded: lc.excluded, broken: lc.broken,
  },
  crawl: crawl.status ? { status: crawl.status } : {
    target: crawl.target,
    visited: crawl.visited,
    ok: crawl.ok,
    failed: crawl.failed,
    hit_max_pages: crawl.hit_max_pages,
    pages: crawl.pages,
  },
  history_recent: history.slice(-4).concat([entry]),
  report_md: path.join(REPORT_DIR, 'report.md'),
  reports_dir: REPORT_DIR,
};
fs.writeFileSync(path.join(REPORT_DIR, 'report.json'), JSON.stringify(structured, null, 2));

// ─── 輸出 ────────────────────────────────────────────────
if (asJson) {
  console.log(JSON.stringify(structured, null, 2));
} else {
  console.log(out);
}
