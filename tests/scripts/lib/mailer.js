// ════════════════════════════════════════════════════════════════
// tests/scripts/lib/mailer.js — 共用寄信模組（UI + Skill 共用）
//
// 對外 API：
//   loadDotenv(rootDir)
//     — 讀取 <rootDir>/.env 進 process.env（不覆寫已存在的 key）
//
//   sendEmail({ to, subject, body, attachments? })
//     — 低階 MIME 寄信（curl + SMTP），讀 SMTP_URL/USER/PASS/FROM
//     — attachments: [{ filename, path, contentType }]
//     — 單檔超過 20MB 會被略過，並在 body 末尾說明
//     — 回傳 { ok, skipped?, reason?, code?, error? }
//
//   sendReportEmail({ to, reportDir, targetUrl, scope?, exitCode?, jobId?, archivePath? })
//     — 高階：組信件主旨/內文（讀 report.md）+ 附 reports.tgz
//     — archivePath 沒給就用 tar 即時打包 reportDir
//     — 回傳同 sendEmail
//
// 零 npm 依賴。寄信只靠系統的 `curl`，打包只靠系統的 `tar`。
// ════════════════════════════════════════════════════════════════
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ATTACH_MAX = 20 * 1024 * 1024;  // Gmail 25MB 上限，留 buffer 給 base64 膨脹（×1.37）

function loadDotenv(rootDir) {
  const envFile = path.join(rootDir, '.env');
  if (!fs.existsSync(envFile)) return false;
  const txt = fs.readFileSync(envFile, 'utf8');
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
  return true;
}

function sendEmail({ to, subject, body, attachments = [] }) {
  const smtpUrl = process.env.SMTP_URL;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || smtpUser;
  if (!smtpUrl || !smtpUser || !smtpPass || !from) {
    return Promise.resolve({ ok: false, skipped: true, reason: 'SMTP_URL/USER/PASS 未設定' });
  }
  const date = new Date().toUTCString();
  const msgId = `<${crypto.randomBytes(8).toString('hex')}@atp.local>`;
  const subjB64 = '=?UTF-8?B?' + Buffer.from(subject, 'utf8').toString('base64') + '?=';

  const usable = [];
  const skippedNotes = [];
  for (const a of attachments) {
    try {
      const st = fs.statSync(a.path);
      if (st.size > ATTACH_MAX) {
        skippedNotes.push(`- ${a.filename}（${(st.size / 1048576).toFixed(1)} MB，超過 ${ATTACH_MAX / 1048576} MB 上限）`);
      } else {
        usable.push({ ...a, size: st.size });
      }
    } catch {
      skippedNotes.push(`- ${a.filename}（找不到檔案）`);
    }
  }
  const finalBody = skippedNotes.length
    ? body + `\n\n─── 未附加的檔案 ───\n` + skippedNotes.join('\n')
    : body;

  const baseHeaders = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subjB64}`,
    `Date: ${date}`,
    `Message-ID: ${msgId}`,
    `MIME-Version: 1.0`,
  ];

  let msg;
  if (usable.length === 0) {
    msg = [
      ...baseHeaders,
      `Content-Type: text/plain; charset=utf-8`,
      `Content-Transfer-Encoding: 8bit`,
      ``,
      finalBody,
    ].join('\r\n');
  } else {
    const boundary = '=_atp_' + crypto.randomBytes(12).toString('hex');
    const parts = [
      `--${boundary}`,
      `Content-Type: text/plain; charset=utf-8`,
      `Content-Transfer-Encoding: 8bit`,
      ``,
      finalBody,
    ];
    for (const a of usable) {
      const data = fs.readFileSync(a.path);
      const b64 = data.toString('base64').replace(/(.{76})/g, '$1\r\n');
      parts.push(
        ``,
        `--${boundary}`,
        `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${a.filename}"`,
        `Content-Transfer-Encoding: base64`,
        `Content-Disposition: attachment; filename="${a.filename}"`,
        ``,
        b64,
      );
    }
    parts.push(``, `--${boundary}--`, ``);
    msg = [
      ...baseHeaders,
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      ``,
      ...parts,
    ].join('\r\n');
  }

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

// 用系統 tar 把 <reportDir> 打包成 <archivePath>，內含 reports/
function tarReports(reportDir, archivePath) {
  return new Promise((resolve) => {
    const parent = path.dirname(reportDir);
    const base = path.basename(reportDir);  // 通常是 "reports"
    const tar = spawn('tar', ['-czf', archivePath, '-C', parent, base], { stdio: 'ignore' });
    tar.on('error', () => resolve(false));
    tar.on('close', (code) => resolve(code === 0 && fs.existsSync(archivePath)));
  });
}

async function sendReportEmail({ to, reportDir, targetUrl, scope, exitCode, jobId, archivePath }) {
  if (!to) return { ok: false, skipped: true, reason: 'no recipient' };

  // 組 body：開頭 + report.md（截斷 50KB）
  const headerLines = [
    jobId ? `任務：${jobId}` : null,
    typeof exitCode === 'number' ? `結束碼：${exitCode}` : null,
    targetUrl ? `目標：${targetUrl}` : null,
    scope ? `Scope：${scope}` : null,
  ].filter(Boolean);
  let body = headerLines.join('\n') + '\n\n';

  const reportMd = reportDir ? path.join(reportDir, 'report.md') : null;
  try {
    if (reportMd && fs.existsSync(reportMd)) {
      const md = fs.readFileSync(reportMd, 'utf8');
      body += '─── report.md ───\n\n' + (md.length > 50000 ? md.slice(0, 50000) + '\n\n[…內容過長已截斷…]' : md);
    } else {
      body += '（找不到 report.md，請看附件 reports.tgz 的原始輸出。）';
    }
  } catch (e) {
    body += `（讀取 report.md 失敗：${e.message}）`;
  }

  // 準備附件：如果沒給 archivePath 就即時打包到 tmp
  let archive = archivePath;
  let archiveCreatedHere = false;
  if (!archive && reportDir && fs.existsSync(reportDir)) {
    const tmpName = `atp-reports-${jobId || Date.now()}.tgz`;
    archive = path.join(os.tmpdir(), tmpName);
    const ok = await tarReports(reportDir, archive);
    if (!ok) archive = null;
    else archiveCreatedHere = true;
  }
  const attachments = (archive && fs.existsSync(archive))
    ? [{ filename: `reports-${jobId || 'pipeline'}.tgz`, path: archive, contentType: 'application/gzip' }]
    : [];

  const host = (() => { try { return new URL(targetUrl).hostname; } catch { return targetUrl || 'pipeline'; } })();
  const subject = `[ATP] 測試完成 - ${host}` + (typeof exitCode === 'number' ? ` (exit=${exitCode})` : '');

  const result = await sendEmail({ to, subject, body, attachments });

  if (archiveCreatedHere) { try { fs.unlinkSync(archive); } catch {} }
  return result;
}

module.exports = { loadDotenv, sendEmail, sendReportEmail };
