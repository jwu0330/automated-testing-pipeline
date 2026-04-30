#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════
// extract-cookie.js — 把 Playwright storageState 變成 HTTP Cookie 標頭
//
// 為什麼要這個：ZAP / Nuclei / Lychee / k6 / Lighthouse 都只接受 HTTP-level
// 的 Cookie 標頭，但 capture-session 流程產出的是 Playwright storageState
// （含 cookies 陣列、localStorage origins）。這支腳本把符合目標 host 的 cookies
// 拼成 `name1=value1; name2=value2` 字串，run-project.sh 抓 stdout 當 env。
//
// 用法：node extract-cookie.js <target-url> <storage-state-path>
// 找不到檔或 host 不符，輸出空字串、退出 0（讓 caller 用 [ -n "$VAR" ] 判斷）。
// ════════════════════════════════════════════════════════════════
const fs = require('fs');

const targetUrl = process.argv[2];
const storagePath = process.argv[3];

if (!targetUrl || !storagePath) process.exit(0);
if (!fs.existsSync(storagePath)) process.exit(0);

let host;
try { host = new URL(targetUrl).hostname; }
catch { process.exit(0); }

let data;
try { data = JSON.parse(fs.readFileSync(storagePath, 'utf-8')); }
catch { process.exit(0); }

const cookies = (data.cookies || []).filter(c => {
  const d = String(c.domain || '').replace(/^\./, '').toLowerCase();
  if (!d) return false;
  const h = host.toLowerCase();
  return h === d || h.endsWith('.' + d);
});

process.stdout.write(cookies.map(c => `${c.name}=${c.value}`).join('; '));
