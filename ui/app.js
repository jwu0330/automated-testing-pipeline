(() => {
  const form = document.getElementById('run-form');
  const submitBtn = document.getElementById('submit-btn');
  const statusEl = document.getElementById('status');
  const panel = document.getElementById('run-panel');
  const summaryEl = document.getElementById('progress-summary');
  const listEl = document.getElementById('progress-list');
  const dlBtn = document.getElementById('download-btn');

  // ─── scope key → 中文顯示名 ───
  const SCOPE_LABELS = {
    ssl:        'SSL / TLS 掃描',
    security:   '漏洞掃描 (ZAP)',
    nuclei:     '漏洞模板掃描 (Nuclei)',
    lighthouse: '效能 / 無障礙 (Lighthouse)',
    links:      '死連結檢查 (Lychee)',
    stress:     '負載測試 (k6)',
    e2e:        '端對端測試 (Playwright)',
    monkey:     'Monkey 隨機點擊',
    'api-test': 'API / Auth 測試',
    summary:    '彙整報告',
  };

  // 從 server log 行偵測對應 scope（match run-project.sh 的 ▶ / ⏭ 標題）
  // 注意先後順序：specific match 要排前面（"E2E Tests" 含 "Tests" 字樣，避免被泛規則誤判）
  const detectScope = (line) => {
    if (/SSL Scan/.test(line))            return 'ssl';
    if (/ZAP/.test(line))                 return 'security';
    if (/Nuclei/.test(line))              return 'nuclei';
    if (/Lighthouse/.test(line))          return 'lighthouse';
    if (/Link Check|Lychee/.test(line))   return 'links';
    if (/Load Test|k6/.test(line))        return 'stress';
    if (/E2E Tests/.test(line))           return 'e2e';
    if (/Monkey|Gremlins/.test(line))     return 'monkey';
    if (/API \/ Auth|Newman/.test(line))  return 'api-test';
    if (/Report - /.test(line))           return 'summary';
    return null;
  };

  const ICONS = { pending: '⏸', running: '▶', done: '✅', skipped: '⏭', failed: '❌' };

  let scopes = [];
  let states = {};
  let downloadUrl = null;

  const setStatus = (msg, kind = '') => {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  };

  const render = () => {
    listEl.innerHTML = '';
    for (const s of scopes) {
      const li = document.createElement('li');
      li.className = states[s];
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = ICONS[states[s]] || '·';
      const text = document.createElement('span');
      text.textContent = SCOPE_LABELS[s] || s;
      li.append(icon, text);
      listEl.appendChild(li);
    }
    const finished = scopes.filter(s => ['done', 'skipped', 'failed'].includes(states[s])).length;
    summaryEl.textContent = `進度 ${finished} / ${scopes.length}`;
  };

  const setState = (scope, state) => {
    if (!scope || !(scope in states)) return;
    states[scope] = state;
    render();
  };

  // ─── 表單送出 ───
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const picked = fd.getAll('scope');
    if (picked.length === 0) { setStatus('請至少勾選一個測試項目', 'error'); return; }

    submitBtn.disabled = true;
    setStatus('送出中…');

    // 重建進度狀態（summary 一定會跑，加進去顯示）
    scopes = picked.includes('summary') ? picked.slice() : picked.concat(['summary']);
    states = {};
    for (const s of scopes) states[s] = 'pending';
    downloadUrl = null;
    dlBtn.disabled = true;
    dlBtn.textContent = '⬇ 下載報告（測試結束後可下載）';
    panel.hidden = false;
    render();

    let res;
    try {
      res = await fetch('/api/run', { method: 'POST', body: fd });
    } catch (err) {
      setStatus('無法連線：' + err.message, 'error');
      submitBtn.disabled = false;
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setStatus(data.error || ('伺服器錯誤 HTTP ' + res.status), 'error');
      submitBtn.disabled = false;
      return;
    }

    setStatus('任務已開始：' + data.job_id);

    let currentRunning = null;
    const es = new EventSource('/api/logs/' + data.job_id);

    es.addEventListener('log', (ev) => {
      const line = ev.data;
      if (line.startsWith('▶')) {
        const scope = detectScope(line);
        if (scope) {
          if (currentRunning && states[currentRunning] === 'running') setState(currentRunning, 'done');
          currentRunning = scope;
          setState(scope, 'running');
        }
      } else if (line.startsWith('⏭')) {
        const scope = detectScope(line);
        if (scope) setState(scope, 'skipped');
      }
    });

    es.addEventListener('done', (ev) => {
      const info = JSON.parse(ev.data);
      es.close();
      submitBtn.disabled = false;
      // 清除剩下的 pending / running
      for (const s of scopes) {
        if (states[s] === 'pending' || states[s] === 'running') {
          states[s] = info.exit_code === 0 ? 'done' : 'failed';
        }
      }
      render();
      if (info.exit_code === 0) setStatus('完成 ✅', 'ok');
      else setStatus('結束碼 ' + info.exit_code + '（部分測試可能失敗，仍可下載報告）', 'error');

      if (info.download_url) {
        downloadUrl = info.download_url;
        dlBtn.disabled = false;
        dlBtn.textContent = '⬇ 下載報告 (zip)';
      } else {
        dlBtn.textContent = '（無報告可下載）';
      }
    });

    es.addEventListener('error', () => {
      es.close();
      submitBtn.disabled = false;
      setStatus('日誌連線中斷', 'error');
    });
  });

  // ─── 下載按鈕：disabled 時不做任何事；ready 時觸發下載 ───
  dlBtn.addEventListener('click', () => {
    if (dlBtn.disabled || !downloadUrl) return;
    window.location.href = downloadUrl;
  });

  // ─── 路徑 A：🪟 跳出 Playwright 視窗手動登入 ───
  const browserBtn  = document.getElementById('prelogin-browser-btn');
  const browserStat = document.getElementById('prelogin-browser-status');
  if (browserBtn) {
    browserBtn.addEventListener('click', async () => {
      const setStat = (msg, cls = '') => {
        browserStat.textContent = msg;
        browserStat.className = 'status' + (cls ? ' ' + cls : '');
      };
      const fd = new FormData(form);
      const loginUrl = (fd.get('target_url') || '').trim();
      if (!loginUrl) { setStat('請先填上方「目標 URL」', 'error'); return; }

      browserBtn.disabled = true;
      setStat('🪟 已要求後端跳出瀏覽器視窗 — 請在跳出的視窗手動登入，登入完成後關閉視窗（最長 5 分鐘）');
      try {
        const res = await fetch('/api/prelogin-browser', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ loginUrl }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) {
          let msg = '✗ 失敗：' + (data.reason || ('HTTP ' + res.status));
          if (data.hint) msg += '\n💡 ' + data.hint;
          if (data.stderr) msg += '\nstderr: ' + data.stderr;
          setStat(msg, 'error');
          return;
        }
        const storageTaEl = document.getElementById('storage_state_text');
        storageTaEl.value = JSON.stringify(data.storageState);
        setStat(`✓ ${data.reason}（已自動填入下方 Session 框）`, 'ok');
      } catch (e) {
        setStat('✗ 連線失敗：' + e.message, 'error');
      } finally {
        browserBtn.disabled = false;
      }
    });
  }

})();
