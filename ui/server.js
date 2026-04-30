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
//   - 表單送出 → 註冊暫時專案 → bash scripts/run-project.sh → SSE 串流 log
//   - 跑完把 reports/ 打包成 .tgz 供下載
// ════════════════════════════════════════════════════════════════
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const UI_DIR = __dirname;
const RUNTIME = path.join(UI_DIR, '.runtime');
const JOBS = path.join(RUNTIME, 'jobs');
const LOCK = path.join(RUNTIME, 'lock');
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

// ─── 寄信（curl + SMTP；無 SMTP_URL 則跳過）─────────────
function sendEmail({ to, subject, body }) {
  const smtpUrl = process.env.SMTP_URL;     // 例：smtps://smtp.gmail.com:465
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || smtpUser;
  if (!smtpUrl || !smtpUser || !smtpPass || !from) {
    return Promise.resolve({ ok: false, skipped: true, reason: 'SMTP_URL/USER/PASS 未設定' });
  }
  const date = new Date().toUTCString();
  const msgId = `<${crypto.randomBytes(8).toString('hex')}@atp.local>`;
  const subjB64 = '=?UTF-8?B?' + Buffer.from(subject, 'utf8').toString('base64') + '?=';
  const msg = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subjB64}`,
    `Date: ${date}`,
    `Message-ID: ${msgId}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    body,
  ].join('\r\n');
  const tmp = path.join(os.tmpdir(), `atp-mail-${Date.now()}-${crypto.randomBytes(3).toString('hex')}.eml`);
  fs.writeFileSync(tmp, msg, 'utf8');
  return new Promise((resolve) => {
    const c = spawn('curl', [
      '--silent', '--show-error', '--ssl-reqd',
      '--url', smtpUrl,
      '--mail-from', from,
      '--mail-rcpt', to,
      '--user', `${smtpUser}:${smtpPass}`,
      '--upload-file', tmp,
    ]);
    let err = '';
    c.stderr.on('data', d => err += d.toString());
    c.on('error', (e) => { try { fs.unlinkSync(tmp); } catch {} resolve({ ok: false, error: e.message }); });
    c.on('close', (code) => {
      try { fs.unlinkSync(tmp); } catch {}
      resolve({ ok: code === 0, code, error: err.trim() });
    });
  });
}

// 寫 .env 用：以單引號包起 + 內部單引號跳脫（避免 source 時被當 shell 指令）
const envQuote = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";

