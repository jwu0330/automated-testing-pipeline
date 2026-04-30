#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════
// ui/server.js — 一頁式測試觸發入口（零 npm 依賴）
//
// 用法：
//   node ui/server.js               # 預設 port 8080
//   PORT=3000 node ui/server.js
//
// 行為：
//   - 單人鎖：同時只允許 1 個任務執行（檔案鎖 + PID 探活）
//   - 表單送出 → 註冊暫時專案 → bash tests/scripts/run-project.sh → SSE 串流 log
//   - 跑完把 reports/ 打包成 .tgz 供下載
// ════════════════════════════════════════════════════════════════
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const UI_DIR = __dirname;
const RUNTIME = path.join(UI_DIR, '.runtime');
const JOBS = path.join(RUNTIME, 'jobs');
const LOCK = path.join(RUNTIME, 'lock');

// 共用寄信模組（CLI 也用同一份；保證 UI / Skill 邏輯一致）
const { loadDotenv, sendReportEmail } = require('../tests/scripts/lib/mailer');
loadDotenv(ROOT);

// 共用 session 擷取模組（CLI 也用同一份）
const { captureSession } = require('../tests/scripts/lib/session-capture');

// 預先登入：純 Node HTTP，幫使用者擷取 session（避免他們手動 Cookie-Editor）
const { httpLogin } = require('./lib/http-login');

const PORT = parseInt(process.env.PORT || '8080', 10);
const IS_WIN = process.platform === 'win32';

fs.mkdirSync(JOBS, { recursive: true });

// ─── 平台抽象：Windows host 透過 WSL 跑 bash（docker 在 WSL 裡）───
// 路徑：E:\code\foo\bar  →  /mnt/e/code/foo/bar
const winToWsl = (p) => {
  const m = String(p).match(/^([A-Za-z]):[\\\/]?(.*)$/);
  if (!m) return String(p).replace(/\\/g, '/');
  return `/mnt/${m[1].toLowerCase()}/` + m[2].replace(/\\/g, '/');
};
const bashPath = (p) => IS_WIN ? winToWsl(p) : String(p).replace(/\\/g, '/');
const spawnBash = (scriptPath, args, options) => {
  const sp = bashPath(scriptPath);
  const sa = (args || []).map(a => typeof a === 'string' ? bashPath(a) : a);
  if (IS_WIN) return spawn('wsl', ['-e', 'bash', sp, ...sa], options || {});
  return spawn('bash', [sp, ...sa], options || {});
};

// ─── Docker 健康檢查 + 自動喚醒 ─────────────────────────────
// 在 Windows 上：透過 WSL 呼叫 docker info；失敗就啟動 Docker Desktop
// 在 Linux/macOS：直接 docker info；失敗就回報（不自動啟動，避免誤操作）
function dockerInfo() {
  return new Promise((resolve) => {
    const c = IS_WIN
      ? spawn('wsl', ['-e', 'bash', '-lc', 'docker info >/dev/null 2>&1'])
      : spawn('bash', ['-lc', 'docker info >/dev/null 2>&1']);
    c.on('error', () => resolve(false));
    c.on('close', (code) => resolve(code === 0));
  });
}
function startDockerDesktopWindows() {
  // 不阻塞、直接 detach；幾種常見路徑都試一次
  const candidates = [
    'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
    'C:\\Program Files (x86)\\Docker\\Docker\\Docker Desktop.exe',
  ];
  for (const exe of candidates) {
    if (fs.existsSync(exe)) {
      try {
        spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
        return { ok: true, exe };
      } catch {}
    }
  }
  // 後備：透過 PowerShell 啟動（從 Start Menu 解析）
  try {
    spawn('powershell', ['-NoProfile', '-Command', 'Start-Process "Docker Desktop"'], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true, exe: 'Start-Process Docker Desktop' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
async function ensureDockerReady(writeLog, timeoutMs = 180000) {
  if (await dockerInfo()) {
    writeLog('[ui] docker: ready ✓\n');
    return true;
  }
  writeLog('[ui] docker: not ready, attempting auto-start…\n');
  if (IS_WIN) {
    const r = startDockerDesktopWindows();
    if (!r.ok) {
      writeLog(`[ui] docker: 啟動失敗（${r.error || '找不到 Docker Desktop'}）\n`);
      return false;
    }
    writeLog(`[ui] docker: launched (${r.exe})，等待 daemon 就緒（最長 ${timeoutMs/1000}s）…\n`);
  } else {
    writeLog('[ui] docker: 非 Windows 環境，請手動啟動 docker daemon（systemctl start docker）\n');
    return false;
  }
  const start = Date.now();
  let waited = 0;
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 3000));
    waited += 3;
    if (await dockerInfo()) {
      writeLog(`[ui] docker: ready after ${waited}s ✓\n`);
      return true;
    }
    if (waited % 15 === 0) writeLog(`[ui] docker: still waiting… (${waited}s)\n`);
  }
  writeLog(`[ui] docker: timeout after ${timeoutMs/1000}s\n`);
  return false;
}

