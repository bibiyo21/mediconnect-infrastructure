// Proves against a REAL Reverb that terminating a user's connections closes their socket
// (increment 5.4b, M-3). LOCAL only; started by reverb-terminate-check.sh, which points it at a
// throw-away API and Reverb running on the TEST database. Node 22+ (global fetch and WebSocket).
//
// Flow:
//   1. sign in a user (native login, bearer token)
//   2. open a WebSocket to Reverb, read the socket id
//   3. ask POST /broadcasting/auth for presence-user.{id}; refuse-checks: the private spelling
//      and another user's channel must not be signed
//   4. subscribe, expect pusher_internal:subscription_succeeded with the user id as the member
//   5. wait 3 s: the socket must STAY open (control: nothing closes it by itself)
//   6. POST /auth/logout, which asks Reverb to terminate the user's connections
//   7. the socket must CLOSE within 8 s; the revoked token must no longer sign channels (401)
// Exit 0 when every check passes, 1 otherwise.

const API = process.env.API_URL ?? 'http://127.0.0.1:8091/api/v1';
const WS = process.env.WS_URL ?? 'ws://127.0.0.1:8081';
const KEY = process.env.REVERB_APP_KEY;
const EMAIL = process.env.CHECK_EMAIL;
const PASSWORD = process.env.CHECK_PASSWORD;
if (!KEY || !EMAIL || !PASSWORD) {
  console.error('REVERB_APP_KEY, CHECK_EMAIL and CHECK_PASSWORD are required.');
  process.exit(2);
}

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (res) => res.json().catch(() => ({}));

async function post(path, body, token) {
  return fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
}

// 1. sign in
const loginRes = await post('/auth/login', { identifier: EMAIL, password: PASSWORD, device: { platform: 'IOS', name: 'reverb-check' } });
const login = await json(loginRes);
if (loginRes.status !== 200) console.log(`login answered ${loginRes.status}: ${login?.code ?? ''} ${login?.message ?? ''}`);
const token = login?.data?.tokens?.access_token;
const me = await json(await fetch(`${API}/auth/me`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }));
const userId = me?.data?.id;
check('signed in', Boolean(token && userId));
if (!token || !userId) process.exit(1);

// 2. connect
const socket = new WebSocket(`${WS}/app/${KEY}?protocol=7&client=reverb-check&version=1.0&flash=false`);
let closedAt = null;
const messages = [];
const waiters = [];
socket.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  messages.push(m);
  waiters.splice(0).forEach((w) => w());
});
socket.addEventListener('error', (e) => console.log(`socket error: ${e.message ?? e.type}`));
socket.addEventListener('close', () => { closedAt = Date.now(); waiters.splice(0).forEach((w) => w()); });
const waitFor = async (predicate, ms) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const hit = messages.find(predicate);
    if (hit) return hit;
    await Promise.race([new Promise((r) => waiters.push(r)), sleep(100)]);
  }
  return null;
};

const established = await waitFor((m) => m.event === 'pusher:connection_established', 5000);
const socketId = established ? JSON.parse(established.data).socket_id : null;
if (!socketId) console.log(`messages seen: ${JSON.stringify(messages)}`);
check('connected to Reverb', Boolean(socketId), socketId ?? '');
if (!socketId) process.exit(1);

// 3. sign the channel
const channel = `presence-user.${userId}`;
const auth = await post('/broadcasting/auth', { socket_id: socketId, channel_name: channel }, token);
const signed = await json(auth);
check('presence channel signed for the caller', auth.status === 200 && Boolean(signed.auth), `status ${auth.status}`);
const member = signed.channel_data ? JSON.parse(signed.channel_data) : null;
check('member is the user id with an empty user_info', member?.user_id === userId && Object.keys(member?.user_info ?? { x: 1 }).length === 0);
check('private spelling is refused', (await post('/broadcasting/auth', { socket_id: socketId, channel_name: `private-user.${userId}` }, token)).status === 422);
check("another user's channel is refused", (await post('/broadcasting/auth', { socket_id: socketId, channel_name: 'presence-user.018f1c3e-7b1a-7000-8000-000000000001' }, token)).status === 403);

// 4. subscribe
socket.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: signed.auth, channel, channel_data: signed.channel_data } }));
const subscribed = await waitFor((m) => m.event === 'pusher_internal:subscription_succeeded' && m.channel === channel, 5000);
check('subscribed to the presence channel', Boolean(subscribed));
const presence = subscribed ? JSON.parse(subscribed.data)?.presence : null;
check('member list holds the user id only', JSON.stringify(presence?.ids) === JSON.stringify([userId]), JSON.stringify(presence?.ids ?? null));

// 5. control: it stays open on its own
await sleep(3000);
check('socket stays open without a trigger', socket.readyState === WebSocket.OPEN && closedAt === null);

// 6. trigger: logout asks Reverb to terminate the user's connections
const t0 = Date.now();
const logout = await post('/auth/logout', {}, token);
check('logout accepted', logout.status === 200, `status ${logout.status}`);

// 7. the socket closes
const until = Date.now() + 8000;
while (closedAt === null && Date.now() < until) await sleep(100);
check('socket CLOSED after logout', closedAt !== null, closedAt ? `${closedAt - t0} ms after the request started` : 'still open');
const again = await post('/broadcasting/auth', { socket_id: socketId, channel_name: channel }, token);
check('revoked token cannot sign the channel again', again.status === 401, `status ${again.status}`);

try { socket.close(); } catch { /* already closed */ }
console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
