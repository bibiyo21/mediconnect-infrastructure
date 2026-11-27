// LOCAL live smoke of walk-in realtime against a REAL Reverb (increment 5.6 exit, security gate C3).
// Started by reverb-walkin-smoke.sh, which points it at a throw-away API and Reverb on the DEVELOPMENT
// database and creates synthetic accounts (tag in every email). Node 22+ (global fetch and WebSocket).
//
// Flow: two remote patient walk-ins (E1, E2), one guardian walk-in for an authorized dependent (E3); the
// doctor is checked in. Subscribe as patient 1, patient 2, the guardian and the doctor. Then: call E1,
// recall E1, skip E1, call E2 (a fan-out round: the other live entries get hints), revoke the guardian's
// dependent link, and skip E2. The old guardian socket is closed by the revocation. A FRESH guardian socket
// subscribes before the skip: it must get no WalkIn event, while patient 1 (control) gets its own hint.
//
// Every expectation is printed PASS or FAIL and written to the log. The log holds timestamps, ids (short),
// status codes, event names and channel names (short). It never holds a token, password, email, licence
// number or name. Each run ends with a CAVEATS block and a SUMMARY line, even when the run aborts.

import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const API = process.env.API_URL;
const WS = process.env.WS_URL;
const KEY = process.env.REVERB_APP_KEY;
const PW = process.env.SMOKE_PASSWORD;
const DB = process.env.SMOKE_DB;
const INFRA = process.env.INFRA_DIR;
const LOG = process.env.LOG_FILE;
const IDS_RAW = process.env.SMOKE_IDS;
const TODAY = process.env.SMOKE_TODAY; // Manila civil date, computed by the shell script
if (!API || !WS || !KEY || !PW || !DB || !INFRA || !LOG || !IDS_RAW || !TODAY) {
  console.error('Missing environment for the walk-in smoke.');
  process.exit(2);
}

// ---------------------------------------------------------------- guards (run before anything is written)
// The shell script checks the same things; these apply when this file is run directly.
const DB_OK = /^mediconnect(_smoke)?$/.test(DB);
const LOOPBACK = new Set(['127.0.0.1', 'localhost']);
const urlHost = (u) => new URL(u).hostname;
if (!DB_OK) { console.error(`Refusing: database '${DB}' is not mediconnect or mediconnect_smoke.`); process.exit(2); }
if (!LOOPBACK.has(urlHost(API)) || !LOOPBACK.has(urlHost(WS))) { console.error('Refusing: API_URL and WS_URL must be loopback.'); process.exit(2); }
if (process.env.DOCKER_HOST) { console.error('Refusing: DOCKER_HOST is set.'); process.exit(2); }
{
  const endpoint = execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8' }).trim();
  if (!endpoint.startsWith('unix://')) { console.error('Refusing: docker context is not a local unix socket.'); process.exit(2); }
}

const IDS = JSON.parse(IDS_RAW);
// Service env pinned for every PHP run (same list as the shell script's PIN_ENV).
const PIN_ENV = ['DB_HOST=postgres', 'REDIS_HOST=redis', 'MAIL_MAILER=smtp', 'MAIL_HOST=mailpit', 'SMS_DRIVER=mail-preview'];

const ENTRY_KEYS = ['entry_id', 'queue_version', 'status', 'occurred_at'];
// Last 8 hex chars: a UUIDv7 prefix is the timestamp and would look identical across ids.
const short = (id) => (id ? `…${String(id).slice(-8)}` : 'none');
const chan = (name) => String(name).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, (u) => short(u));
const results = [];

