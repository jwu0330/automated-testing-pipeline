#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════
// summarize.js — 讀取 reports/<project>/ 內各測試結果，產生評分卡
// 用法：node scripts/summarize.js <project-name>
// 輸出：stdout 顯示；同時寫入 reports/<project>/summary.md
// ════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');

const project = process.argv[2];
if (!project) {
  console.error('用法：node scripts/summarize.js <project-name>');
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '..');
const REPORTS = path.join(ROOT, 'reports', project);

if (!fs.existsSync(REPORTS)) {
  console.error(`找不到報告目錄：${REPORTS}`);
  process.exit(1);
}

const exists = p => fs.existsSync(p);
const read = p => fs.readFileSync(p, 'utf-8');
const pad = (s, w) => String(s).padEnd(w);

// ─── ① SSL：從最新的 testssl HTML 抓 grade / score ─────────
function parseSSL() {
  const files = fs.readdirSync(REPORTS).filter(f => /^testssl-.*\.html$/.test(f)).sort();
  if (files.length === 0) return { status: 'no-report' };
  const html = read(path.join(REPORTS, files[files.length - 1]));
  const grade = (html.match(/Overall Grade\s*<\/span>\s*<span[^>]*>([A-F][+\-]?)/) || [])[1] || 'N/A';
  const score = (html.match(/Final Score\s*<\/span>\s*(\d+)/) || [])[1] || 'N/A';
  return { grade, score, file: files[files.length - 1] };
}

// ─── ② PHPStan：JSON totals + 錯誤最多的檔案 ────────────────
function parsePHPStan() {
  const p = path.join(REPORTS, 'phpstan.json');
  if (!exists(p) || fs.statSync(p).size === 0) return { status: 'no-report' };
  try {
    const data = JSON.parse(read(p));
    const total = data.totals?.file_errors ?? 0;
    const files = Object.entries(data.files || {})
      .map(([k, v]) => ({ file: path.basename(k), errors: v.errors ?? 0 }))
      .sort((a, b) => b.errors - a.errors);
    return { total, top: files.slice(0, 5) };
  } catch (e) {
    return { status: 'parse-error', error: e.message };
  }
}

// ─── ③ ZAP：從 HTML Summary of Alerts 區塊抓各風險等級筆數 ───
function parseZAP() {
  const p = path.join(REPORTS, 'zap-report.html');
  if (!exists(p)) return { status: 'no-report' };
  const html = read(p);
  const counts = { High: 0, Medium: 0, Low: 0, Informational: 0 };
  const summary = (html.match(/Summary of Alerts[\s\S]*?(?=<h3|$)/) || [''])[0];
  const rows = summary.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  for (const row of rows) {
    const rm = row.match(/class="risk-(\d)"/);
    const nm = row.match(/<td\s+align="center"[^>]*>\s*<div>(\d+)/);
    if (rm && nm) {
      const level = ['Informational', 'Low', 'Medium', 'High'][parseInt(rm[1], 10)];
      counts[level] += parseInt(nm[1], 10);
    }
  }
  return counts;
}

// ─── ④ k6：JSON metrics ────────────────────────────────────
function parseK6() {
  const p = path.join(REPORTS, 'k6-summary.json');
  if (!exists(p)) return { status: 'no-report' };
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
  } catch (e) {
    return { status: 'parse-error', error: e.message };
  }
}

// ─── 組裝輸出 ───────────────────────────────────────────────
const s = parseSSL();
const ps = parsePHPStan();
const z = parseZAP();
const k = parseK6();
const hasUnit = exists(path.join(REPORTS, 'phpunit.xml'));
const hasE2E = exists(path.join(REPORTS, 'playwright'));

const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
const lines = [];
lines.push('═══════════════════════════════════════════');
lines.push(`  ${project} 測試評分卡`);
lines.push(`  ${now}`);
lines.push('═══════════════════════════════════════════');
lines.push('');
lines.push(`① SSL/TLS (testssl.sh)     ${s.grade || 'N/A'}  (${s.score || 'N/A'}/100)`);

if (ps.status === 'no-report') {
  lines.push('② 靜態分析 (PHPStan)         (無報告)');
} else if (ps.status === 'parse-error') {
  lines.push(`② 靜態分析 (PHPStan)         解析失敗：${ps.error}`);
} else {
  lines.push(`② 靜態分析 (PHPStan)         ${ps.total} 個錯誤`);
  for (const t of ps.top) {
    lines.push(`     ${pad(t.file, 35)} ${t.errors}`);
  }
}

lines.push(`③ 資安掃描 (OWASP ZAP)       High=${z.High}  Medium=${z.Medium}  Low=${z.Low}  Info=${z.Informational}`);

if (k.status === 'no-report') {
  lines.push('④ 壓力測試 (k6)             (無報告)');
} else {
  lines.push(`④ 壓力測試 (k6)             req=${k.totalReqs}  avg=${Math.round(k.avgMs)}ms  p95=${Math.round(k.p95Ms)}ms  fail=${k.failedPct.toFixed(2)}%`);
}

lines.push(`⑤ 單元測試 (PHPUnit)         ${hasUnit ? '有報告（JUnit XML）' : '未啟用'}`);
lines.push(`⑥ E2E (Playwright)         ${hasE2E ? '有報告' : '未啟用'}`);
lines.push('');
lines.push(`報告目錄：${REPORTS}/`);

const out = lines.join('\n');
fs.writeFileSync(path.join(REPORTS, 'summary.md'), out + '\n');
console.log(out);
