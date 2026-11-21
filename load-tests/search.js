// Search latency baseline (increment 3.7). LOCAL only: run against the compose
// stack with the synthetic performance dataset loaded (see README.md).
//
// Every /search/* route shares one rate-limit bucket of 60 requests a minute
// per IP. This run stays under it (50 a minute) and never spoofs addresses or
// relaxes the limit, so it measures latency at low load, not throughput.
// Samples are classified by the API's own meta.cache_hit, not by scenario.
import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import exec from 'k6/execution';

const BASE = __ENV.BASE_URL || 'http://api:8000/api/v1';
const MINUTES = Number(__ENV.MINUTES || 10);

const doctorsCached = new Trend('search_doctors_cached', true);
const doctorsUncached = new Trend('search_doctors_uncached', true);
const specialtiesCached = new Trend('search_specialties_cached', true);
const specialtiesUncached = new Trend('search_specialties_uncached', true);
const serverTook = new Trend('search_server_took_ms', true);
const health = new Trend('health_endpoint', true);
const rejected = new Counter('rejected_responses'); // 429, non-200, degraded or malformed

const TERMS = ['pediatrician', 'pedia', 'cardiologist', 'heart doctor', 'dermatologist', 'skin doctor', 'ob gyn', 'obstetrician', 'internist',
  'family doctor', 'ent', 'eye doctor', 'orthopedic', 'bone doctor', 'psychiatrist', 'dentist', 'endocrinologist', 'gastroenterologist',
  'pulmonologist', 'neurologist', 'surgeon', 'urologist', 'santos', 'reyes', 'dela cruz', 'bautista', 'garcia', 'mendoza', 'villanueva', 'tan'];
const CITIES = [['Quezon City', 14.676, 121.044], ['Manila', 14.600, 120.984], ['Makati', 14.555, 121.024], ['Pasig', 14.576, 121.085],
  ['Taguig', 14.518, 121.051], ['Mandaluyong', 14.579, 121.036], ['Cebu City', 10.316, 123.885], ['Davao City', 7.191, 125.455],
  ['Iloilo City', 10.720, 122.562], ['Baguio', 16.402, 120.596], ['Bacolod', 10.677, 122.951], ['Antipolo', 14.586, 121.176]];
const MODES = ['', 'IN_PERSON', 'ONLINE'];

// Uncached pool: realistic term x city x mode combinations, each used once per run
// (a fixed shuffle, so runs are comparable). Near-me queries use rounded coordinates.
function uncachedPool() {
  const pool = [];
  for (const t of TERMS) for (const [city] of CITIES) for (const m of MODES) pool.push({ q: t, city, consultation_type: m });
  for (const t of TERMS) for (const [, lat, lng] of CITIES) pool.push({ q: t, lat, lng, radius_km: 25, sort: 'distance' });
  let seed = 37;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool;
}
const UNCACHED = uncachedPool();
// Hot set: the same few searches many patients run; after the first miss they are cache hits.
const HOT = [{ q: 'pedia' }, { q: 'ob gyn', city: 'Makati' }, { q: 'cardiologist', city: 'Quezon City' }, { q: 'dermatologist' }, {}, { city: 'Cebu City' }];
const PREFIXES = ['pe', 'ped', 'pedi', 'ca', 'car', 'card', 'de', 'der', 'ob', 'gy', 'in', 'int', 'fa', 'fam', 'op', 'oph', 'or', 'ort', 'ps', 'psy', 'en', 'ne', 'neu', 'gas', 'pul', 'uro', 'den', 'rad'];

export const options = {
  scenarios: {
    search: { executor: 'constant-arrival-rate', rate: 50, timeUnit: '1m', duration: `${MINUTES}m`, preAllocatedVUs: 2, maxVUs: 4, exec: 'search' },
    // Not throttled by the search bucket: shows the framework's fixed cost on this server.
    health: { executor: 'constant-arrival-rate', rate: 30, timeUnit: '1m', duration: `${MINUTES}m`, preAllocatedVUs: 1, maxVUs: 2, exec: 'healthCheck' },
  },
  thresholds: {
    rejected_responses: ['count==0'],
    search_doctors_cached: ['p(95)<100'],
    search_doctors_uncached: ['p(95)<300'],
    search_specialties_cached: ['p(95)<100'],
    search_specialties_uncached: ['p(95)<300'],
  },
  summaryTrendStats: ['count', 'min', 'med', 'p(95)', 'p(99)', 'max'],
};

const qs = (params) => Object.entries(params).filter(([, v]) => v !== '' && v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

function record(res, cached, uncached) {
  let body = null;
  try { body = res.json(); } catch (_) { /* counted below */ }
  const meta = body && body.meta;
  const ok = check(res, {
    'status 200': (r) => r.status === 200,
    'not degraded': () => meta && meta.degraded === false,
  });
  if (!ok) { rejected.add(1, { status: String(res.status) }); return; }
  (meta.cache_hit ? cached : uncached).add(res.timings.duration);
  serverTook.add(meta.took_ms);
}

export function search() {
  const i = exec.scenario.iterationInTest; // unique across VUs
  const slot = i % 10;
  if (slot < 4) {
    const params = UNCACHED[(Math.floor(i / 10) * 4 + slot) % UNCACHED.length];
    record(http.get(`${BASE}/search/doctors?${qs(params)}`, { tags: { name: 'doctors' } }), doctorsCached, doctorsUncached);
  } else if (slot < 7) {
    record(http.get(`${BASE}/search/doctors?${qs(HOT[i % HOT.length])}`, { tags: { name: 'doctors' } }), doctorsCached, doctorsUncached);
  } else {
    record(http.get(`${BASE}/search/specialties?${qs({ q: PREFIXES[i % PREFIXES.length], limit: 6 })}`, { tags: { name: 'specialties' } }), specialtiesCached, specialtiesUncached);
  }
}

export function healthCheck() {
  const res = http.get(`${BASE}/health`, { tags: { name: 'health' } });
  if (check(res, { 'health 200': (r) => r.status === 200 })) health.add(res.timings.duration);
  else rejected.add(1, { status: String(res.status) });
}
