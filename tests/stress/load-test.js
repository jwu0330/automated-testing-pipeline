// ════════════════════════════════════════════════════════════════
// k6 壓力測試 — journey-based
//
// 設計轉變（為什麼）：
//   舊：寫死 4 個 URL 的迴圈 → 後台路徑會 302 到 login，量到的是登入頁
//       的延遲不是真實後台 API。
//   新：吃 testing.yml 的 tests.stress.journeys，每個 journey 自帶
//       weight / auth / steps，VU 依 weight 分到對應 scenario。
// 環境變數：
//   TARGET_URL          必填
//   K6_VUS / K6_DURATION  總 VUs 與時長（預設 10 / 30s）
//   JOURNEYS_JSON       JSON 陣列：[{name, weight, auth, steps:[...]}, ...]
//                       未提供 → 退化為單一匿名 journey 跑首頁
// step 格式：
//   "GET /api/dashboard"
//   "POST /api/orders {\"item_id\":1}"
//   { "method": "POST", "path": "/api/foo", "body": "...", "headers": {...} }
//
// k6 設計細節：
//   k6 的 scenarios[*].exec 只能指向「靜態 export 的 function 名」，
//   無法動態 export。所以這裡用「single default export + 內部 dispatch
//   via exec.scenario.name」的正規做法，每個 journey 對應一個 scenario，
//   全部共用 default 函式查表執行。
// ════════════════════════════════════════════════════════════════
import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';

const TARGET = (__ENV.TARGET_URL || 'https://example.com').replace(/\/$/, '');
const TOTAL_VUS = parseInt(__ENV.K6_VUS || '10', 10);
const DURATION = __ENV.K6_DURATION || '30s';
const AUTH_COOKIE_HEADER = __ENV.AUTH_COOKIE_HEADER || '';

// AUTH_EXTRA_HEADERS：JSON object，例如 {"Authorization":"Bearer xxx","X-Admin-Token":"yyy"}
// 給 token-based 系統用，與 cookie 同步注入
let AUTH_EXTRA_HEADERS = {};
try {
  if (__ENV.AUTH_EXTRA_HEADERS) AUTH_EXTRA_HEADERS = JSON.parse(__ENV.AUTH_EXTRA_HEADERS);
} catch (e) {
  console.error(`AUTH_EXTRA_HEADERS 解析失敗：${e.message}`);
}

// ─── 解析 journeys ────────────────────────────────────────────
function parseJourneys() {
  const raw = __ENV.JOURNEYS_JSON;
  if (!raw) {
    return [{ name: 'anon', weight: 100, auth: false, steps: ['GET /'] }];
  }
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || !arr.length) throw new Error('empty');
    return arr.map((j, i) => ({
      name: (j.name || `journey_${i}`).replace(/[^a-zA-Z0-9_]/g, '_'),
      weight: typeof j.weight === 'number' && j.weight > 0 ? j.weight : 100,
      auth: !!j.auth,
      headers: j.headers || {},
      steps: Array.isArray(j.steps) ? j.steps : [],
    }));
  } catch (e) {
    console.error(`JOURNEYS_JSON 解析失敗：${e.message}; fallback 到 anon /`);
    return [{ name: 'anon', weight: 100, auth: false, steps: ['GET /'] }];
  }
}

const JOURNEYS = parseJourneys();
const TOTAL_WEIGHT = JOURNEYS.reduce((s, j) => s + j.weight, 0) || 1;
// 用陣列查表轉 map，default function 內按 scenario 名取 journey
const JOURNEY_BY_NAME = Object.fromEntries(JOURNEYS.map(j => [j.name, j]));

// ─── scenarios：每個 journey 一條 ramping-vus ────────────────
const scenarios = {};
for (const j of JOURNEYS) {
  const vus = Math.max(1, Math.round(TOTAL_VUS * j.weight / TOTAL_WEIGHT));
  scenarios[j.name] = {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '5s', target: vus },
      { duration: DURATION, target: vus },
      { duration: '5s', target: 0 },
    ],
    // 不設 exec → 預設用 default export；自帶 tag 方便報告分組
    tags: { journey: j.name, auth: String(j.auth) },
  };
}

export const options = {
  scenarios,
  thresholds: {
    http_req_duration: ['p(95)<2000'],
    http_req_failed: ['rate<0.1'],
    // 每個 journey 一個分組門檻（summarize.js 讀 metric tag 分 journey 算）
    ...Object.fromEntries(
      JOURNEYS.map(j => [
        `http_req_duration{journey:${j.name}}`,
        ['p(95)<3000'],
      ])
    ),
  },
};

// ─── step 解析 ───────────────────────────────────────────────
function parseStep(step) {
  if (typeof step === 'object' && step) {
    return {
      method: (step.method || 'GET').toUpperCase(),
      path: step.path || '/',
      body: step.body || null,
      headers: step.headers || {},
    };
  }
  const s = String(step).trim();
  const m = s.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)(?:\s+(.+))?$/i);
  if (!m) return { method: 'GET', path: s, body: null, headers: {} };
  return {
    method: m[1].toUpperCase(),
    path: m[2],
    body: m[3] ? m[3].trim() : null,
    headers: {},
  };
}

export function setup() {
  return {
    journeys: JOURNEYS.map(j => ({ name: j.name, auth: j.auth, steps: j.steps.length, weight: j.weight })),
    target: TARGET,
    cookie_present: !!AUTH_COOKIE_HEADER,
  };
}

export default function () {
  // 每個 VU 啟動時 k6 會把所屬 scenario 名放在 exec.scenario.name
  const sname = exec.scenario.name;
  const journey = JOURNEY_BY_NAME[sname];
  if (!journey) {
    // 不該發生，但留個保險：跑首頁就退出
    const r = http.get(TARGET);
    check(r, { 'fallback status<400': res => res.status > 0 && res.status < 400 });
    sleep(1);
    return;
  }
  const baseHeaders = {
    ...(journey.auth && AUTH_COOKIE_HEADER ? { Cookie: AUTH_COOKIE_HEADER } : {}),
    ...(journey.auth ? AUTH_EXTRA_HEADERS : {}),
    ...(journey.headers || {}),
  };

  for (const rawStep of journey.steps) {
    const { method, path, body, headers } = parseStep(rawStep);
    const url = `${TARGET}${path.startsWith('/') ? path : '/' + path}`;
    const params = {
      headers: { ...baseHeaders, ...headers },
      tags: { name: `${journey.name}:${method} ${path}` },
    };
    let res;
    if (method === 'GET' || method === 'HEAD' || method === 'DELETE') {
      res = http.request(method, url, null, params);
    } else {
      res = http.request(method, url, body || '', params);
    }
    check(res, {
      [`${journey.name}:${path} status<400`]: r => r.status > 0 && r.status < 400,
    });
  }
  sleep(1);
}
