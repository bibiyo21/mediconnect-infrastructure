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


// ---------------------------------------------------------------------------------------------
// 8. Sweep checks (increment 5.6-0). They need RECONCILE_CMD and EXPIRE_CMD (set by the .sh): shell
//    commands that run `php artisan realtime:reconcile` and expire the check user's credentials in
//    the same throw-away environment. Skipped, not failed, when they are absent.
// ---------------------------------------------------------------------------------------------
import { execSync } from 'node:child_process';

// Only the exit status is printed: the first line of an execSync error is the command itself, which holds REVERB_APP_SECRET.
function run(cmd) {
  try { execSync(cmd, { stdio: 'pipe', cwd: process.cwd(), timeout: 120000 }); return true; } catch (e) { console.log(`command failed (exit status ${e.status ?? 'unknown'})`); return false; }
}

async function signInAndConnect(label) {
  const res = await post('/auth/login', { identifier: EMAIL, password: PASSWORD, device: { platform: 'IOS', name: label } });
  const tok = (await json(res))?.data?.tokens?.access_token;
  const sock = new WebSocket(`${WS}/app/${KEY}?protocol=7&client=${label}&version=1.0&flash=false`);
  const state = { sock, tok, messages: [], closed: false, socketId: null };
  sock.addEventListener('message', (e) => { const m = JSON.parse(e.data); state.messages.push(m); });
  sock.addEventListener('close', () => { state.closed = true; });
  const until = Date.now() + 5000;
  while (!state.socketId && Date.now() < until) {
    const hit = state.messages.find((m) => m.event === 'pusher:connection_established');
    if (hit) state.socketId = JSON.parse(hit.data).socket_id;
    else await sleep(100);
  }
  return state;
}

async function signChannel(state) {
  const ch = `presence-user.${userId}`;
  const a = await json(await post('/broadcasting/auth', { socket_id: state.socketId, channel_name: ch }, state.tok));
  return { ch, a };
}

function subscribe(state, { ch, a }) {
  state.sock.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: a.auth, channel: ch, channel_data: a.channel_data } }));
}

async function waitClosed(state, ms) {
  const until = Date.now() + ms;
  while (!state.closed && Date.now() < until) await sleep(100);
  return state.closed;
}

if (!process.env.RECONCILE_CMD || !process.env.EXPIRE_CMD || !process.env.WEB_DEVICE_CMD) {
  console.log('SKIP  sweep checks (RECONCILE_CMD, EXPIRE_CMD and WEB_DEVICE_CMD not all set)');
} else {
  // (a) stale signature: fetched BEFORE a logout (which terminates the user), used AFTER it. Reverb's
  //     terminate cannot reach the socket (it had no user id when it was terminated), so the socket
  //     subscribes and stays open until the sweep closes it. The user has no live credential then.
  const a = await signInAndConnect('stale-signature');
  check('stale-signature: signed in and connected', Boolean(a.tok && a.socketId));
  const signature = await signChannel(a);
  check('stale-signature: signature obtained before the logout', Boolean(signature.a.auth));
  await post('/auth/logout', {}, a.tok);
  await sleep(1000);
  const aStillOpen = !a.closed;
  subscribe(a, signature);
  const joined = await (async () => { const until = Date.now() + 5000; while (Date.now() < until) { if (a.messages.some((m) => m.event === 'pusher_internal:subscription_succeeded')) return true; await sleep(100); } return false; })();
  check('stale-signature: the old signature still subscribes after the logout (the residual risk L-a)', joined && aStillOpen, `open=${aStillOpen} joined=${joined}`);
  check('stale-signature: reconcile command ran', run(process.env.RECONCILE_CMD));
  check('stale-signature: the sweep CLOSED the socket', await waitClosed(a, 8000));

  // (b) expired credential: nothing revokes anything; the access and refresh tokens simply expire.
  const b = await signInAndConnect('expired-credential');
  check('expired-credential: signed in and connected', Boolean(b.tok && b.socketId));
  subscribe(b, await signChannel(b));
  const bJoined = await (async () => { const until = Date.now() + 5000; while (Date.now() < until) { if (b.messages.some((m) => m.event === 'pusher_internal:subscription_succeeded')) return true; await sleep(100); } return false; })();
  check('expired-credential: subscribed', bJoined);
  check('expired-credential: sweep keeps a user with a live credential', run(process.env.RECONCILE_CMD) && (await sleep(2000), !b.closed));
  check('expired-credential: credentials expired in the database', run(process.env.EXPIRE_CMD));
  check('expired-credential: reconcile command ran', run(process.env.RECONCILE_CMD));
  check('expired-credential: the sweep CLOSED the socket', await waitClosed(b, 8000));

  // (c) a token sign-in without a platform is refused (it could otherwise pose as a browser device).
  const noPlatform = await post('/auth/login', { identifier: EMAIL, password: PASSWORD });
  check('no-platform: a token login without device.platform is refused', noPlatform.status === 422, `status ${noPlatform.status}`);

  // (d) WEB device: the user holds no token; only a browser device row decides. Stale (3 h) is closed, fresh is kept.
  const c = await signInAndConnect('web-device');
  const cSignature = await signChannel(c);
  await post('/auth/logout', {}, c.tok); // no token credential left
  await sleep(1000);
  subscribe(c, cSignature);
  await sleep(1500);
  check('web-device: stale-signature socket subscribed and open', !c.closed && c.messages.some((m) => m.event === 'pusher_internal:subscription_succeeded'));
  check('web-device: fresh WEB device inserted', run(process.env.WEB_DEVICE_CMD.replace('__MIN__', '0')));
  check('web-device: reconcile ran', run(process.env.RECONCILE_CMD));
  await sleep(2000);
  check('web-device: fresh WEB device keeps the socket', !c.closed);
  check('web-device: WEB device aged to 3 hours', run(process.env.WEB_DEVICE_CMD.replace('__MIN__', '180')));
  check('web-device: reconcile ran again', run(process.env.RECONCILE_CMD));
  check('web-device: stale WEB device CLOSED the socket', await waitClosed(c, 8000));
}

try { socket.close(); } catch { /* already closed */ }
console.log(failed === 0 ? '\nALL CHECKS PASSED' : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
