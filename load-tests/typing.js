// Rate-limit budget for one patient typing (follow-up from 3.6). The web and
// mobile clients send up to two requests per typing pause (specialty
// suggestions and doctor results), and every /search/* route shares 60 a
// minute per IP. This simulates one fast typist pausing every PAUSE_MS and
// reports how many pauses fit before the first 429. LOCAL only. Wait at least
// a minute after search.js (or another run) so the bucket starts empty.
import http from 'k6/http';
import { Counter } from 'k6/metrics';
import exec from 'k6/execution';

const BASE = __ENV.BASE_URL || 'http://api:8000/api/v1';
const PAUSE_MS = Number(__ENV.PAUSE_MS || 1000);
const WORDS = ['p', 'pe', 'ped', 'pedi', 'pedia', 'pediat', 'pediatr', 'pediatri', 'pediatric', 'pediatrici', 'pediatrician'];

const pauses = new Counter('typing_pauses_answered');
const limited = new Counter('typing_requests_limited');

export const options = {
  scenarios: { typist: { executor: 'constant-arrival-rate', rate: Math.round(60000 / PAUSE_MS), timeUnit: '1m', duration: '75s', preAllocatedVUs: 2, maxVUs: 4 } },
  summaryTrendStats: ['count', 'med', 'p(95)', 'max'],
};

export default function () {
  const i = exec.scenario.iterationInTest;
  const q = `${WORDS[i % WORDS.length]} ${Math.floor(i / WORDS.length)}`.trim();
  const responses = http.batch([
    ['GET', `${BASE}/search/specialties?q=${encodeURIComponent(q)}&limit=6`],
    ['GET', `${BASE}/search/doctors?q=${encodeURIComponent(q)}`],
  ]);
  const throttled = responses.filter((r) => r.status === 429).length;
  if (throttled > 0) {
    limited.add(throttled);
    if (!globalThis.firstLimited) {
      globalThis.firstLimited = true;
      console.log(`first 429 at pause ${i + 1}, ${(exec.instance.currentTestRunDuration / 1000).toFixed(1)} s into typing`);
    }
  } else {
    pauses.add(1);
  }
}
