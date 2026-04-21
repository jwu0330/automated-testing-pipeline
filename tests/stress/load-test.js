import http from 'k6/http';
import { check, sleep } from 'k6';

// ═══════════════════════════════════════════════════
// k6 壓力測試 — babydodofun
// ═══════════════════════════════════════════════════

const TARGET = __ENV.TARGET_URL || 'https://xcity.babydodofun.com';

export const options = {
  // 測試階段：逐步增加負載
  stages: [
    { duration: '10s', target: 5 },   // 暖機：5 個虛擬使用者
    { duration: '20s', target: 10 },   // 正常負載
    { duration: '10s', target: 0 },    // 收尾
  ],

  // 效能門檻
  thresholds: {
    http_req_duration: ['p(95)<2000'],  // 95% 請求 < 2 秒
    http_req_failed: ['rate<0.1'],      // 失敗率 < 10%
  },
};

// 要測試的頁面
const PAGES = [
  '/',
  '/login.html',
  '/admin/members.html',
  '/admin/services.html',
];

export default function () {
  for (const page of PAGES) {
    const url = `${TARGET}${page}`;
    const res = http.get(url);

    check(res, {
      [`${page} status 200`]: (r) => r.status === 200,
      [`${page} < 2s`]: (r) => r.timings.duration < 2000,
    });
  }

  sleep(1);
}