// ─── Job 建立 + spawn 流程 ─────────────────────────────────
function createJob({ targetUrl, targetUiUrl, scopes, openapi, email, testers }) {
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
  if (envLines.length > 0) {
    fs.writeFileSync(path.join(testingDir, '.env'), envLines.join('\n') + '\n');
  }

  const logFile = path.join(jobDir, 'run.log');
  const statusFile = path.join(jobDir, 'status.json');
  fs.writeFileSync(logFile, '');
  fs.writeFileSync(statusFile, JSON.stringify({ state: 'running', job_id: jobId, started: Date.now() }));
  fs.writeFileSync(LOCK, JSON.stringify({ pid: process.pid, job_id: jobId, started: Date.now() }));

  const scopeArg = scopes.includes('summary') ? scopes.join(',') : scopes.concat(['summary']).join(',');
  const logFd = fs.openSync(logFile, 'a');
  const writeLog = (s) => { try { fs.writeSync(logFd, s); } catch {} };

  writeLog(`[ui] job ${jobId}\n[ui] target=${targetUrl}\n[ui] scopes=${scopeArg}\n[ui] project=${projectName}\n[ui] project_path=${projectPathBash}\n[ui] email=${email || '(none)'}\n[ui] testers=${testers.filter(t => t.user).map(t => t.user).join(',') || '(none)'}\n\n`);

  const finish = (exitCode, archiveName) => {
    try { fs.closeSync(logFd); } catch {}
    fs.writeFileSync(statusFile, JSON.stringify({
      state: 'done',
      job_id: jobId,
      project_name: projectName,
      exit_code: exitCode,
      archive: archiveName || null,
      ended: Date.now(),
    }));
    // 清 .tmp-reports/<projectName>：資料已經 copy 進 jobDir，原處不再保留
    try { fs.rmSync(path.join(ROOT, '.tmp-reports', projectName), { recursive: true, force: true }); } catch {}
    clearLock();
  };

  // ① register-project.sh
  const reg = spawnBash(path.join(ROOT, 'scripts', 'register-project.sh'), [projectName, projectPathBash], {
    cwd: ROOT, env: process.env,
  });
  reg.stdout.on('data', d => writeLog(d.toString()));
  reg.stderr.on('data', d => writeLog(d.toString()));
  reg.on('error', (e) => { writeLog(`[ui] register spawn error: ${e.message}\n`); finish(127, null); });
  reg.on('close', (code) => {
    writeLog(`\n[ui] register exit=${code}\n`);
    if (code !== 0) { finish(code, null); return; }

    // ② run-project.sh
    writeLog(`\n[ui] $ bash scripts/run-project.sh ${projectName} ${scopeArg}\n`);
    const child = spawnBash(path.join(ROOT, 'scripts', 'run-project.sh'), [projectName, scopeArg], {
      cwd: ROOT, env: process.env,
    });
    child.stdout.on('data', d => writeLog(d.toString()));
    child.stderr.on('data', d => writeLog(d.toString()));
    child.on('error', (e) => { writeLog(`[ui] run spawn error: ${e.message}\n`); finish(127, null); });
    child.on('close', (rcode) => {
      writeLog(`\n[ui] run exit=${rcode}\n`);
      // run-project.sh 在 local_path 為空時會寫到 .tmp-reports/<name>/
      const remoteReports = path.join(ROOT, '.tmp-reports', projectName);
      const targetReports = path.join(jobDir, 'reports');
      try {
        if (fs.existsSync(remoteReports)) {
          const cp = (s, d) => {
            const st = fs.statSync(s);
            if (st.isDirectory()) {
              fs.mkdirSync(d, { recursive: true });
              for (const e of fs.readdirSync(s)) cp(path.join(s, e), path.join(d, e));
            } else fs.copyFileSync(s, d);
          };
          cp(remoteReports, targetReports);
          writeLog(`[ui] copied reports → ${targetReports}\n`);
        } else {
          writeLog(`[ui] (no reports dir at ${remoteReports})\n`);
        }
      } catch (e) {
        writeLog(`[ui] copy reports failed: ${e.message}\n`);
      }
      // ③ tar.gz
      const archive = path.join(jobDir, 'reports.tgz');
      const tar = spawn('tar', ['-czf', archive, '-C', jobDir, 'reports'], { stdio: 'ignore' });
      const afterArchive = (archiveOk) => {
        // ④ 寄信（若有填 email）
        if (!email) {
          finish(rcode, archiveOk ? 'reports.tgz' : null);
          return;
        }
        const reportMd = path.join(targetReports, 'report.md');
        let bodySummary = `測試任務 ${jobId} 已完成。\n結束碼：${rcode}\n目標：${targetUrl}\nScope：${scopeArg}\n\n`;
        try {
          if (fs.existsSync(reportMd)) {
            const md = fs.readFileSync(reportMd, 'utf8');
            bodySummary += '─── report.md ───\n\n' + (md.length > 50000 ? md.slice(0, 50000) + '\n\n[…內容過長已截斷…]' : md);
          } else {
            bodySummary += '（找不到 report.md，請從網頁下載 reports.tgz 查看原始輸出。）';
          }
        } catch (e) {
          bodySummary += `（讀取 report.md 失敗：${e.message}）`;
        }
        sendEmail({
          to: email,
          subject: `[ATP] 測試完成 - ${new URL(targetUrl).hostname} (exit=${rcode})`,
          body: bodySummary,
        }).then((r) => {
          if (r.skipped)      writeLog(`[ui] email skipped: ${r.reason}\n`);
          else if (r.ok)      writeLog(`[ui] email sent → ${email}\n`);
          else                writeLog(`[ui] email FAILED (curl=${r.code}): ${r.error}\n`);
          finish(rcode, archiveOk ? 'reports.tgz' : null);
        });
      };
      tar.on('error', () => afterArchive(false));
      tar.on('close', (tcode) => afterArchive(tcode === 0 && fs.existsSync(archive)));
    });
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

    const openapi = (parsed.files.openapi || [])[0];
    let jobId;
    try { jobId = createJob({ targetUrl, targetUiUrl, scopes, openapi, email, testers }); }
    catch (e) { sendJSON(res, 500, { error: '無法建立任務：' + e.message }); return; }
    sendJSON(res, 200, { job_id: jobId });
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
