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

// ─── 執行歷史 (append-only jsonl) ───────────────────────────
const HISTORY_FILE = path.join(REPORTS, 'run-history.jsonl');

function readHistory() {
  if (!exists(HISTORY_FILE)) return [];
  return read(HISTORY_FILE).trim().split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}
function appendHistory(entry) {
  fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n');
}
// 計算與上次差距；lowerIsBetter=true 代表數字越小越好（error 數等）
function trend(cur, prev, lowerIsBetter = true) {
  if (prev == null || cur == null) return '';
  if (cur === prev) return '  [=]';
  const d = cur - prev;
  const good = lowerIsBetter ? d < 0 : d > 0;
  const arrow = d > 0 ? '↑' : '↓';
  const sign = d > 0 ? '+' : '';
  return `  [${arrow}${sign}${d}${good ? ' 改善' : ' 惡化'}]`;
}
function trendStr(cur, prev) {
  if (prev == null || cur == null) return '';
  if (cur === prev) return '  [=]';
  return `  [前次 ${prev} → 現在 ${cur}]`;
}

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

// ─── 讀取上一次結果（用來顯示趨勢）──────────────────────────
const history = readHistory();
const prev = history.length ? history[history.length - 1] : null;

// ─── 本次結果（寫入歷史用）────────────────────────────────
const entry = {
  ts: new Date().toISOString(),
  ssl: s.status === 'no-report' ? null : { grade: s.grade, score: parseInt(s.score, 10) || null },
  static: (ps.status) ? null : (ps.total ?? null),
  zap: z.status === 'no-report' ? null : { H: z.High, M: z.Medium, L: z.Low, I: z.Informational },
  k6: (k.status) ? null : {
    p95: Math.round(k.p95Ms),
    fail: +k.failedPct.toFixed(2),
    reqs: k.totalReqs,
  },
  unit: hasUnit,
  e2e: hasE2E,
};

const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
const lines = [];
lines.push('═══════════════════════════════════════════');
lines.push(`  ${project} 測試評分卡`);
lines.push(`  ${now}`);
lines.push('═══════════════════════════════════════════');
lines.push('');
const sslTrend = (prev?.ssl?.grade && s.grade)
  ? (prev.ssl.grade === s.grade ? '  [=]' : `  [前次 ${prev.ssl.grade} → 現在 ${s.grade}]`) : '';
lines.push(`① SSL/TLS (testssl.sh)     ${s.grade || 'N/A'}  (${s.score || 'N/A'}/100)${sslTrend}`);

if (ps.status === 'no-report') {
  lines.push('② 靜態分析 (PHPStan)         (無報告)');
} else if (ps.status === 'parse-error') {
  lines.push(`② 靜態分析 (PHPStan)         解析失敗：${ps.error}`);
} else {
  lines.push(`② 靜態分析 (PHPStan)         ${ps.total} 個錯誤${trend(ps.total, prev?.static)}`);
  for (const t of ps.top) {
    lines.push(`     ${pad(t.file, 35)} ${t.errors}`);
  }
}

const zapTotal = z.High + z.Medium + z.Low + z.Informational;
const prevZapTotal = prev?.zap ? prev.zap.H + prev.zap.M + prev.zap.L + prev.zap.I : null;
lines.push(`③ 資安掃描 (OWASP ZAP)       High=${z.High}  Medium=${z.Medium}  Low=${z.Low}  Info=${z.Informational}${trend(zapTotal, prevZapTotal)}`);

if (k.status === 'no-report') {
  lines.push('④ 壓力測試 (k6)             (無報告)');
} else {
  const p95 = Math.round(k.p95Ms);
  lines.push(`④ 壓力測試 (k6)             req=${k.totalReqs}  avg=${Math.round(k.avgMs)}ms  p95=${p95}ms  fail=${k.failedPct.toFixed(2)}%${trend(p95, prev?.k6?.p95)}`);
}

lines.push(`⑤ 單元測試 (PHPUnit)         ${hasUnit ? '有報告（JUnit XML）' : '未啟用'}`);
lines.push(`⑥ E2E (Playwright)         ${hasE2E ? '有報告' : '未啟用'}`);

// ─── 最近執行紀錄 ─────────────────────────────────────────
lines.push('');
lines.push('─── 最近執行紀錄（run-history.jsonl）───────────');
const recent = history.slice(-4);  // 不含本次
recent.push(entry);                 // 本次附在最後
for (const e of recent) {
  const t = new Date(e.ts).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei', hour12: false,
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).replace(/,/, '');
  const ssl = e.ssl?.grade ?? '—';
  const st = e.static != null ? `${e.static}e` : '—';
  const zap = e.zap ? `${e.zap.H}H/${e.zap.M}M/${e.zap.L}L` : '—';
  const k6 = e.k6 ? `${e.k6.p95}ms` : '—';
  const mark = e === entry ? '▶' : ' ';
  lines.push(`  ${mark} ${t}  SSL=${ssl}  PHPStan=${st}  ZAP=${zap}  k6=${k6}`);
}
const historyCount = history.length + 1;
lines.push('');
lines.push(`累計 ${historyCount} 次執行（▶ 為本次）`);
lines.push(`報告目錄：${REPORTS}/`);
lines.push(`  • summary.md         — 本次評分卡`);
lines.push(`  • run-history.jsonl  — 全部執行歷史（append-only）`);

// ─── 寫入檔案 ─────────────────────────────────────────────
appendHistory(entry);

const out = lines.join('\n');
fs.writeFileSync(path.join(REPORTS, 'summary.md'), out + '\n');
console.log(out);
