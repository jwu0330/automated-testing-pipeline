(() => {
  const form = document.getElementById('run-form');
  const submitBtn = document.getElementById('submit-btn');
  const statusEl = document.getElementById('status');
  const panel = document.getElementById('run-panel');
  const logEl = document.getElementById('log');
  const dlEl = document.getElementById('download');

  const setStatus = (msg, kind = '') => {
    statusEl.textContent = msg;
    statusEl.className = 'status' + (kind ? ' ' + kind : '');
  };

  const append = (s) => {
    logEl.textContent += s;
    logEl.scrollTop = logEl.scrollHeight;
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const scopes = fd.getAll('scope');
    if (scopes.length === 0) {
      setStatus('請至少勾選一個測試項目', 'error');
      return;
    }
    submitBtn.disabled = true;
    setStatus('送出中…');
    logEl.textContent = '';
    panel.hidden = false;
    dlEl.hidden = true;

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

    const jobId = data.job_id;
    setStatus('任務已開始：' + jobId);

    const es = new EventSource('/api/logs/' + jobId);
    es.addEventListener('log', (ev) => append(ev.data + '\n'));
    es.addEventListener('done', (ev) => {
      const info = JSON.parse(ev.data);
      es.close();
      submitBtn.disabled = false;
      if (info.exit_code === 0) {
        setStatus('完成 ✅ 結束碼 0', 'ok');
      } else {
        setStatus('結束碼 ' + info.exit_code + '（部分測試可能失敗，仍可下載報告）', 'error');
      }
      if (info.download_url) {
        dlEl.href = info.download_url;
        dlEl.hidden = false;
      }
    });
    es.addEventListener('error', () => {
      es.close();
      submitBtn.disabled = false;
      setStatus('日誌連線中斷', 'error');
    });
  });
})();