function log(line) {
  appendFileSync(LOG, `${new Date().toISOString()}  ${line}\n`);
}
function expect(name, ok, detail = '') {
  results.push({ name, ok });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  return ok;
}
// A setup step the rest of the run depends on: record it, then stop the run (SUMMARY is still written).
function need(name, ok, detail = '') {
  expect(name, ok, detail);
  if (!ok) throw new Error(`stopped at: ${name}`);
}
function caveats() {
  log('== CAVEATS');
  log('  - Queue driver is sync: the trailing debounced fan-out job is NOT exercised; only the immediate path runs.');
  log('  - Revoked guardian: the old socket being closed proves the socket closed, not the audience filter. The filter is checked on a fresh socket below and in Pest.');
  log('  - Sentry is not verified (DSN blanked for the throw-away API).');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, { token, body, idem = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idem) headers['Idempotency-Key'] = randomUUID();
  const res = await fetch(`${API}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  const errs = Object.keys(json?.errors ?? {}).join(',');
  return { status: res.status, json, data: json?.data, code: json?.code ?? json?.error?.code, errs };
}

// RFC 6238 TOTP, for enrolling MFA on the synthetic privileged accounts (the same clock the server uses).
function base32Decode(s) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) {
    const v = alpha.indexOf(c);
    if (v >= 0) bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totp(secret) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const code = (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000;
  return String(code).padStart(6, '0');
}

async function login(email, name) {
  return api('POST', '/auth/login', { body: { identifier: email, password: PW, device: { platform: 'IOS', name } } });
}
// Privileged accounts (clinic manager, admin) must enrol MFA once; a fresh synthetic account does so here.
async function privilegedSession(email, name) {
  const limited = (await login(email, name)).data?.tokens?.access_token;
  const setup = await api('POST', '/auth/mfa/totp/setup', { token: limited, body: {} });
  const confirm = await api('POST', '/auth/mfa/totp/confirm', { token: limited, body: { code: totp(setup.data.secret) } });
  return confirm.data?.tokens?.access_token;
}
async function session(email, name) {
  return (await login(email, name)).data?.tokens?.access_token;
}

// Runs PHP (Laravel bootstrapped) in a throw-away api container on the development database. Pinned env,
// --no-deps: postgres and redis are never recreated.
function runPhp(code) {
  const prelude = "<?php require getcwd().'/vendor/autoload.php'; $app = require getcwd().'/bootstrap/app.php'; $app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();";
  const envArgs = [`DB_DATABASE=${DB}`, 'APP_ENV=local', ...PIN_ENV].flatMap((e) => ['-e', e]);
  return execFileSync('docker', ['compose', 'run', '--no-deps', '--rm', '-T', ...envArgs, 'api', 'php'], {
    cwd: INFRA, encoding: 'utf8', input: `${prelude}\n${code}\n`, stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// ---------------------------------------------------------------- websocket subscribers
const openSockets = [];
async function subscribe(name, token, channel) {
  const state = { name, channel, messages: [], socketId: null, closed: false, closedAt: null, closeCode: null, joined: false, sock: null };
  const sock = new WebSocket(`${WS}/app/${KEY}?protocol=7&client=walkin-smoke&version=1.0&flash=false`);
  state.sock = sock;
  openSockets.push(sock);
  sock.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    state.messages.push({ at: Date.now(), event: m.event, channel: m.channel ?? null, data: m.data });
    if (m.event === 'pusher:connection_established') state.socketId = JSON.parse(m.data).socket_id;
  });
  sock.addEventListener('close', (e) => { state.closed = true; state.closedAt = Date.now(); state.closeCode = e.code; });
  const until = Date.now() + 5000;
  while (!state.socketId && Date.now() < until) await sleep(100);
  if (!state.socketId) return state;
  const auth = await api('POST', '/broadcasting/auth', { token, body: { socket_id: state.socketId, channel_name: channel } });
  if (auth.status !== 200) {
    state.refused = auth.status;
    return state;
  }
  sock.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: auth.json.auth, channel, channel_data: auth.json.channel_data } }));
  const joinUntil = Date.now() + 5000;
  while (Date.now() < joinUntil && !state.messages.some((m) => m.event === 'pusher_internal:subscription_succeeded')) await sleep(100);
  state.joined = state.messages.some((m) => m.event === 'pusher_internal:subscription_succeeded');
  return state;
}

const parsedHints = (sub) => sub.messages.filter((m) => m.event && m.event.includes('WalkInEntryUpdated')).map((m) => ({ at: m.at, ...JSON.parse(m.data) }));
const walkInEvents = (sub, from = 0, to = Infinity) => sub.messages.filter((m) => m.event && m.event.includes('WalkIn') && m.at >= from && m.at <= to);
const inWindow = (h, from, to) => h.at >= from && h.at <= to;

async function run() {
  caveats();
  log(`== Walk-in smoke, run tag ${IDS.tag}, database ${DB}`);

  // ---------------------------------------------------------------- setup over HTTP
  log('== Setup (synthetic accounts)');
  const tok = {};
  tok.p1 = await session(IDS.emails.p1, 'walkin-smoke');
  tok.p2 = await session(IDS.emails.p2, 'walkin-smoke');
  tok.guardian = await session(IDS.emails.guardian, 'walkin-smoke');
  tok.doctor = await session(IDS.emails.doctor, 'walkin-smoke');
  tok.manager = await privilegedSession(IDS.emails.manager, 'walkin-smoke');
  tok.admin = await privilegedSession(IDS.emails.admin, 'walkin-smoke');
  need('setup: all six accounts signed in', Object.values(tok).every(Boolean));

  const clinicRes = await api('POST', '/admin/clinics', {
    token: tok.admin,
    body: {
      organization: { name: `Walk-in Smoke Group ${IDS.tag}`, organization_type: 'CLINIC_GROUP' },
      name: `Walk-in Smoke Clinic ${IDS.tag}`,
      location: { name: 'Smoke branch', address_line1: '1 Test St', city: 'Makati', postal_code: '1210', phone: '+63 2 0000 0000' },
    },
  });
  need('setup: clinic created by the administrator', clinicRes.status === 201, `status ${clinicRes.status}`);
  const clinic = clinicRes.data.id;
  const location = clinicRes.data.locations[0].id;

  runPhp(`(new \\App\\Modules\\Clinics\\Models\\ClinicMember)->forceFill(['clinic_id' => '${clinic}', 'user_id' => '${IDS.users.manager}', 'member_role' => 'CLINIC_MANAGER', 'status' => 'ACTIVE', 'joined_at' => now()])->save();`);
  const hours = { hours: [1, 2, 3, 4, 5, 6, 7].map((d) => ({ day_of_week: d, opens_at: '00:00', closes_at: '23:59' })) };
  expect('setup: operating hours set', (await api('PUT', `/clinics/${clinic}/locations/${location}/operating-hours`, { token: tok.manager, body: hours })).status === 200);

  const assignmentRes = await api('POST', `/clinics/${clinic}/doctors`, { token: tok.manager, body: { clinic_location_id: location, prc_license_number: IDS.licence } });
  need('setup: doctor invited to the clinic', assignmentRes.status === 201 && Boolean(assignmentRes.data?.id), `status ${assignmentRes.status}`);
  const assignment = assignmentRes.data.id;
  const accept = await api('POST', `/doctors/me/assignments/${assignment}/accept`, { token: tok.doctor, body: {} });
  expect('setup: doctor accepted the assignment', accept.status === 200, `status ${accept.status}`);

  const svc = await api('POST', '/doctors/me/services', { token: tok.doctor, body: { consultation_type: 'IN_PERSON', clinic_location_id: location, name: 'Consultation', duration_minutes: 20, buffer_minutes: 5, fee_amount: 65000 } });
  need('setup: in-person service created', svc.status === 201 && Boolean(svc.data?.id), `status ${svc.status}`);
  const service = svc.data.id;
  const mode = await api('PUT', `/doctors/me/services/${service}/mode`, { token: tok.doctor, body: { service_mode: 'WALK_IN' } });
  need('setup: service set to WALK_IN', mode.status === 200 && Boolean(mode.data?.service_mode_id), `status ${mode.status}`);
  const modeId = mode.data.service_mode_id;

  const shifts = [1, 2, 3, 4, 5, 6, 7].map((d) => ({ day_of_week: d, doctor_service_mode_id: modeId, starts_at: '00:00', ends_at: '23:59', slot_duration_minutes: 20, buffer_minutes: 5 }));
  const sched = await api('POST', '/schedules', { token: tok.doctor, body: { name: `Walk-in smoke ${IDS.tag}`, effective_from: TODAY, status: 'ACTIVE', shifts } });
  expect('setup: recurring schedule created', sched.status === 201, `status ${sched.status}`);

  const policy = await api('PATCH', `/clinics/${clinic}/doctor-assignments/${assignment}/walkin-policy`, { token: tok.manager, body: { allow_patient_app_registration: true } });
  expect('setup: patient-app walk-in registration allowed by policy', policy.status === 200, `status ${policy.status}`);

  const checkin = await api('POST', '/presence/check-in', { token: tok.doctor, body: { clinic_location_id: location } });
  expect('setup: doctor checked in', checkin.status === 200 || checkin.status === 201, `status ${checkin.status} ${checkin.code ?? ''} fields=${checkin.errs} message=${String(checkin.json?.message ?? '').slice(0, 120)}`);

  const dep = await api('POST', '/patients/me/dependents', {
    token: tok.guardian, idem: true,
    body: { first_name: 'Dependent', last_name: 'Smoke', date_of_birth: '2018-03-10', sex: 'FEMALE', relationship: 'CHILD', guardian_attestation: true, guardian_attestation_version: 'draft-2026-11' },
  });
  expect('setup: guardian dependent authorized', dep.status === 201, `status ${dep.status} ${dep.code ?? ''} fields=${dep.errs}`);
  const depLinkId = dep.data?.id;
  const depProfileOut = depLinkId ? runPhp(`echo 'DEP_PROFILE='.\\Illuminate\\Support\\Facades\\DB::table('dependents')->where(fn (\\Illuminate\\Database\\Query\\Builder $q) => $q->where('id', '${depLinkId}')->orWhere('dependent_patient_profile_id', '${depLinkId}'))->value('dependent_patient_profile_id')."\\n";`) : '';
  const depProfileId = depProfileOut.match(/DEP_PROFILE=([0-9a-f-]{36})/)?.[1];
  need('setup: dependent profile id returned', Boolean(depProfileId));

  // ---------------------------------------------------------------- subscribe
  log('== Subscribe over Reverb');
  const subs = {};
  subs.p1 = await subscribe('p1', tok.p1, `presence-user.${IDS.users.p1}`);
  subs.p2 = await subscribe('p2', tok.p2, `presence-user.${IDS.users.p2}`);
  subs.guardian = await subscribe('guardian', tok.guardian, `presence-user.${IDS.users.guardian}`);
  subs.doctor = await subscribe('doctor', tok.doctor, `presence-doctor.${IDS.doctor_profile}`);
  for (const s of Object.values(subs)) log(`subscribed  ${s.name}  channel=${chan(s.channel)}  joined=${s.joined}`);
  expect('subscribe: four channels joined', Object.values(subs).every((s) => s.joined));

  // ---------------------------------------------------------------- transitions
  const entries = {};
  const actions = [];
  const windows = {};
  const pace = () => sleep(2600); // above the 2 s fan-out debounce, so each transition gets its own leading round

  async function act(label, method, path, body) {
    const started = Date.now();
    const r = await api(method, path, { token: tok.doctor, body, idem: true });
    actions.push({ label, status: r.status, code: r.code });
    log(`action  ${label}  status=${r.status}${r.code ? ` code=${r.code}` : ''}`);
    await sleep(1500);
    windows[label] = { started, ended: Date.now() };
    return r;
  }

  async function register(label, tokenKey, profileId) {
    const r = await api('POST', '/walk-ins', { token: tok[tokenKey], idem: true, body: { doctor_service_id: service, patient_profile_id: profileId, payer_type: 'SELF_PAY', acknowledge_late_risk: true } });
    actions.push({ label, status: r.status, code: r.code });
    log(`action  ${label}  status=${r.status}${r.code ? ` code=${r.code}` : ''}${r.errs ? ` fields=${r.errs}` : ''}`);
    if (r.status !== 201) return null;
    return r.data.id;
  }

  log('== Registrations');
  entries.E1 = await register('register E1 (patient 1)', 'p1', IDS.profiles.p1);
  await pace();
  entries.E2 = await register('register E2 (patient 2)', 'p2', IDS.profiles.p2);
  await pace();
  entries.E3 = await register('register E3 (guardian, dependent)', 'guardian', depProfileId);
  await pace();
  need('register: three walk-in entries created', Object.values(entries).every(Boolean), Object.values(entries).map(short).join(' '));

  // The doctor desk records arrival with the doctor token (the patient app is not used for this step).
  async function arrive(label, entry) {
    const r = await api('POST', `/walk-ins/${entry}/arrive`, { token: tok.doctor, idem: true, body: {} });
    log(`action  ${label}  status=${r.status}${r.code ? ` code=${r.code}` : ''}`);
    await pace();
    return r.status;
  }
  expect('arrive: patient 1 arrived (recorded by the doctor desk)', (await arrive('arrive E1 (patient 1)', entries.E1)) === 200);
  expect('arrive: patient 2 arrived (recorded by the doctor desk)', (await arrive('arrive E2 (patient 2)', entries.E2)) === 200);
  expect('arrive: dependent arrived (recorded by the doctor desk)', (await arrive('arrive E3 (guardian, dependent)', entries.E3)) === 200);

  log('== Transitions');
  // One CALLED entry per doctor at a time, so E1 leaves CALLED (skip) before E2 is called.
  await act('call E1', 'POST', `/walk-ins/${entries.E1}/call`);
  await pace();
  await act('recall E1', 'POST', `/walk-ins/${entries.E1}/recall`);
  await pace();
  await act('skip E1', 'POST', `/walk-ins/${entries.E1}/skip`, { reason_code: 'PATIENT_NOT_PRESENT' });
  await pace();
  await act('call E2 (another entry moves: fan-out round)', 'POST', `/walk-ins/${entries.E2}/call`);
  await pace();

  // Revocation: capture the start time before the request, so the server-side close is inside the window.
  const revokedAt = Date.now();
  const revoke = await api('DELETE', `/patients/me/dependents/${depLinkId}`, { token: tok.guardian });
  expect('revoke: guardian authorization removed', revoke.status === 200 || revoke.status === 204, `status ${revoke.status}`);
  await sleep(2000);

  // A fresh guardian socket, subscribed AFTER the revocation: it must receive nothing for the dependent.
  log('== Fresh guardian socket after revocation');
  const freshG = await subscribe('guardian-after-revoke', tok.guardian, `presence-user.${IDS.users.guardian}`);
  expect('revoked guardian: fresh socket joined its own channel', freshG.joined);

  await act('skip E2 (after revocation: fan-out reaches E3 on its owner channel if the filter fails)', 'POST', `/walk-ins/${entries.E2}/skip`, { reason_code: 'PATIENT_NOT_PRESENT' });
  await sleep(2500);

  // ---------------------------------------------------------------- evaluate
  log('== Evaluation');
  const allEventNames = [...new Set([...Object.values(subs), freshG].flatMap((s) => s.messages.map((m) => m.event)))];
  log(`event names seen: ${allEventNames.join(', ')}`);
  for (const sub of [...Object.values(subs), freshG]) {
    const hints = parsedHints(sub);
    const others = walkInEvents(sub).length - hints.length;
    log(`received  ${sub.name}  channel=${chan(sub.channel)}  entryHints=${hints.length}  otherWalkInEvents=${others}`);
    for (const h of hints) log(`  entry_hint  entry=${short(h.entry_id)}  status=${h.status}  queue_version=${h.queue_version}`);
  }

  // 1. Only own entries on each patient/guardian channel.
  const ownerByName = { p1: [entries.E1], p2: [entries.E2], guardian: [entries.E3] };
  for (const [who, mine] of Object.entries(ownerByName)) {
    const hints = parsedHints(subs[who]);
    const foreign = hints.filter((h) => !mine.includes(h.entry_id));
    expect(`own-entry only: ${who} channel got only its own entry ids (${hints.length} hints)`, hints.length > 0 && foreign.length === 0, `foreign=${foreign.length}`);
  }

  // 2. Exact payload keys on every entry hint.
  const allHints = Object.values(subs).flatMap((s) => parsedHints(s));
  const keyList = (h) => Object.keys(h).filter((k) => k !== 'at').sort().join(',');
  const want = [...ENTRY_KEYS].sort().join(',');
  expect('payload keys: each entry hint has exactly entry_id, status, queue_version, occurred_at', allHints.length > 0 && allHints.every((h) => keyList(h) === want), `hints=${allHints.length}`);

  // 3. Doctor channel receives queue updates for the transitions.
  const docQueue = walkInEvents(subs.doctor);
  expect('doctor channel: received WalkIn queue updates for the transitions', docQueue.length >= 4, `count=${docQueue.length}`);

  // 4. No queue-wide events on patient or guardian channels (only their own entry hints).
  for (const who of ['p1', 'p2', 'guardian']) {
    const others = walkInEvents(subs[who]).filter((m) => !m.event.includes('WalkInEntryUpdated')).length;
    expect(`no queue-wide events: ${who} channel got no WalkIn event other than its own entry hints`, others === 0, `count=${others}`);
  }

  // 5. Each action reaches its own patient's channel with the matching status, inside its window.
  const hit = (sub, entry, status, label) => {
    const w = windows[label];
    return parsedHints(sub).some((h) => h.entry_id === entry && h.status === status && inWindow(h, w.started, w.ended + 1500));
  };
  expect('call E1: patient 1 channel got its entry as CALLED', hit(subs.p1, entries.E1, 'CALLED', 'call E1'));
  expect('recall E1: patient 1 channel got its entry again as CALLED', hit(subs.p1, entries.E1, 'CALLED', 'recall E1'));
  expect('skip E1: patient 1 channel got its entry as SKIPPED', hit(subs.p1, entries.E1, 'SKIPPED', 'skip E1'));
  expect('call E2: patient 2 channel got its entry as CALLED', hit(subs.p2, entries.E2, 'CALLED', 'call E2 (another entry moves: fan-out round)'));

  // 6. Fan-out round: when E2 moved, the other live entries got a hint for their own entry.
  const fan = windows['call E2 (another entry moves: fan-out round)'];
  const fanP1 = parsedHints(subs.p1).filter((h) => h.entry_id === entries.E1 && inWindow(h, fan.started, fan.ended + 2500));
  const fanG = parsedHints(subs.guardian).filter((h) => h.entry_id === entries.E3 && inWindow(h, fan.started, fan.ended + 2500));
  expect('fan-out round: patient 1 got a hint for its own entry after another entry moved', fanP1.length >= 1, `count=${fanP1.length}`);
  expect('fan-out round: guardian got a hint for the dependent entry after another entry moved (before revocation)', fanG.length >= 1, `count=${fanG.length}`);

  // 7. Revocation. The old socket is closed by the server within 2 s of the revocation request.
  const oldG = subs.guardian;
  const gAfter = walkInEvents(oldG, revokedAt);
  expect('revoked guardian: no WalkIn event after revocation (socket closed; audience filter covered by Pest)', gAfter.length === 0, `count=${gAfter.length}`);
  expect('revoked guardian: old socket closed inside the 2 s after the revocation request', oldG.closed && oldG.closedAt >= revokedAt && oldG.closedAt < revokedAt + 2000, `code=${oldG.closeCode}`);

  // 8. The audience filter, on a fresh socket: the revoked guardian gets no entry event for the skip E2 step.
  const skip = windows['skip E2 (after revocation: fan-out reaches E3 on its owner channel if the filter fails)'];
  const freshEvents = walkInEvents(freshG, skip.started, skip.ended + 2500);
  expect('revoked guardian on a fresh socket: no WalkIn event during the skip E2 step', freshEvents.length === 0, `count=${freshEvents.length}`);
  const p1Control = parsedHints(subs.p1).filter((h) => h.entry_id === entries.E1 && inWindow(h, skip.started, skip.ended + 2500));
  expect('control: patient 1 got its own entry hint during the same skip E2 step', p1Control.length >= 1, `count=${p1Control.length}`);
  const p1AfterRevoke = parsedHints(subs.p1).filter((h) => h.at >= revokedAt);
  expect('after revocation: patient 1 still receives only its own entry hints', p1AfterRevoke.length >= 1 && p1AfterRevoke.every((h) => h.entry_id === entries.E1), `count=${p1AfterRevoke.length}`);

  // Action status summary (no bodies).
  for (const a of actions) log(`status  ${a.label}  ${a.status}${a.code ? ` ${a.code}` : ''}`);
}

let fatal = null;
try {
  await run();
} catch (e) {
  fatal = e;
  console.error(`smoke stopped: ${e.constructor.name}`); // message may hold a docker command line; not written to the log
  expect('run completed without a stop', false, e.constructor.name);
}
for (const sock of openSockets) { try { sock.close(); } catch { /* already closed */ } }
caveats();
const failed = results.filter((r) => !r.ok).length;
log(`SUMMARY  ${results.length - failed} passed, ${failed} failed, 0 skipped${fatal ? ' (run stopped early)' : ''}`);
process.exit(failed === 0 && !fatal ? 0 : 1);
