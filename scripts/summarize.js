#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════
// summarize.js — 產生統一測試報告
//
// 讀取：reports/<project>/raw/ 下的工具原始輸出
// 產出：
//   - reports/<project>/report.md    ← 人類可讀（摘要 + 詳細一檔）
//   - reports/<project>/report.json  ← 結構化（給 n8n 用）
//   - reports/<project>/history.jsonl ← 歷史紀錄（append-only）
//
// 用法：node scripts/summarize.js <project-name> [--json]
// ════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const project = args.find(a => !a.startsWith('--'));
const asJson = args.includes('--json');
if (!project) {
  console.error('用法：node scripts/summarize.js <project-name> [--json]');
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '..');
const REPORT_DIR = path.join(ROOT, 'reports', project);
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
  const files = findRawGlob(/^testssl-.*\.html$/);
  if (!files.length) return { status: 'no-report' };
  const latest = files[files.length - 1];
  const html = read(latest);
  const grade = (html.match(/Overall Grade\s*<\/span>\s*<span[^>]*>([A-F][+\-]?)/) || [])[1] || 'N/A';
  const score = (html.match(/Final Score\s*<\/span>\s*(\d+)/) || [])[1] || 'N/A';
  return { grade, score, file: path.basename(latest) };
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
function parseK6() {
  const p = findRaw('k6-summary.json');
  if (!p) return { status: 'no-report' };
  try {
    const m = JSON.parse(read(p)).metrics || {};
    const pick = (obj, ...keys) => {
      for (const k of keys) if (obj?.[k] != null) return obj[k];
      return null;
    };
    return {
      totalReqs: pick(m.http_reqs, 'count') ?? pick(m.http_reqs?.values || {}, 'count') ?? 0,
      avgMs: pick(m.http_req_duration, 'avg') ?? pick(m.http_req_duration?.values || {}, 'avg') ?? 0,
      p95Ms: pick(m.http_req_duration, 'p(95)') ?? pick(m.http_req_duration?.values || {}, 'p(95)') ?? 0,
      failedPct: ((pick(m.http_req_failed, 'rate') ?? pick(m.http_req_failed?.values || {}, 'rate') ?? 0) * 100),
    };
  } catch (e) { return { status: 'parse-error', error: e.message }; }
}

// 數 testcase 元素（比解析 testsuite 聚合屬性更穩，因為 PHPUnit/Playwright
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

// ─── ⑤ PHPUnit ───────────────────────────────────────────
function parsePHPUnit() {
  const p = findRaw('phpunit.xml');
  if (!p) return { status: 'no-report' };
  try {
    const xml = read(p);
    const { tests, failures, errors } = countJUnit(xml);
    if (tests === 0) return { status: 'parse-error', error: 'no testcases found' };
    let coverage = null;
    const cov = findRaw('phpunit-coverage.txt');
    if (cov) {
      const m2 = read(cov).match(/Lines:\s+(\d+\.\d+)%/);
      if (m2) coverage = parseFloat(m2[1]);
    }
    return { tests, failures, errors, coverage, fails: extractFails(xml, true) };
  } catch (e) { return { status: 'parse-error', error: e.message }; }
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

// ═══════════════════════════════════════════════════════════════
// 解析
// ═══════════════════════════════════════════════════════════════
const s  = parseSSL();
const ps = parsePHPStan();
const z  = parseZAP();
const k  = parseK6();
const u  = parsePHPUnit();
const pw = parsePlaywright();

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

// ─── 摘要 ────────────────────────────────────────────────
L.push('## 摘要');
L.push('');
L.push('```');

// ①
const sslTrend = (prev?.ssl?.grade && s.grade && s.grade !== 'N/A')
  ? (prev.ssl.grade === s.grade ? '  [=]' : `  [${prev.ssl.grade} → ${s.grade}]`) : '';
L.push(`① SSL/TLS         ${s.status === 'no-report' ? '(無報告)' : `${s.grade}  (${s.score}/100)${sslTrend}`}`);

// ②
if (ps.status === 'no-report') {
  L.push('② 靜態分析        (無報告)');
} else if (ps.status === 'parse-error') {
  L.push(`② 靜態分析        解析失敗：${ps.error}`);
} else {
  L.push(`② 靜態分析        ${ps.total} 個錯誤${trend(ps.total, prev?.static)}`);
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

// ⑤
if (u.status === 'no-report') {
  L.push('⑤ 單元測試        (未啟用)');
} else if (u.status === 'parse-error') {
  L.push(`⑤ 單元測試        解析失敗：${u.error}`);
} else {
  const pass = u.tests - u.failures - u.errors;
  const cov = u.coverage != null ? `, cov=${u.coverage.toFixed(1)}%` : '';
  L.push(`⑤ 單元測試        ${pass}/${u.tests} pass${cov}${trend(u.failures + u.errors, prev?.unit ? prev.unit.failures + prev.unit.errors : null)}`);
}

// ⑥
if (pw.status === 'no-report') {
  L.push('⑥ E2E             (未啟用)');
} else if (pw.status === 'parse-error') {
  L.push(`⑥ E2E             解析失敗：${pw.error}`);
} else {
  const pass = pw.tests - pw.failures;
  L.push(`⑥ E2E             ${pass}/${pw.tests} pass${trend(pw.failures, prev?.e2e?.failures)}`);
}

L.push('```');
L.push('');

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
}

// ⑤ PHPUnit failures
if (!u.status) {
  L.push('### ⑤ 單元測試 PHPUnit');
  L.push('');
  L.push(`- ${u.tests} tests, ${u.tests - u.failures - u.errors} pass, ${u.failures} fail, ${u.errors} error`);
  if (u.coverage != null) L.push(`- 覆蓋率：${u.coverage.toFixed(1)}%`);
  if (u.fails.length) {
    L.push('');
    L.push('**失敗：**');
    L.push('');
    for (const f of u.fails) {
      L.push(`- \`${f.class}::${f.test}\` — ${f.message}`);
    }
  }
  L.push('');
  L.push(`覆蓋率詳細：[\`raw/coverage/index.html\`](raw/coverage/index.html)`);
  L.push('');
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
  },
  unit: u.status ? null : {
    tests: u.tests, failures: u.failures, errors: u.errors, coverage: u.coverage,
  },
  e2e: pw.status ? null : { tests: pw.tests, failures: pw.failures },
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
L.push('| `raw/testssl-*.html/.json` | SSL 詳細 |');
L.push('| `raw/phpstan.json` | PHPStan 原始 JSON |');
L.push('| `raw/zap-report.html/.json` | ZAP 完整報告 |');
L.push('| `raw/k6-summary.json` | k6 metrics |');
L.push('| `raw/phpunit.xml` `raw/coverage/` | PHPUnit JUnit + 覆蓋率 HTML |');
L.push('| `raw/playwright/index.html` | Playwright HTML 報告 |');
L.push('');

// ─── 寫檔 ────────────────────────────────────────────────
appendHistory(entry);
const out = L.join('\n');
fs.writeFileSync(path.join(REPORT_DIR, 'report.md'), out);

const structured = {
  project,
  timestamp: now,
  run_count: history.length + 1,
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
  },
  unit: u.status ? { status: u.status } : {
    tests: u.tests, failures: u.failures, errors: u.errors, coverage: u.coverage, fails: u.fails,
  },
  e2e: pw.status ? { status: pw.status } : {
    tests: pw.tests, failures: pw.failures, fails: pw.fails,
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