// 純靜態檔表
const STATIC = {
  '/':            { file: 'index.html', mime: 'text/html; charset=utf-8' },
  '/index.html':  { file: 'index.html', mime: 'text/html; charset=utf-8' },
  '/style.css':   { file: 'style.css',  mime: 'text/css; charset=utf-8' },
  '/app.js':      { file: 'app.js',     mime: 'application/javascript; charset=utf-8' },
};

const sendJSON = (res, code, obj) => {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
};

const safeName = (host) =>
  'web-' + (host || 'target').replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '').slice(0, 32);

const readLock = () => { try { return JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { return null; } };
const lockAlive = (l) => {
  if (!l || !l.pid) return false;
  try { process.kill(l.pid, 0); return true; } catch { return false; }
};
const clearLock = () => { try { fs.unlinkSync(LOCK); } catch {} };

// ─── Active job 追蹤（為了支援 /api/cancel）─────────────────
// 每個 jobId 對應 { activeChild, projectName, cancelled }；activeChild 在 register / run / tar 三階段切換。
// 取消時：kill 當前 child（process tree）+ kill 屬於這專案的 docker 容器。
// child.on('close') 自然會跑既有 finish() 邏輯，更新 status.json + 清 lock。
const activeJobs = new Map();

// 標準測試容器名（pipeline 各 stage 固定容器名）；取消時批次 kill
const TEST_CONTAINER_NAMES = [
  'testssl-runner', 'zap-scanner', 'nuclei-scanner', 'lighthouse-runner',
  'lychee-runner', 'k6-runner', 'playwright-runner', 'monkey-runner',
  'newman-runner', 'trivy-fs-runner',
];

function killProcessTree(child) {
  if (!child || !child.pid) return;
  try {
    if (IS_WIN) {
      // wsl.exe 的子孫不會收到 Windows signal；用 taskkill /T 殺整棵 windows-side process tree
      spawn('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
    }
  } catch {}
}

function killTestContainers(writeLog) {
  // WSL pkill：把 WSL 裡可能仍在跑的 bash script (run-project.sh / register-project.sh) 殺乾淨
  // 加上 docker kill：被 docker compose run 起來的測試容器，wsl 端 script 死了 docker daemon 還會留容器
  const cmd = [
    "pkill -KILL -f 'tests/scripts/run-project.sh' 2>/dev/null || true",
    "pkill -KILL -f 'tests/scripts/register-project.sh' 2>/dev/null || true",
    `names="${TEST_CONTAINER_NAMES.join(' ')}"`,
    'for n in $names; do docker kill "$n" 2>/dev/null || true; done',
  ].join('; ');
  const proc = IS_WIN
    ? spawn('wsl', ['-e', 'bash', '-lc', cmd], { stdio: 'ignore' })
    : spawn('bash', ['-lc', cmd], { stdio: 'ignore' });
  if (writeLog) {
    proc.on('close', (code) => writeLog(`[ui] kill containers exit=${code}\n`));
  }
}

// ─── 極簡 multipart/form-data 解析（單檔、扁平欄位）─────────
async function parseMultipart(req) {
  const ct = req.headers['content-type'] || '';
  const m = ct.match(/boundary=(.+)$/i);
  if (!m) throw new Error('not multipart');
  const bBuf = Buffer.from('--' + m[1]);
  const MAX = 25 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX) { req.destroy(); reject(new Error('upload too large (>25MB)')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const fields = {};
        const files = {};
        const positions = [];
        for (let p = 0; p <= buf.length - bBuf.length; p++) {
          if (buf[p] === bBuf[0] && buf.slice(p, p + bBuf.length).equals(bBuf)) {
            positions.push(p);
            p += bBuf.length - 1;
          }
        }
        for (let k = 0; k < positions.length - 1; k++) {
          let start = positions[k] + bBuf.length;
          if (buf[start] === 0x0d) start += 2;
          const end = positions[k + 1] - 2;
          if (end <= start) continue;
          const part = buf.slice(start, end);
          let hEnd = -1;
          for (let p = 0; p < part.length - 3; p++) {
            if (part[p] === 0x0d && part[p+1] === 0x0a && part[p+2] === 0x0d && part[p+3] === 0x0a) {
              hEnd = p; break;
            }
          }
          if (hEnd < 0) continue;
          const headers = part.slice(0, hEnd).toString('utf8');
          const body = part.slice(hEnd + 4);
          const dispo = headers.match(/Content-Disposition:[^\r\n]*/i);
          if (!dispo) continue;
          const nameM = dispo[0].match(/name="([^"]*)"/);
          const fileM = dispo[0].match(/filename="([^"]*)"/);
          if (!nameM) continue;
          const name = nameM[1];
          if (fileM && fileM[1]) {
            (files[name] = files[name] || []).push({ filename: fileM[1], data: body });
          } else {
            (fields[name] = fields[name] || []).push(body.toString('utf8'));
          }
        }
        resolve({ fields, files });
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// 寫 .env 用：以單引號包起 + 內部單引號跳脫（避免 source 時被當 shell 指令）
const envQuote = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";

// ─── Job 建立 + spawn 流程 ─────────────────────────────────
// 把使用者貼上的字串轉成 Playwright storageState 格式
// - 貼 Playwright 原生格式：直接驗證後回傳
// - 貼 Cookie-Editor 陣列：包成 storageState（origins 留空，cookies 補預設值）
function normalizeStorageState(raw) {
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (e) { throw new Error('Session 不是合法 JSON：' + e.message); }

  // Playwright storageState
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && (Array.isArray(parsed.cookies) || Array.isArray(parsed.origins))) {
    return {
      cookies: Array.isArray(parsed.cookies) ? parsed.cookies : [],
      origins: Array.isArray(parsed.origins) ? parsed.origins : [],
    };
  }

  // Cookie-Editor 陣列
  if (Array.isArray(parsed)) {
    const cookies = parsed
      .filter(c => c && typeof c === 'object' && c.name)
      .map(c => ({
        name:     String(c.name),
        value:    String(c.value ?? ''),
        domain:   String(c.domain ?? ''),
        path:     String(c.path ?? '/'),
        expires:  typeof c.expirationDate === 'number' ? c.expirationDate : (typeof c.expires === 'number' ? c.expires : -1),
        httpOnly: !!c.httpOnly,
        secure:   !!c.secure,
        sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax',
      }));
    if (cookies.length === 0) throw new Error('Cookie 陣列為空，請確認你在登入目標站之後才執行 Export');
    return { cookies, origins: [] };
  }

  throw new Error('Session 格式無法辨識：應為 Playwright storageState 物件，或 Cookie-Editor 匯出陣列');
}

function createJob({ targetUrl, targetUiUrl, scopes, openapi, storageStateText, email, testers }) {
  const host = (() => { try { return new URL(targetUrl).hostname; } catch { return 'target'; } })();
  const jobId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
  const jobDir = path.join(JOBS, jobId);
  const projectPath = path.join(jobDir, 'project');
  const testingDir = path.join(projectPath, '.testing');
  fs.mkdirSync(testingDir, { recursive: true });

  // bashPath：Windows 上轉成 /mnt/<drive>/... 給 WSL；其他平台轉成 forward-slash
  // 必要原因：(1) docker 安裝在 WSL，必須走 WSL 路徑 (2) yq 寫 YAML 時遇到 \a/\b/\t 會逃逸
  const projectPathBash = bashPath(projectPath);

  // 寫入 testing.yml
  let openapiPath = '';
  if (openapi && openapi.data && openapi.data.length > 0) {
    const ext = ((openapi.filename.match(/\.(yaml|yml|json)$/i) || ['', 'yaml'])[1]).toLowerCase();
    openapiPath = path.join(testingDir, 'api', `openapi.${ext}`);
    fs.mkdirSync(path.dirname(openapiPath), { recursive: true });
    fs.writeFileSync(openapiPath, openapi.data);
  }

  // 2026-04-30：session 流程已預設停用——run-project.sh 不再讀 storage-state.json，
  // 即使這裡寫了也不生效。保留邏輯純粹為了「未來若 LOGIN_REQUIRED 流程恢復」時能直接接回；
  // 目前在隱藏的 input 上設預設空字串，永遠進不來這個分支。
  if (storageStateText && storageStateText.trim().length > 0) {
    try {
      const normalized = normalizeStorageState(storageStateText);
      fs.writeFileSync(path.join(testingDir, 'storage-state.json'), JSON.stringify(normalized));
    } catch (e) {
      // 解析失敗不擋流程；session 已停用，這個檔最後也不會被讀
      console.warn('[server] storage-state 解析失敗（已停用流程，忽略）：', e.message);
    }
  }
  const projectName = safeName(host) + '-' + jobId.slice(0, 10).replace(/[^\w-]/g, '');
  const yml =
`schema_version: 2
project:
  name: ${projectName}
  target_url: ${targetUrl}
  local_path: ""
  php_version: "8.1"
tests: {}
`;
  fs.writeFileSync(path.join(testingDir, 'testing.yml'), yml);

  // 寫 .testing/.env：run-project.sh 會 source 這個檔（line 96-104）
  const envLines = [];
  envLines.push('LOGIN_REQUIRED=true'); // 所有頁面都需登入
  if (targetUiUrl) envLines.push(`TARGET_UI_URL=${envQuote(targetUiUrl)}`);
  // tester1 → ADMIN_*，tester2 → USER1_*
  if (testers[0] && testers[0].user && testers[0].pass) {
    envLines.push(`ADMIN_USERNAME=${envQuote(testers[0].user)}`);
    envLines.push(`ADMIN_PASSWORD=${envQuote(testers[0].pass)}`);
  }
  if (testers[1] && testers[1].user && testers[1].pass) {
    envLines.push(`USER1_USERNAME=${envQuote(testers[1].user)}`);
    envLines.push(`USER1_PASSWORD=${envQuote(testers[1].pass)}`);
  }
  fs.writeFileSync(path.join(testingDir, '.env'), envLines.join('\n') + '\n');

  const logFile = path.join(jobDir, 'run.log');
  const statusFile = path.join(jobDir, 'status.json');
  fs.writeFileSync(logFile, '');
  fs.writeFileSync(statusFile, JSON.stringify({ state: 'running', job_id: jobId, started: Date.now() }));
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, job_id: jobId, started: Date.now() }));

  const scopeArg = scopes.includes('summary') ? scopes.join(',') : scopes.concat(['summary']).join(',');
  const logFd = fs.openSync(logFile, 'a');
  const writeLog = (s) => { try { fs.writeSync(logFd, s); } catch {} };

  writeLog(`[ui] job ${jobId}\n[ui] target=${targetUrl}\n[ui] scopes=${scopeArg}\n[ui] project=${projectName}\n[ui] project_path=${projectPathBash}\n[ui] email=${email || '(none)'}\n[ui] testers=${testers.filter(t => t.user).map(t => t.user).join(',') || '(none)'}\n\n`);

  // 註冊到 activeJobs（讓 /api/cancel 能找到 child）
  activeJobs.set(jobId, { activeChild: null, projectName, cancelled: false });
  const setActiveChild = (c) => { const j = activeJobs.get(jobId); if (j) j.activeChild = c; };

  const finish = (exitCode, archiveName) => {
    try { fs.closeSync(logFd); } catch {}
    const cancelled = !!(activeJobs.get(jobId) || {}).cancelled;
    fs.writeFileSync(statusFile, JSON.stringify({
      state: 'done',
      job_id: jobId,
      project_name: projectName,
      exit_code: cancelled ? -1 : exitCode,
      cancelled,
      archive: archiveName || null,
      ended: Date.now(),
    }));
    // 清 .tmp-reports/<projectName>：資料已經 copy 進 jobDir，原處不再保留
    try { fs.rmSync(path.join(ROOT, '.tmp-reports', projectName), { recursive: true, force: true }); } catch {}
    clearLock();
    activeJobs.delete(jobId);
  };

  // ① 先確保 Docker 就緒，再 register
  const proceed = () => {
  const reg = spawnBash(path.join(ROOT, 'tests', 'scripts', 'register-project.sh'), [projectName, projectPathBash], {
    cwd: ROOT, env: process.env,
  });
  setActiveChild(reg);
  reg.stdout.on('data', d => writeLog(d.toString()));
  reg.stderr.on('data', d => writeLog(d.toString()));
  reg.on('error', (e) => { writeLog(`[ui] register spawn error: ${e.message}\n`); finish(127, null); });
  reg.on('close', (code) => {
    writeLog(`\n[ui] register exit=${code}\n`);
    if (code !== 0) { finish(code, null); return; }

    // ② run-project.sh
    writeLog(`\n[ui] $ bash tests/scripts/run-project.sh ${projectName} ${scopeArg}\n`);
    const child = spawnBash(path.join(ROOT, 'tests', 'scripts', 'run-project.sh'), [projectName, scopeArg], {
      cwd: ROOT, env: process.env,
    });
    setActiveChild(child);
    child.stdout.on('data', d => writeLog(d.toString()));
    child.stderr.on('data', d => writeLog(d.toString()));
    child.on('error', (e) => { writeLog(`[ui] run spawn error: ${e.message}\n`); finish(127, null); });
    child.on('close', (rcode) => {
      writeLog(`\n[ui] run exit=${rcode}\n`);
      // 報告已直接寫到 <jobDir>/project/.testing/reports/（commit 5fd8339）
      const targetReports = path.join(projectPath, '.testing', 'reports');
      if (!fs.existsSync(targetReports)) {
        writeLog(`[ui] (no reports dir at ${targetReports})\n`);
      }
      // ③ tar.gz：把 .testing/reports 壓成 reports.tgz 裡的 reports/
      // Windows 上走 WSL（跟其他 spawnBash 路徑一致），避免原生 tar.exe 處理 Windows 路徑時行為不穩
      const archive = path.join(jobDir, 'reports.tgz');
      let tar;
      if (fs.existsSync(targetReports)) {
        const archiveBash = bashPath(archive);
        const parentBash  = bashPath(path.dirname(targetReports));
        const tarArgv = ['tar', '-czf', archiveBash, '-C', parentBash, 'reports'];
        tar = IS_WIN
          ? spawn('wsl', ['-e', 'bash', '-lc', tarArgv.map(a => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ')])
          : spawn(tarArgv[0], tarArgv.slice(1));
        tar.stdout && tar.stdout.on('data', d => writeLog(d.toString()));
        tar.stderr && tar.stderr.on('data', d => writeLog(`[tar] ${d.toString()}`));
      } else {
        writeLog(`[ui] no reports dir to archive: ${targetReports}\n`);
        tar = { on: (ev, cb) => { if (ev === 'close') setImmediate(() => cb(1)); } };
      }
      const afterArchive = (archiveOk) => {
        // ④ 寄信（若有填 email）— 走共用模組，跟 Skill CLI 同一份
        if (!email) {
          finish(rcode, archiveOk ? 'reports.tgz' : null);
          return;
        }
        sendReportEmail({
          to: email,
          reportDir: targetReports,
          targetUrl,
          scope: scopeArg,
          exitCode: rcode,
          jobId,
          archivePath: archiveOk ? archive : undefined,
        }).then((r) => {
          if (r.skipped)      writeLog(`[ui] email skipped: ${r.reason}\n`);
          else if (r.ok)      writeLog(`[ui] email sent → ${email}\n`);
          else                writeLog(`[ui] email FAILED (curl=${r.code}): ${r.error}\n`);
          finish(rcode, archiveOk ? 'reports.tgz' : null);
        });
      };
      tar.on('error', (e) => { writeLog(`[ui] tar spawn error: ${e.message}\n`); afterArchive(false); });
      tar.on('close', (tcode) => {
        const ok = tcode === 0 && fs.existsSync(archive);
        if (!ok) writeLog(`[ui] tar failed: exit=${tcode}, archive_exists=${fs.existsSync(archive)}\n`);
        afterArchive(ok);
      });
    });
  });
  };
  // 等 Docker 就緒再進入 register/run
  ensureDockerReady(writeLog).then((ok) => {
    if (!ok) {
      writeLog('[ui] aborting: docker not available\n');
      finish(126, null);
      return;
    }
    proceed();
  });

  return jobId;
}

// ─── HTTP server ──────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const pathname = (req.url || '/').split('?')[0];

  // 靜態
  if (req.method === 'GET' && STATIC[pathname]) {
    const { file, mime } = STATIC[pathname];
    fs.readFile(path.join(UI_DIR, file), (err, data) => {
      if (err) { res.writeHead(500); res.end('read error'); return; }
      res.writeHead(200, { 'content-type': mime, 'content-length': data.length });
      res.end(data);
    });
    return;
  }

  // POST /api/run
  if (req.method === 'POST' && pathname === '/api/run') {
    const existing = readLock();
    if (lockAlive(existing)) {
      sendJSON(res, 503, { error: '系統忙碌中，已有任務執行：' + existing.job_id });
      return;
    }
    if (existing) clearLock();

    let parsed;
    try { parsed = await parseMultipart(req); }
    catch (e) { sendJSON(res, 400, { error: '表單解析失敗：' + e.message }); return; }

    const f = parsed.fields;
    const targetUrl   = ((f.target_url      || [''])[0] || '').trim();
    const targetUiUrl = ((f.target_ui_url   || [''])[0] || '').trim();
    const email       = ((f.email           || [''])[0] || '').trim();
    const scopes      = (f.scope || []).map(s => s.trim()).filter(Boolean);
    const testers = [
      { user: ((f.tester1_user || [''])[0] || '').trim(), pass: ((f.tester1_pass || [''])[0] || '').trim() },
      { user: ((f.tester2_user || [''])[0] || '').trim(), pass: ((f.tester2_pass || [''])[0] || '').trim() },
    ];
    if (!/^https?:\/\//i.test(targetUrl)) { sendJSON(res, 400, { error: '請填寫合法的 http(s):// 網址' }); return; }
    if (targetUiUrl && !/^https?:\/\//i.test(targetUiUrl)) { sendJSON(res, 400, { error: '目標 UI 必須是合法的 http(s):// 網址' }); return; }
    if (scopes.length === 0)              { sendJSON(res, 400, { error: '請至少勾選一個測試項目' }); return; }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      sendJSON(res, 400, { error: 'Email 格式不正確' }); return;
    }
    for (const t of testers) {
      if ((t.user && !t.pass) || (!t.user && t.pass)) {
        sendJSON(res, 400, { error: '測試人員帳號與密碼必須成對填寫' }); return;
      }
    }

    const openapi          = (parsed.files.openapi || [])[0];
    const storageStateText = ((f.storage_state_text || [''])[0] || '').trim();
    let jobId;
    try { jobId = createJob({ targetUrl, targetUiUrl, scopes, openapi, storageStateText, email, testers }); }
    catch (e) { sendJSON(res, 400, { error: '無法建立任務：' + e.message }); return; }
    sendJSON(res, 200, { job_id: jobId });
    return;
  }

  // POST /api/prelogin-browser — 跳出 Playwright 控制的瀏覽器視窗，由使用者手動登入
  // 使用者關閉視窗時 Playwright 會把 storageState 存到指定檔，後端讀回來回傳 UI
  // 這條路徑能處理 CAPTCHA / 2FA / SSO，因為實際登入動作是真人在做
  // 共用 backend：tests/scripts/lib/session-capture.js（CLI 走同一份）
  if (req.method === 'POST' && pathname === '/api/prelogin-browser') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(body || '{}'); }
      catch { sendJSON(res, 400, { error: 'JSON 解析失敗' }); return; }
      const loginUrl = String(payload.loginUrl || '').trim();
      const username = String(payload.username || '').trim();
      const password = String(payload.password || '');

      const tmpFile = path.join(os.tmpdir(), `atp-storage-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`);
      const r = await captureSession({
        loginUrl,
        outputPath: tmpFile,
        uiCwd: UI_DIR,
        username: username || undefined,
        password: password || undefined,
      });
      // UI 流程：把 storageState 直接回給前端（前端會 JSON.stringify 進 textarea），
      // 暫存檔不再保留
      try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}

      if (r.ok) {
        sendJSON(res, 200, { ok: true, reason: r.reason, storageState: r.storageState });
        return;
      }
      // 區分錯誤類別給對應 HTTP code（保留原行為：URL 錯 400 / 逾時 504 / 其他 500 / 沒擷到 200）
      if (/合法 http\(s\)/.test(r.reason || ''))            { sendJSON(res, 400, r); return; }
      if (/超過.+未關閉/.test(r.reason || ''))              { sendJSON(res, 504, r); return; }
      if (r.storageState)                                    { sendJSON(res, 200, r); return; }
      sendJSON(res, 500, r);
    });
    return;
  }

  // POST /api/prelogin — 後端模擬登入並擷取 session，回傳 storageState JSON
  // 給 UI 上「自動登入並擷取 session」按鈕用
  if (req.method === 'POST' && pathname === '/api/prelogin') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(body || '{}'); }
      catch { sendJSON(res, 400, { error: 'JSON 解析失敗' }); return; }
      const loginUrl = String(payload.loginUrl || '').trim();
      const username = String(payload.username || '').trim();
      const password = String(payload.password || '');
      if (!/^https?:\/\//i.test(loginUrl)) { sendJSON(res, 400, { error: '需提供合法 http(s) 登入頁 URL' }); return; }
      if (!username || !password) { sendJSON(res, 400, { error: '需提供帳號與密碼' }); return; }
      try {
        const r = await httpLogin({ loginUrl, username, password });
        sendJSON(res, 200, r);
      } catch (e) {
        sendJSON(res, 500, { ok: false, reason: '預先登入流程例外：' + e.message });
      }
    });
    return;
  }

  // POST /api/cancel/:job_id — 取消跑中任務
  // 流程：kill activeChild process tree（taskkill /T /F on Windows）+ pkill bash script + docker kill 測試容器
  // 殺完之後 child 的 on('close') 會自然觸發既有 finish() 邏輯（標 cancelled=true、清 lock）
  const cancelM = pathname.match(/^\/api\/cancel\/([\w.\-]+)$/);
  if (req.method === 'POST' && cancelM) {
    const jobId = cancelM[1];
    const entry = activeJobs.get(jobId);
    if (!entry) { sendJSON(res, 404, { ok: false, error: '任務不存在或已結束' }); return; }
    if (entry.cancelled) { sendJSON(res, 200, { ok: true, alreadyCancelled: true }); return; }
    entry.cancelled = true;
    killProcessTree(entry.activeChild);
    killTestContainers();
    sendJSON(res, 200, { ok: true, jobId, projectName: entry.projectName });
    return;
  }

  // GET /api/logs/:job_id  (SSE)
  const logsM = pathname.match(/^\/api\/logs\/([\w.\-]+)$/);
  if (req.method === 'GET' && logsM) {
    const jobId = logsM[1];
    const jobDir = path.join(JOBS, jobId);
    if (!fs.existsSync(jobDir)) { res.writeHead(404); res.end('no such job'); return; }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const logFile = path.join(jobDir, 'run.log');
    const statusFile = path.join(jobDir, 'status.json');
    let pos = 0;
    let closed = false;

    const sendEvent = (event, dataStr) => {
      const lines = dataStr.split('\n').map(l => 'data: ' + l).join('\n');
      res.write(`event: ${event}\n${lines}\n\n`);
    };

    const tick = () => {
      if (closed) return;
      try {
        const st = fs.statSync(logFile);
        if (st.size > pos) {
          const fd = fs.openSync(logFile, 'r');
          const buf = Buffer.alloc(st.size - pos);
          fs.readSync(fd, buf, 0, buf.length, pos);
          fs.closeSync(fd);
          pos = st.size;
          const text = buf.toString('utf8').replace(/\r/g, '');
          for (const line of text.split('\n')) {
            if (line.length > 0) sendEvent('log', line);
          }
        }
      } catch {}
      try {
        const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
        if (status.state === 'done') {
          closed = true;
          sendEvent('done', JSON.stringify({
            exit_code: status.exit_code,
            cancelled: !!status.cancelled,
            download_url: status.archive ? `/api/download/${jobId}` : null,
          }));
          res.end();
          return;
        }
      } catch {}
      setTimeout(tick, 400);
    };
    tick();
    req.on('close', () => { closed = true; });
    return;
  }

  // GET /api/download/:job_id  — 一次性下載；完成後刪除整個 job 目錄
  const dlM = pathname.match(/^\/api\/download\/([\w.\-]+)$/);
  if (req.method === 'GET' && dlM) {
    const jobId = dlM[1];
    const jobDir = path.join(JOBS, jobId);
    const archive = path.join(jobDir, 'reports.tgz');
    if (!fs.existsSync(archive)) { res.writeHead(404); res.end('archive not ready or already consumed'); return; }
    const stat = fs.statSync(archive);
    res.writeHead(200, {
      'content-type': 'application/gzip',
      'content-length': stat.size,
      'content-disposition': `attachment; filename="reports-${jobId}.tgz"`,
    });
    fs.createReadStream(archive).pipe(res);
    res.on('finish', () => {
      fs.rm(jobDir, { recursive: true, force: true }, (err) => {
        if (err) console.error(`[ui] cleanup failed for ${jobId}: ${err.message}`);
        else console.log(`[ui] job ${jobId} downloaded and purged`);
      });
    });
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`[ui] listening on http://localhost:${PORT}`);
  console.log(`[ui] runtime dir : ${RUNTIME}`);
});
