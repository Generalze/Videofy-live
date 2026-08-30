#!/usr/bin/env node
/** @author masterzee001 */
/**
 * Mobile CONTRACT acceptance — the phone's whole HTTP surface, driven the way
 * the app drives it, against a deployed Videofy Live.
 *
 *   node scripts/mobile-contract-acceptance.mjs [baseUrl] [--allow-blocked]
 *
 *   env (NAMES; the values are never printed):
 *     PROBE_EMAIL            the first probe account            (default probe-call-a@consummate7.com)
 *     PROBE_PASSWORD_FILE    file holding that account's password (required)
 *     PROBE_B_EMAIL          a second probe account, the messaging partner (optional)
 *     PROBE_B_PASSWORD_FILE  its password file (optional; falls back to PROBE_PASSWORD_FILE)
 *     STREAM_HANDLE          a channel handle known to exist (optional; default meakzoe)
 *     PROBE_HOST_EMAIL       an account holding session.host, to CREATE a direct call (optional)
 *     PROBE_HOST_PASSWORD_FILE  its password file (optional; falls back to PROBE_PASSWORD_FILE)
 *     PROBE_NO_ANSWER_WAIT   '0' skips the 35 s wait that proves NO ANSWER (optional)
 *
 * WHY THIS EXISTS. When the APK cannot be built, the only thing about the
 * phone that can still be verified is the contract it depends on. Except
 * where noted below, every request is transcribed from apps/mobile/src --
 * api/client.ts, auth/authSessionManager.ts, call/directCallApi.ts,
 * call/callConnection.ts, api/channelDirectory.ts and
 * push/deviceRegistrationService.ts -- with the same paths, methods, bodies,
 * header shape and sequencing, so a PASS there is a statement about what the
 * real app will get back. Two of the phone's surfaces have no HTTP form at all
 * (the programme directory, and creating a direct call) and are driven over a
 * real socket rather than a substitute.
 *
 * THE ONE EXCEPTION, NAMED SO IT CANNOT BE MISREAD AS A PHONE SURFACE.
 * `GET/PUT /channels/mine` is the OPERATOR CONSOLE's route
 * (apps/operator-web/src/premium/channelIdentity.ts); the phone never calls
 * it. It is driven here only as the owner-side baseline for the comparison
 * that follows it: the public views the phone DOES reach -- /streams/<handle>,
 * whose URL apps/mobile/src/api/channelDirectory.ts builds for sharing, and
 * the channel rows the directory socket delivers -- must not carry
 * `ownerAccountId`. Without reading the owner view there is nothing to
 * compare the public views against, so the check would be asserting that a
 * field is absent without ever having established it exists. Those checks are
 * therefore a statement about the SERVER's channel serialisation, not about
 * the phone's own request set.
 *
 * WHAT IT PRINTS. PASS/FAIL per check with the status code and byte size.
 * Never a body that could carry a token, never a credential, never an
 * account id. Ids are held in memory for the run and dropped.
 *
 * WHAT IT DOES NOT CLAIM (founder ruling, 30 Aug 2026). A green run is
 * "SERVER CONTRACT READY FOR MOBILE". It is NOT "Android client accepted":
 * nothing here runs the APK, so push delivery, ringing on a locked phone,
 * microphone capture and the call screen are all outside it. Those are the
 * physical-device acceptance held to 1 Sep.
 *
 * A SKIP AND A BLOCK ARE NOT PASSES. Checks that could not run are listed
 * separately and excluded from the pass count, because a suite reporting
 * "all passed" while some of its checks never ran is a suite lying about its
 * own coverage -- the exact way a green gate comes to verify nothing.
 *
 * AND A BLOCK EXITS NON-ZERO (founder principle, 30 Aug 2026: a gate that
 * passes while verifying nothing is the failure mode we hunt). Keeping a
 * BLOCKED check out of the pass count was only half the fix. The EXIT STATUS
 * is what CI, a deploy script and a person reading `echo $?` actually consume,
 * and while it stayed 0 the suite still announced success for a run that had
 * been denied the evidence it came for. So a BLOCKED check now fails the run.
 *
 * `--allow-blocked` exits 0 anyway. It is for the case where the founder has
 * SEEN the block and accepted it -- a typed, deliberate decision that survives
 * in the shell history and in CI configuration where anyone can read it, which
 * is the opposite of a default that quietly forgives.
 *
 * A SKIP does NOT affect the exit status. A skip means the fixture for that
 * check was not supplied to this invocation (no partner account, no channel):
 * a statement about how the suite was called, not about what the deployment
 * withheld. Blocks are the deployment's answer; skips are ours.
 *
 * Either way the summary names the blocked count, including when it is zero,
 * so no passing run can hide one.
 *
 * WHAT IT CLEANS UP. Messages it sent are retracted; a device it registered
 * is revoked; profile fields it changed are restored; a follow or contact it
 * created is removed; a ring it dispatched is dismissed; every socket it
 * opened is disconnected. Accounts cannot be deleted over HTTP, so an account
 * it had to create is listed at the end rather than pretended away.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { lookup, resolve4 } from 'node:dns/promises';
import { setTimeout as sleep } from 'node:timers/promises';

/*
 * Flags are separated from the positional base URL rather than assumed absent:
 * `node ... --allow-blocked` with no URL must still mean the default
 * deployment, and `node ... https://host --allow-blocked` must not read the
 * flag as a host. An unrecognised option is refused rather than ignored --
 * silently ignoring `--allow-blocked-checks` would hand back the exit status
 * the caller was trying to change.
 */
const argv = process.argv.slice(2);
const allowBlocked = argv.includes('--allow-blocked');
const unknownFlags = argv.filter((arg) => arg.startsWith('-') && arg !== '--allow-blocked');
if (unknownFlags.length > 0) {
  console.error(`Unknown option(s): ${unknownFlags.join(' ')}`);
  console.error('usage: node scripts/mobile-contract-acceptance.mjs [baseUrl] [--allow-blocked]');
  process.exit(2);
}
const base = (argv.find((arg) => !arg.startsWith('-')) ?? 'https://staging.consummate7.com').replace(
  /\/$/,
  '',
);
const ACCOUNT = `${base}/auth`;
const MEDIA = `${base}/media`;
const GATEWAY = base;
// Cloudflare answers a bare client with 403; the phone presents a UA too.
const USER_AGENT = 'VideofyLive-ContractAcceptance/1.0 (Mozilla/5.0; Android 14; Mobile)';
const DEVICE_LIFETIME_SECONDS = 180 * 24 * 60 * 60;

const results = [];
let failed = 0;
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
/**
 * The check does not apply to this run (no partner account, no channel).
 * Recorded OUTSIDE `results`, so it can never be counted as a pass.
 */
const notRun = [];
function skip(name, why) {
  notRun.push({ kind: 'SKIP', name, why });
  console.log(`  SKIP  ${name} — ${why}`);
}
/**
 * The check COULD have run, and the deployment withheld something it needs
 * -- an unverified probe, an absent capability. Louder than a skip because
 * it names a gap in the evidence rather than a gap in the fixture.
 */
function blocked(name, why) {
  notRun.push({ kind: 'BLOCKED', name, why });
  console.log(`  BLOCKED  ${name} — ${why}`);
}

function readSecretFile(pathEnv, fallbackEnv) {
  const path = process.env[pathEnv] ?? (fallbackEnv ? process.env[fallbackEnv] : undefined);
  if (!path || !existsSync(path)) return null;
  return readFileSync(path, 'utf8').trim();
}

/**
 * The app's authorizedFetch, minus the store: the same header, the same
 * base. `sizeOf` is the one thing this reports about a body.
 */
function client(token) {
  return async (path, init = {}, root = ACCOUNT) => {
    const headers = new Headers(init.headers ?? {});
    headers.set('user-agent', USER_AGENT);
    if (token) headers.set('authorization', `Bearer ${token}`);
    const response = await fetch(`${root}${path}`, { ...init, headers, redirect: 'manual' });
    const bytes = Buffer.from(await response.arrayBuffer());
    let json = null;
    try {
      json = JSON.parse(bytes.toString('utf8'));
    } catch {
      /* binary or empty */
    }
    return { status: response.status, type: response.headers.get('content-type') ?? '', bytes, json };
  };
}
const jsonInit = (method, value) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
});
const size = (r) => `HTTP ${r.status}, ${r.bytes.length} B`;

async function signIn(email, password) {
  const anonymous = client(null);
  const r = await anonymous('/sessions', jsonInit('POST', { email, password, client: 'device' }));
  const body = r.json ?? {};
  const token = typeof body.token === 'string' ? body.token : null;
  return {
    status: r.status,
    token,
    accountId: typeof body.accountId === 'string' ? body.accountId : null,
    expiresInSeconds: typeof body.expiresInSeconds === 'number' ? body.expiresInSeconds : null,
    size: r.bytes.length,
  };
}

/** A one-second 16 kHz mono PCM WAV of a 440 Hz tone: real container, real samples. */
function oneSecondWav() {
  const rate = 16000;
  const samples = rate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/**
 * socket.io-client, when this checkout has it installed.
 *
 * Imported dynamically because two of the phone's surfaces have NO HTTP
 * form -- the programme directory and creating a direct call are both
 * socket acts -- and a suite that cannot be run at all on a checkout
 * without node_modules is worse than one that says which checks it lost.
 */
let socketIo = null;
try {
  ({ io: socketIo } = await import('socket.io-client'));
} catch {
  socketIo = null;
}

/**
 * The phone's own call join, transcribed from callConnection.ts: the
 * `role: 'call-participant'` handshake query (omitting it makes the gateway
 * treat the socket as a LISTENER and `call:join` reaches nobody), the join
 * payload built the way buildCallJoinPayload builds it, and the ack read
 * through `.timeout()` so a successful one-argument ack is not mistaken for
 * an error.
 *
 * Resolves WITH the socket still open: a direct call lives only while its
 * creator is connected, so the caller hangs up by disconnecting.
 */
function callJoin(token, callId, directPeerAccountId) {
  return new Promise((resolve) => {
    const socket = socketIo(GATEWAY, {
      query: { role: 'call-participant' },
      reconnection: false,
      timeout: 20_000,
      extraHeaders: { 'user-agent': USER_AGENT },
    });
    let timer = null;
    const finish = (value) => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      resolve({ ...value, socket });
    };
    timer = setTimeout(() => finish({ ok: false, code: 'timeout' }), 25_000);
    socket.on('connect_error', (error) => finish({ ok: false, code: `connect-error: ${error.message}` }));
    socket.on('connect', () => {
      socket.timeout(20_000).emit(
        'call:join',
        {
          callId,
          displayName: 'Contract Probe',
          speakLanguage: 'en',
          hearLanguage: 'en',
          captionsEnabled: true,
          voiceGender: 'female',
          audioMode: 'translated',
          ...(token ? { sessionToken: token } : {}),
          ...(directPeerAccountId === undefined ? {} : { directPeerAccountId }),
        },
        (error, reply) => finish(error ? { ok: false, code: 'ack-timeout' } : (reply ?? { ok: false, code: 'empty-ack' })),
      );
    });
  });
}

const emailA = process.env.PROBE_EMAIL ?? 'probe-call-a@consummate7.com';
const passwordA = readSecretFile('PROBE_PASSWORD_FILE');
if (passwordA === null) {
  console.error('PROBE_PASSWORD_FILE must name a readable file.');
  process.exit(2);
}
const emailB = process.env.PROBE_B_EMAIL ?? null;
const passwordB = readSecretFile('PROBE_B_PASSWORD_FILE', 'PROBE_PASSWORD_FILE');
const streamHandle = process.env.STREAM_HANDLE ?? 'meakzoe';

console.log(`Videofy Live — mobile contract acceptance against ${base}\n`);
const created = [];
const leftovers = [];

// ---------------------------------------------------------------- sessions
console.log('Session (authSessionManager.ts)');
const a = await signIn(emailA, passwordA);
record('device-class sign-in returns a session', a.status === 200 && a.token !== null && a.accountId !== null, `HTTP ${a.status}, ${a.size} B`);
record(
  'device session lasts 180 days',
  a.expiresInSeconds === DEVICE_LIFETIME_SECONDS,
  `expiresInSeconds=${a.expiresInSeconds} (expected ${DEVICE_LIFETIME_SECONDS})`,
);
if (a.token === null) {
  console.log('\nNo session; nothing further can be verified.');
  process.exit(1);
}
const A = client(a.token);
const me0 = await A('/sessions/current');
record('GET /sessions/current validates the stored token', me0.status === 200 && me0.json?.accountId === a.accountId, size(me0));
const renewed = await A('/sessions/renew', { method: 'POST' });
record(
  'POST /sessions/renew keeps the device class',
  renewed.status === 200 && renewed.json?.expiresInSeconds === DEVICE_LIFETIME_SECONDS && typeof renewed.json?.token === 'string',
  `${size(renewed)}, expiresInSeconds=${renewed.json?.expiresInSeconds}`,
);
const bad = await client('not-a-token')('/sessions/current');
record('a bad token is refused with 401 (the app signs out on this)', bad.status === 401, size(bad));

// ---------------------------------------------------------------- profile
console.log('\nProfile (routes.ts, social-routes.ts)');
const me = await A('/me');
const profile = me.json?.profile ?? {};
record(
  'GET /me carries the profile fields the phone reads',
  me.status === 200 && typeof me.json?.accountId === 'string' && 'discoverable' in profile && 'bio' in profile && 'availability' in profile && 'notificationsEnabled' in profile,
  `${size(me)}, fields=${Object.keys(profile).sort().join(',')}`,
);
const counts = await A('/me/counts');
record(
  'GET /me/counts has connections/calls/following/saved',
  counts.status === 200 && ['connections', 'calls', 'following', 'saved'].every((k) => typeof counts.json?.[k] === 'number'),
  `${size(counts)}, ${JSON.stringify(counts.json ?? {})}`,
);
const originalExtras = {
  bio: profile.bio ?? '',
  availability: profile.availability ?? 'auto',
  notificationsEnabled: profile.notificationsEnabled !== false,
};
const patched = await A('/profile', jsonInit('PATCH', { bio: 'contract probe', availability: 'busy', notificationsEnabled: false }));
record(
  'PATCH /profile round trip (bio/availability/notifications)',
  patched.status === 200 && patched.json?.bio === 'contract probe' && patched.json?.availability === 'busy' && patched.json?.notificationsEnabled === false,
  size(patched),
);
const meAfter = await A('/me');
record('GET /me reflects the patch', meAfter.json?.profile?.availability === 'busy' && meAfter.json?.profile?.bio === 'contract probe', size(meAfter));
const restored = await A('/profile', jsonInit('PATCH', originalExtras));
record('PATCH /profile restores the original values', restored.status === 200 && restored.json?.availability === originalExtras.availability, size(restored));
const avatar = await A(`/avatars/${encodeURIComponent(a.accountId)}`);
record(
  'GET /avatars/:me answers 200 image or 404',
  (avatar.status === 200 && avatar.type.startsWith('image/')) || avatar.status === 404,
  `${size(avatar)}${avatar.type ? `, ${avatar.type}` : ''}`,
);
const verification = await A('/verification');
record('GET /verification reports the trust state', verification.status === 200 && typeof verification.json?.email === 'string', `${size(verification)}, email=${verification.json?.email}`);

// ---------------------------------------------------------------- contacts
console.log('\nContacts and presence');
const contacts = await A('/contacts');
record(
  'GET /contacts has contacts/requests/sent',
  contacts.status === 200 && Array.isArray(contacts.json?.contacts) && Array.isArray(contacts.json?.requests) && Array.isArray(contacts.json?.sent),
  `${size(contacts)}, contacts=${contacts.json?.contacts?.length ?? '?'}, requests=${contacts.json?.requests?.length ?? '?'}, sent=${contacts.json?.sent?.length ?? '?'}`,
);
const suggestions = await A('/contacts/suggestions');
record('GET /contacts/suggestions lists people', suggestions.status === 200 && Array.isArray(suggestions.json?.suggestions), `${size(suggestions)}, ${suggestions.json?.suggestions?.length ?? '?'} suggested`);
const heartbeat = await A('/presence/heartbeat', jsonInit('POST', { state: 'active' }));
record('POST /presence/heartbeat accepts active', heartbeat.status === 200, size(heartbeat));
const heartbeatBad = await A('/presence/heartbeat', jsonInit('POST', { state: 'away' }));
record("POST /presence/heartbeat refuses 'away' (that is a profile setting)", heartbeatBad.status === 400, size(heartbeatBad));

// The messaging partner: sign in, or create one if allowed.
let b = null;
let B = null;
let createdB = false;
if (emailB !== null && passwordB !== null) {
  b = await signIn(emailB, passwordB);
  record('second probe account signs in', b.status === 200 && b.token !== null, `HTTP ${b.status}`);
  if (b.token === null) b = null;
}
if (b === null) {
  const suffix = randomBytes(3).toString('hex');
  const email = `probe-contract-${suffix}@consummate7.com`;
  const username = `probecontract${suffix}`;
  const password = `Pc-${randomBytes(12).toString('base64url')}`;
  const r = await client(null)('/accounts', jsonInit('POST', { email, password, username, client: 'device' }));
  if (r.status === 201 && typeof r.json?.token === 'string') {
    b = { token: r.json.token, accountId: r.json.accountId, status: 201 };
    createdB = true;
    const pwPath = process.env.PROBE_CREATED_PASSWORD_FILE ?? null;
    if (pwPath) writeFileSync(pwPath, `${email}\n${password}\n`, { mode: 0o600 });
    created.push(`account ${email} (username c7${username})`);
    record('POST /accounts creates a partner probe account (device class)', r.json?.expiresInSeconds === DEVICE_LIFETIME_SECONDS, `${size(r)}, expiresInSeconds=${r.json?.expiresInSeconds}`);
  } else {
    record('POST /accounts creates a partner probe account', false, `${size(r)}${r.json?.error ? `, ${r.json.error}` : ''}`);
  }
}
if (b !== null) B = client(b.token);

let contactMade = false;
let partnerReachable = false;
if (B !== null) {
  const already = (contacts.json?.contacts ?? []).some((c) => c.accountId === b.accountId);
  if (already) {
    partnerReachable = true;
    record('partner is already a contact', true, 'no request needed');
  } else {
    const bMe = await B('/me');
    const bUsername = bMe.json?.profile?.username ?? null;
    const bDiscoverable = bMe.json?.profile?.discoverable === true;
    if (!bDiscoverable) {
      const disc = await B('/accounts/discovery', jsonInit('POST', { discoverable: true }));
      record('POST /accounts/discovery makes the partner findable', disc.status === 200 && disc.json?.discoverable === true, size(disc));
    }
    const req = await A('/contacts/request', jsonInit('POST', { username: bUsername ?? '' }));
    record('POST /contacts/request by username', req.status === 200 || req.status === 201, size(req));
    const bContacts = await B('/contacts');
    const incoming = (bContacts.json?.requests ?? []).some((r) => r.accountId === a.accountId);
    record('partner sees the request in GET /contacts.requests', incoming, size(bContacts));
    const accept = await B('/contacts/accept', jsonInit('POST', { accountId: a.accountId }));
    record('POST /contacts/accept', accept.status === 200 || accept.status === 201, size(accept));
    contactMade = accept.status === 200 || accept.status === 201;
    partnerReachable = contactMade;
    if (!bDiscoverable) await B('/accounts/discovery', jsonInit('POST', { discoverable: false }));
  }
  const bHeartbeat = await B('/presence/heartbeat', jsonInit('POST', { state: 'active' }));
  const presence = await A(`/presence?ids=${encodeURIComponent(b.accountId)}`);
  record(
    'GET /presence shows an accepted contact as active',
    bHeartbeat.status === 200 && presence.status === 200 && presence.json?.presence?.[b.accountId] === 'active',
    `${size(presence)}, state=${presence.json?.presence?.[b.accountId] ?? '(absent)'}`,
  );
  const person = await A(`/profiles/${encodeURIComponent(b.accountId)}`);
  record(
    "GET /profiles/:id says relationship 'contact'",
    person.status === 200 && person.json?.relationship === 'contact',
    `${size(person)}, relationship=${person.json?.relationship}`,
  );
}

// ----------------------------------------------------------- person profile
/*
 * ANOTHER PERSON'S PROFILE, as routes.ts rules it (29 Aug 2026): "the
 * language they SPEAK (what a call sounds like) -- never the language they
 * prefer to listen in". Asserted field by field, in both directions: the
 * fields that must be there, and the owner-only fields that must not. A
 * serializer widened by one line is exactly how the listening language
 * would reach every viewer, and nothing else in the tree would notice.
 */
console.log('\nPerson profile (routes.ts GET /profiles/:accountId)');
const PERSON_PUBLIC_FIELDS = new Set([
  'accountId',
  'username',
  'displayName',
  'official',
  'discoverable',
  'spokenLanguage',
  'bio',
  'relationship',
  // A contact's privilege only; a stranger's profile carries none.
  'presence',
]);
const PERSON_OWNER_ONLY_FIELDS = [
  'listeningLanguage',
  'defaultLanguage',
  'email',
  'availability',
  'notificationsEnabled',
  'notificationPreferences',
  'trust',
  'capabilities',
  'workspaces',
  'outstandingConsents',
  'consents',
  'discoveryMode',
];
const personTargetId = B === null ? a.accountId : b.accountId;
const personView = await A(`/profiles/${encodeURIComponent(personTargetId)}`);
const personBody = personView.json ?? {};
const personFields = Object.keys(personBody);
record(
  'GET /profiles/:id answers with the viewer-facing shape',
  personView.status === 200 &&
    typeof personBody.accountId === 'string' &&
    typeof personBody.relationship === 'string' &&
    'displayName' in personBody &&
    'username' in personBody,
  `${size(personView)}, fields=${personFields.slice().sort().join(',')}`,
);
record(
  'it carries spokenLanguage and NEVER the listening language',
  personView.status === 200 && 'spokenLanguage' in personBody && !('listeningLanguage' in personBody),
  `spokenLanguage=${'spokenLanguage' in personBody}, listeningLanguage=${'listeningLanguage' in personBody}`,
);
const personLeaks = PERSON_OWNER_ONLY_FIELDS.filter((field) => field in personBody);
record(
  'it carries none of the owner-only fields',
  personLeaks.length === 0,
  personLeaks.length === 0
    ? `${PERSON_OWNER_ONLY_FIELDS.length} owner-only names checked, none present`
    : `present=${personLeaks.join(',')}`,
);
const personExtra = personFields.filter((field) => !PERSON_PUBLIC_FIELDS.has(field));
record(
  'it adds no field the phone does not parse',
  personExtra.length === 0,
  personExtra.length === 0 ? `${personFields.length} known fields` : `unknown=${personExtra.join(',')}`,
);
const personAnon = await client(null)(`/profiles/${encodeURIComponent(personTargetId)}`);
record('GET /profiles/:id refuses without a session', personAnon.status === 401, size(personAnon));
const personUnknown = await A('/profiles/acct_00000000000000ff');
record(
  'an unknown account answers 404, so the route is not an existence oracle',
  personUnknown.status === 404,
  size(personUnknown),
);

// ---------------------------------------------------------------- messaging
console.log('\nMessaging (message-routes.ts)');
const sentIds = [];
if (B === null || !partnerReachable) {
  skip('messaging round trip', 'no reachable partner account');
} else {
  const text = await A(`/messages/with/${b.accountId}`, jsonInit('POST', { body: 'contract probe: hello' }));
  const textId = text.json?.message?.messageId ?? null;
  record('POST /messages/with/:id sends a text', text.status === 201 || text.status === 200, `${size(text)}, kind=${text.json?.message?.kind}`);
  if (textId) sentIds.push(textId);

  const readBack = await B(`/messages/with/${a.accountId}`);
  const seen = (readBack.json?.messages ?? []).find((m) => m.messageId === textId);
  record('partner reads it back via GET /messages/with/:id', readBack.status === 200 && seen?.body === 'contract probe: hello', size(readBack));
  const conversations = await B('/messages/conversations');
  record('GET /messages/conversations lists the thread with unread=1', conversations.status === 200 && (conversations.json?.conversations ?? []).some((c) => c.partner?.accountId === a.accountId && c.unread >= 1), size(conversations));
  const markRead = await B(`/messages/with/${a.accountId}/read`, jsonInit('POST', {}));
  record('POST /messages/with/:id/read', markRead.status === 200, size(markRead));

  const mode = await A(`/messages/with/${b.accountId}/mode`);
  record('GET /messages/with/:id/mode', mode.status === 200 && (mode.json?.mode === 'normal' || mode.json?.mode === 'translated'), `${size(mode)}, mode=${mode.json?.mode}`);

  // Voice note: a real WAV container; the server keeps the bytes verbatim.
  const wav = oneSecondWav();
  const voice = await A(`/messages/with/${b.accountId}/voice`, jsonInit('POST', { audioBase64: wav.toString('base64'), durationMs: 1000 }));
  const voiceId = voice.json?.message?.messageId ?? null;
  record('POST /messages/with/:id/voice accepts a 1 s WAV', (voice.status === 201 || voice.status === 200) && voice.json?.message?.kind === 'voice', `${size(voice)}, sent ${wav.length} B`);
  if (voiceId) sentIds.push(voiceId);
  if (voiceId) {
    const media = await B(`/messages/media/${voiceId}`);
    record(
      'GET /messages/media/:id returns the same bytes',
      media.status === 200 && media.bytes.length === wav.length && media.bytes.equals(wav),
      `${size(media)}, ${media.type}`,
    );
    /*
     * TRANSLATED-NOTE ASSETS. `translatedAudioAvailable` is the flag the chat
     * bubble reads to offer the translated play button; the route is what the
     * button fetches. They must agree, or the phone shows a control that
     * fetches a 404 -- and a translated asset must never be readable without
     * a session, because it is the same private speech in another language.
     */
    const translated = await B(`/messages/${voiceId}/voice/translated`);
    const available = voice.json?.message?.translatedAudioAvailable === true;
    record(
      'GET /messages/:id/voice/translated agrees with translatedAudioAvailable',
      available ? translated.status === 200 : translated.status === 404,
      `${size(translated)}, translatedAudioAvailable=${available}`,
    );
    record(
      'a present translated asset is real audio bytes',
      available ? translated.bytes.length > 0 && translated.type.startsWith('audio/') : true,
      available ? `${translated.bytes.length} B, ${translated.type || '(no content-type)'}` : 'no translated asset to check',
    );
    const translatedAnon = await client(null)(`/messages/${voiceId}/voice/translated`);
    record(
      'the translated asset is refused without a session',
      translatedAnon.status === 401,
      size(translatedAnon),
    );
    const stranger = await client(null)(`/messages/media/${voiceId}`);
    record('voice media is refused without a session', stranger.status === 401, size(stranger));
  }

  if (textId) {
    const edited = await A(`/messages/${textId}`, jsonInit('PATCH', { body: 'contract probe: edited' }));
    record('PATCH /messages/:id edits own text', edited.status === 200 && edited.json?.message?.body === 'contract probe: edited' && typeof edited.json?.message?.editedAtMs === 'number', size(edited));
    const reaction = await B(`/messages/${textId}/reaction`, jsonInit('PUT', { emoji: '👍' }));
    record('PUT /messages/:id/reaction', reaction.status === 200 && Array.isArray(reaction.json?.reactions), size(reaction));
    const unreact = await B(`/messages/${textId}/reaction`, jsonInit('PUT', { emoji: null }));
    record('PUT /messages/:id/reaction null clears it', unreact.status === 200, size(unreact));
    const pinned = await A(`/messages/${textId}/pin`, jsonInit('PUT', { pinned: true }));
    record('PUT /messages/:id/pin', pinned.status === 200 && pinned.json?.pinnedByMe === true, size(pinned));
    const pins = await A(`/messages/with/${b.accountId}/pinned`);
    record('GET /messages/with/:id/pinned lists it', pins.status === 200 && (pins.json?.messages ?? []).some((m) => m.messageId === textId), size(pins));
    await A(`/messages/${textId}/pin`, jsonInit('PUT', { pinned: false }));
    const search = await A(`/messages/with/${b.accountId}/search?q=${encodeURIComponent('edited')}`);
    record('GET /messages/with/:id/search finds the edit', search.status === 200 && (search.json?.messages ?? []).some((m) => m.messageId === textId), size(search));
    const hide = await B(`/messages/${textId}/hide`, { method: 'POST' });
    const hiddenView = await B(`/messages/with/${a.accountId}`);
    const hiddenGone = !(hiddenView.json?.messages ?? []).some((m) => m.messageId === textId);
    record('POST /messages/:id/hide removes it from the hider view', hide.status === 200 && hiddenGone, size(hide));
    const unhide = await B(`/messages/${textId}/hide`, { method: 'DELETE' });
    const backView = await B(`/messages/with/${a.accountId}`);
    record('DELETE /messages/:id/hide undoes it', unhide.status === 200 && (backView.json?.messages ?? []).some((m) => m.messageId === textId), size(unhide));
    const settings = await B(`/messages/with/${a.accountId}/settings`, jsonInit('PUT', { muted: true }));
    record('PUT /messages/with/:id/settings mute', settings.status === 200 && settings.json?.muted === true, size(settings));
    await B(`/messages/with/${a.accountId}/settings`, jsonInit('PUT', { muted: false }));
  }
}

// -------------------------------------------------------- channel identity
/*
 * CHANNEL IDENTITY (channel-routes.ts). Two views of one channel: the
 * owner's, which names the owner, and everybody else's, which is built
 * field by field precisely so a field added to the record later is public
 * only when somebody decides it is. The assertion that matters is that
 * `ownerAccountId` never crosses into the public one -- a channel handle is
 * a public name, and the account behind it is not.
 */
console.log('\nChannel identity (channel-routes.ts) -- server serialisation; /channels/mine is the console\'s route, not the phone\'s');
const OWNER_CHANNEL_FIELDS = [
  'channelId',
  'ownerAccountId',
  'handle',
  'displayName',
  'description',
  'category',
  'visibility',
  'avatarUrl',
  'bannerUrl',
  'createdAt',
  'updatedAt',
];
const owned = await A('/channels/mine');
let ownedChannel = null;
if (owned.status === 200) {
  ownedChannel = owned.json ?? {};
  record(
    'GET /channels/mine is the OWNER view (ownerAccountId present)',
    OWNER_CHANNEL_FIELDS.every((field) => field in ownedChannel),
    `${size(owned)}, fields=${Object.keys(ownedChannel).sort().join(',')}`,
  );
} else if (owned.status === 404) {
  record('GET /channels/mine answers 404 when the probe owns no channel', true, size(owned));
} else {
  record('GET /channels/mine answers 200 or 404', false, size(owned));
}
const ownedAnon = await client(null)('/channels/mine');
record('GET /channels/mine refuses without a session', ownedAnon.status === 401, size(ownedAnon));
if (ownedChannel === null) {
  skip('the public views of the probe channel', 'this probe owns no channel');
} else {
  const publicByHandle = await client(null)(`/streams/${encodeURIComponent(String(ownedChannel.handle ?? ''))}`);
  const publicById = await client(null)(`/channels/${encodeURIComponent(String(ownedChannel.channelId))}/profile`);
  record(
    'GET /streams/:myHandle hides ownerAccountId',
    publicByHandle.status === 200 && !('ownerAccountId' in (publicByHandle.json ?? {})),
    `${size(publicByHandle)}, keys=${Object.keys(publicByHandle.json ?? {}).sort().join(',')}`,
  );
  record(
    'GET /channels/:id/profile hides ownerAccountId',
    publicById.status === 200 && !('ownerAccountId' in (publicById.json ?? {})),
    `${size(publicById)}, keys=${Object.keys(publicById.json ?? {}).sort().join(',')}`,
  );
  const identityFields = ['channelId', 'handle', 'displayName', 'category', 'visibility'];
  const agrees =
    identityFields.every((field) => publicByHandle.json?.[field] === ownedChannel[field]) &&
    publicById.json?.channelId === ownedChannel.channelId;
  record(
    'both public views agree with the owner view on identity',
    agrees,
    `handle=${publicByHandle.json?.handle}, category=${publicByHandle.json?.category}, visibility=${publicByHandle.json?.visibility}`,
  );
}

// ---------------------------------------------------------------- channels
console.log('\nChannels');
const stream = await client(null)(`/streams/${encodeURIComponent(streamHandle)}`);
record(`GET /streams/${streamHandle} resolves publicly`, stream.status === 200 && typeof stream.json?.channelId === 'string' && !('ownerAccountId' in (stream.json ?? {})), `${size(stream)}, keys=${Object.keys(stream.json ?? {}).sort().join(',')}`);
const channelId = stream.json?.channelId ?? null;
const missing = await client(null)('/streams/no-such-handle-xyz');
record('GET /streams/:unknown answers 404', missing.status === 404, size(missing));
const follows0 = await A('/channels/follows');
record('GET /channels/follows', follows0.status === 200 && Array.isArray(follows0.json?.follows), `${size(follows0)}, ${follows0.json?.follows?.length ?? '?'} follows`);
if (channelId) {
  const wasFollowing = (follows0.json?.follows ?? []).some((f) => f.channelId === channelId);
  const follow = await A(`/channels/${encodeURIComponent(channelId)}/follow`, jsonInit('PUT', { following: true, remind: true }));
  record('PUT /channels/:id/follow with remind', follow.status === 200 && follow.json?.following === true && follow.json?.remind === true, size(follow));
  const interest = await client(null)(`/channels/interest?ids=${encodeURIComponent(channelId)}`);
  record('GET /channels/interest counts the follow publicly', interest.status === 200 && typeof interest.json?.counts?.[channelId] === 'number' && interest.json.counts[channelId] >= 1, `${size(interest)}, count=${interest.json?.counts?.[channelId]}`);
  const countsAfter = await A('/me/counts');
  record('GET /me/counts.following reflects it', countsAfter.json?.following >= 1, `following=${countsAfter.json?.following}`);
  if (!wasFollowing) {
    const unfollow = await A(`/channels/${encodeURIComponent(channelId)}/follow`, jsonInit('PUT', { following: false }));
    record('PUT /channels/:id/follow false restores', unfollow.status === 200 && unfollow.json?.following === false, size(unfollow));
  }
  const byId = await client(null)(`/channels/${encodeURIComponent(channelId)}/profile`);
  record('GET /channels/:id/profile matches the handle route', byId.status === 200 && byId.json?.handle === stream.json?.handle, size(byId));
}

// ------------------------------------------------------- programme listing
/*
 * THE PROGRAMME DIRECTORY, as channelDirectory.ts reads it. There is no HTTP
 * form of it on purpose ("inventing one would be a second source of truth"),
 * so this connects a LISTENER socket exactly as the phone does and parses
 * the `channel:directory` payload by the phone's own rules: a row with no
 * tiered visibility is not a channel, a handle off CHANNEL_HANDLE_SHAPE is
 * null, and a category outside the controlled list is null -- category is
 * READ, never inferred (founder ruling 29 Aug 2026).
 */
console.log('\nProgramme listing (channelDirectory.ts — the listener socket)');
const CHANNEL_HANDLE_SHAPE = /^[a-z0-9_]{3,24}$/;
const CHANNEL_CATEGORY_IDS = new Set([
  'news',
  'faith',
  'business',
  'education',
  'culture',
  'music',
  'sport',
  'community',
  'technology',
  'health',
  'government',
  'entertainment',
]);
const CHANNEL_VISIBILITIES = new Set(['public', 'private', 'locked']);
if (socketIo === null) {
  blocked('the listener socket publishes channel:directory', 'socket.io-client is not installed in this checkout');
} else {
  const directory = await new Promise((resolve) => {
    const socket = socketIo(GATEWAY, {
      query: { role: 'listener' },
      reconnection: false,
      timeout: 15_000,
      extraHeaders: { 'user-agent': USER_AGENT },
    });
    let timer = null;
    const finish = (value) => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      socket.removeAllListeners();
      socket.disconnect();
      resolve(value);
    };
    timer = setTimeout(() => finish({ error: 'no channel:directory within 20 s' }), 20_000);
    socket.on('connect_error', (error) => finish({ error: `connect_error: ${error.message}` }));
    socket.on('channel:directory', (payload) => finish({ rows: Array.isArray(payload) ? payload : null }));
  });
  if (directory.error !== undefined) {
    record('the listener socket publishes channel:directory on connect', false, directory.error);
  } else {
    const rows = directory.rows ?? [];
    record(
      'the listener socket publishes channel:directory on connect',
      Array.isArray(directory.rows),
      `${rows.length} row(s)`,
    );
    const parseable = rows.filter(
      (row) =>
        row !== null &&
        typeof row === 'object' &&
        typeof row.channelId === 'string' &&
        typeof row.displayName === 'string' &&
        CHANNEL_VISIBILITIES.has(row.visibility),
    );
    record(
      'every row parses as a channel summary (id, name, tiered visibility)',
      parseable.length === rows.length,
      `${parseable.length}/${rows.length} rows parse`,
    );
    if (rows.length === 0) {
      blocked('the identity fields the phone reads are on the row', 'no channel is listed on this deployment');
    } else {
      const identityKeys = ['handle', 'avatarUrl', 'category', 'currentProgramme'];
      const missingIdentity = rows.filter((row) => !identityKeys.every((key) => key in row));
      record(
        'every row carries handle, avatarUrl, category and currentProgramme',
        missingIdentity.length === 0,
        `${rows.length - missingIdentity.length}/${rows.length} rows, keys=${Object.keys(rows[0]).sort().join(',')}`,
      );
      const badHandle = rows.filter(
        (row) => row.handle !== null && !(typeof row.handle === 'string' && CHANNEL_HANDLE_SHAPE.test(row.handle)),
      );
      record(
        'every handle is null or on CHANNEL_HANDLE_SHAPE',
        badHandle.length === 0,
        badHandle.length === 0 ? `${rows.length} row(s) checked` : `${badHandle.length} off-shape`,
      );
      const badCategory = rows.filter((row) => row.category !== null && !CHANNEL_CATEGORY_IDS.has(row.category));
      record(
        'every category is null or one of the twelve controlled ids',
        badCategory.length === 0,
        badCategory.length === 0
          ? `categories=${[...new Set(rows.map((row) => String(row.category)))].join(',')}`
          : `${badCategory.length} unknown`,
      );
      const badProgramme = rows.filter(
        (row) => row.currentProgramme !== null && typeof row.currentProgramme !== 'string',
      );
      record(
        'currentProgramme is a string or null',
        badProgramme.length === 0,
        `live=${rows.filter((row) => row.live === true).length}/${rows.length}`,
      );
    }
  }
}

// ---------------------------------------------------------------- calls
console.log('\nCalls (gateway app.ts) and voice (media-ingest)');
const publicCalls = await client(null)('/calls/public', {}, GATEWAY);
record('GET /calls/public lists public conferences', publicCalls.status === 200 && Array.isArray(publicCalls.json?.calls), `${size(publicCalls)}, ${publicCalls.json?.calls?.length ?? '?'} rooms`);
const status = await client(null)('/calls/ZZZZZZ/status', {}, GATEWAY);
record('GET /calls/:id/status answers a status word only', status.status === 200 && typeof status.json?.status === 'string' && Object.keys(status.json).length === 1, `${size(status)}, status=${status.json?.status}`);
const direct = await client(null)('/calls/direct/ZZZZZZ', {}, GATEWAY);
record('GET /calls/direct/:id refuses anonymously (401/404)', direct.status === 401 || direct.status === 404, size(direct));
const voiceMine = await A('/voice-profiles/mine', {}, MEDIA);
record('GET /media/voice-profiles/mine with the account token', voiceMine.status === 200 && typeof voiceMine.json?.enrolled === 'boolean', `${size(voiceMine)}, enrolled=${voiceMine.json?.enrolled}`);
const voiceAnon = await client(null)('/voice-profiles/mine', {}, MEDIA);
record('GET /media/voice-profiles/mine refuses without a token', voiceAnon.status === 401, size(voiceAnon));
const rings = await A('/rings');
record('GET /rings (the phone polls this on resume)', rings.status === 200 && Array.isArray(rings.json?.rings), `${size(rings)}, ${rings.json?.rings?.length ?? '?'} pending`);

// ------------------------------------------------------ ICE and TURN
/*
 * THE RELAY CREDENTIAL. Fetched fresh per call by fetchIceServers
 * (callWebRtc.ts) rather than baked into a bundle, because the credential
 * expires -- that is the whole design of the TURN REST API here: the
 * username IS the expiry and the password is an HMAC of it.
 *
 * FOUNDER RULING (LOCKED, 30 Aug 2026): "TURN is NEVER behind the ordinary
 * Cloudflare proxy: either the proven direct-origin arrangement
 * (169.58.215.77) or an optional DNS-only turn.consummate7.com A record."
 * So the host is resolved and checked against Cloudflare's published ranges
 * and against the app host's own addresses. Nothing about the credential is
 * printed: only whether it exists and how long it has left.
 */
console.log('\nICE and TURN credentials (callWebRtc.ts fetchIceServers)');
/** Cloudflare's published IPv4 edge ranges. A TURN A record inside one is proxied. */
const CLOUDFLARE_V4 = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
];
const toInt = (address) =>
  address.split('.').reduce((total, octet) => total * 256 + Number.parseInt(octet, 10), 0);
const inRange = (address, cidr) => {
  const [network, bits] = cidr.split('/');
  const mask = bits === '0' ? 0 : (0xffffffff << (32 - Number.parseInt(bits, 10))) >>> 0;
  return ((toInt(address) & mask) >>> 0) === ((toInt(network) & mask) >>> 0);
};
/*
 * The OS resolver FIRST, c-ares second. `resolve4` talks to a nameserver
 * directly and answers ECONNREFUSED on any machine whose DNS is a resolver
 * it cannot reach that way -- which reported "0 A records" for a host that
 * resolves perfectly, and turned a passing TURN check into a false failure.
 * `lookup` is what the phone's own network stack uses.
 */
const resolveHost = async (host) => {
  try {
    const answers = await lookup(host, { all: true, family: 4 });
    if (answers.length > 0) return answers.map((answer) => answer.address);
  } catch {
    /* fall through to the direct query */
  }
  try {
    return await resolve4(host);
  } catch {
    return [];
  }
};
const ice = await client(null)('/webrtc/ice', {}, GATEWAY);
const iceServers = Array.isArray(ice.json?.iceServers) ? ice.json.iceServers : [];
record(
  'GET /webrtc/ice serves the ICE list the phone fetches per call',
  ice.status === 200 && iceServers.length > 0 && ice.json?.relayConfigured === true,
  `${size(ice)}, ${iceServers.length} entries, relayConfigured=${ice.json?.relayConfigured}`,
);
const urlsOf = (entry) => (Array.isArray(entry?.urls) ? entry.urls : entry?.urls === undefined ? [] : [entry.urls]);
const stunEntry = iceServers.find((entry) => urlsOf(entry).some((url) => String(url).startsWith('stun:')));
const turnEntry = iceServers.find((entry) =>
  urlsOf(entry).some((url) => /^turns?:/.test(String(url))),
);
record(
  'the list carries STUN and a TURN entry (without TURN a phone on mobile data reaches nobody)',
  stunEntry !== undefined && turnEntry !== undefined,
  `stun=${stunEntry === undefined ? 0 : urlsOf(stunEntry).length} url(s), turn=${turnEntry === undefined ? 0 : urlsOf(turnEntry).length} url(s)`,
);
if (turnEntry === undefined) {
  blocked('the TURN host is not Cloudflare-proxied', 'this deployment offers no TURN entry');
  blocked('the TURN credential is time-limited', 'this deployment offers no TURN entry');
} else {
  const turnUrls = urlsOf(turnEntry).map(String);
  const turnHost = String(turnUrls[0] ?? '').replace(/^turns?:/, '').split(/[:?]/)[0];
  const turnAddresses = /^\d+\.\d+\.\d+\.\d+$/.test(turnHost) ? [turnHost] : await resolveHost(turnHost);
  const appHost = new URL(base).hostname;
  const appAddresses = await resolveHost(appHost);
  const proxied = turnAddresses.filter((address) => CLOUDFLARE_V4.some((cidr) => inRange(address, cidr)));
  const sharedWithApp = turnAddresses.filter((address) => appAddresses.includes(address));
  record(
    'the TURN host resolves, and to no Cloudflare edge address',
    turnAddresses.length > 0 && proxied.length === 0 && sharedWithApp.length === 0,
    `host=${turnHost}, ${turnAddresses.length} A record(s), inCloudflare=${proxied.length}, sharedWithAppHost=${sharedWithApp.length}`,
  );
  record(
    'TURN is offered over both UDP and TCP',
    turnUrls.some((url) => url.includes('transport=udp')) && turnUrls.some((url) => url.includes('transport=tcp')),
    `urls=${turnUrls.length}`,
  );
  /*
   * The username is the expiry in unix seconds, optionally `:label`. Parsed,
   * never printed -- what is printed is the remaining lifetime in seconds.
   */
  const expirySeconds = Number.parseInt(String(turnEntry.username ?? '').split(':')[0], 10);
  const remainingSeconds = Number.isFinite(expirySeconds) ? expirySeconds - Math.floor(Date.now() / 1000) : Number.NaN;
  record(
    'the TURN credential is time-limited (an expiry in the future, under 24 h)',
    typeof turnEntry.username === 'string' &&
      typeof turnEntry.credential === 'string' &&
      turnEntry.credential.length > 0 &&
      Number.isFinite(remainingSeconds) &&
      remainingSeconds > 0 &&
      remainingSeconds <= 24 * 60 * 60,
    `expires in ${Number.isFinite(remainingSeconds) ? remainingSeconds : '(unparsed)'} s, secret present=${typeof turnEntry.credential === 'string' && turnEntry.credential.length > 0}`,
  );
}
const iceMisnamed = await client(null)('/webrtc/ice-servers', {}, GATEWAY);
record(
  'the route is /webrtc/ice; /webrtc/ice-servers does not exist',
  ice.status === 200 && iceMisnamed.status === 404,
  `ice=${ice.status}, ice-servers=${iceMisnamed.status}`,
);

// ------------------------------------------- call creation and ringing
/*
 * CALL CREATION, the account service's half: the phone JOINS the call first
 * and rings second, because only a verified account may create one and
 * ring-then-join would race the callee into being the creator.
 * `reachedDevices: 0` is a real answer, not a failure -- it means the
 * contact has no registered phone and the caller should stop waiting.
 */
console.log('\nCall creation and ringing (message-routes.ts, ring-registry.ts)');
if (B === null || !partnerReachable) {
  skip('POST /contacts/:id/ring dispatches the wake-up', 'no reachable partner account');
} else {
  const ringCallId = `probe-${randomBytes(4).toString('hex')}`;
  const ring = await A(`/contacts/${encodeURIComponent(b.accountId)}/ring`, jsonInit('POST', { callId: ringCallId }));
  record(
    'POST /contacts/:id/ring answers with the call id and the devices reached',
    ring.status === 200 && ring.json?.callId === ringCallId && typeof ring.json?.reachedDevices === 'number',
    `${size(ring)}, reachedDevices=${ring.json?.reachedDevices}`,
  );
  const partnerRings = await B('/rings');
  const noted = (partnerRings.json?.rings ?? []).find((entry) => entry.callId === ringCallId);
  record(
    'the partner sees it in GET /rings, with the caller named',
    partnerRings.status === 200 && noted !== undefined && noted.fromAccountId === a.accountId && typeof noted.fromName === 'string',
    `${size(partnerRings)}, pending=${partnerRings.json?.rings?.length ?? '?'}`,
  );
  const dismissed = await B(`/rings/${encodeURIComponent(ringCallId)}/dismiss`, jsonInit('POST', {}));
  const afterDismiss = await B('/rings');
  record(
    'POST /rings/:id/dismiss clears the banner',
    dismissed.status === 200 && !(afterDismiss.json?.rings ?? []).some((entry) => entry.callId === ringCallId),
    size(dismissed),
  );
}

// -------------------------------------------------- direct-call lifecycle
/*
 * THE TELEPHONE (direct-call-lifecycle.ts). Every word a caller reads comes
 * from the server's state, never from a push result: calling -> ringing ->
 * answered, or declined, or no_answer. A push is only a wake-up, so a STALE
 * one must be answered honestly and stay silent (founder ruling 28 Aug).
 *
 * The three routes below are driven with the phone's own methods: GET for
 * the pre-join check, POST with no body for the acknowledgements.
 */
console.log('\nDirect-call lifecycle (gateway app.ts /calls/direct/*)');
const capabilities = Array.isArray(me.json?.capabilities) ? me.json.capabilities : [];
record(
  'GET /me states the capabilities the gateway gates call CREATION on',
  me.status === 200 && Array.isArray(me.json?.capabilities),
  `capabilities=${capabilities.join(',') || '(none)'}, trust=${me.json?.trust?.state ?? '?'}`,
);
const staleCallId = `probe-stale-${randomBytes(4).toString('hex')}`;
const staleCheck = await A(`/calls/direct/${staleCallId}`, {}, GATEWAY);
record(
  'a call the server never had answers 404 to a signed-in device (it invents nothing)',
  staleCheck.status === 404,
  size(staleCheck),
);
const staleRinging = await A(`/calls/direct/${staleCallId}/ringing`, { method: 'POST' }, GATEWAY);
record(
  'POST .../ringing on a stale call answers live=false rather than ringing the phone',
  staleRinging.status === 200 && staleRinging.json?.live === false,
  `${size(staleRinging)}, live=${staleRinging.json?.live}`,
);
const staleAnswering = await A(`/calls/direct/${staleCallId}/answering`, { method: 'POST' }, GATEWAY);
record(
  'POST .../answering on a stale call answers held=false',
  staleAnswering.status === 200 && staleAnswering.json?.held === false,
  `${size(staleAnswering)}, held=${staleAnswering.json?.held}`,
);
const staleDecline = await A(`/calls/direct/${staleCallId}/decline`, { method: 'POST' }, GATEWAY);
record(
  'POST .../decline on a stale call answers declined=false',
  staleDecline.status === 200 && staleDecline.json?.declined === false,
  `${size(staleDecline)}, declined=${staleDecline.json?.declined}`,
);
for (const [label, path, method] of [
  ['GET /calls/direct/:id', `/calls/direct/${staleCallId}`, 'GET'],
  ['POST /calls/direct/:id/ringing', `/calls/direct/${staleCallId}/ringing`, 'POST'],
  ['POST /calls/direct/:id/answering', `/calls/direct/${staleCallId}/answering`, 'POST'],
  ['POST /calls/direct/:id/decline', `/calls/direct/${staleCallId}/decline`, 'POST'],
]) {
  const anonymous = await client(null)(path, method === 'GET' ? {} : { method }, GATEWAY);
  record(`${label} refuses without a session`, anonymous.status === 401, size(anonymous));
}

/*
 * Creating one needs `session.host`, which the account service grants only
 * to a VERIFIED account. Whoever holds it drives the state machine; when
 * nobody does, the refusal itself is asserted -- a gate that fails open is
 * the defect this check exists for -- and the lifecycle is reported BLOCKED
 * rather than quietly skipped.
 */
let hostToken = capabilities.includes('session.host') ? a.token : null;
let hostAccountId = hostToken === null ? null : a.accountId;
if (hostToken === null && process.env.PROBE_HOST_EMAIL) {
  const hostPassword = readSecretFile('PROBE_HOST_PASSWORD_FILE', 'PROBE_PASSWORD_FILE');
  if (hostPassword !== null) {
    const host = await signIn(process.env.PROBE_HOST_EMAIL, hostPassword);
    record('the configured host probe signs in', host.status === 200 && host.token !== null, `HTTP ${host.status}`);
    if (host.token !== null) {
      hostToken = host.token;
      hostAccountId = host.accountId;
    }
  }
}
let lifecycleDriven = false;
if (socketIo === null) {
  blocked('calling -> ringing -> answered / declined / no_answer', 'socket.io-client is not installed in this checkout');
} else if (B === null) {
  blocked('calling -> ringing -> answered / declined / no_answer', 'no second probe account to call');
} else if (hostToken === null) {
  const refused = await callJoin(a.token, `probe-${randomBytes(4).toString('hex')}`, b.accountId);
  refused.socket?.disconnect();
  record(
    'the gateway refuses call CREATION without session.host, BY NAME (it does not fail open)',
    refused.ok === false && refused.code === 'host-not-authorized',
    `ok=${refused.ok}, code=${refused.code ?? '(none)'}`,
  );
  blocked(
    'calling -> ringing -> answered / declined / no_answer',
    `no probe holds session.host (trust=${me.json?.trust?.state ?? '?'}, email=${me.json?.trust?.email ?? '?'}); set PROBE_HOST_EMAIL and PROBE_HOST_PASSWORD_FILE to a verified account`,
  );
} else {
  lifecycleDriven = true;
  const HOST = client(hostToken);

  // ---- the answered lane
  const answeredCallId = `probe-${randomBytes(5).toString('hex')}`;
  const answeredCall = await callJoin(hostToken, answeredCallId, b.accountId);
  record(
    'call:join naming directPeerAccountId CREATES the direct call',
    answeredCall.ok === true,
    `ok=${answeredCall.ok}, code=${answeredCall.code ?? '-'}, directState=${answeredCall.directState?.state ?? '(absent)'}`,
  );
  const peerCheck = await B(`/calls/direct/${answeredCallId}`, {}, GATEWAY);
  record(
    "the callee's pre-join check says ring, in state 'calling', with the caller named",
    peerCheck.status === 200 &&
      peerCheck.json?.ring === true &&
      peerCheck.json?.state === 'calling' &&
      typeof peerCheck.json?.callerName === 'string' &&
      (peerCheck.json?.mode === 'normal' || peerCheck.json?.mode === 'translated'),
    `${size(peerCheck)}, ring=${peerCheck.json?.ring}, state=${peerCheck.json?.state}, mode=${peerCheck.json?.mode}`,
  );
  const callerCheck = await HOST(`/calls/direct/${answeredCallId}`, {}, GATEWAY);
  record(
    'the pre-join check answers the CALLEE and nobody else (the caller included)',
    callerCheck.status === 404,
    `caller sees HTTP ${callerCheck.status}`,
  );
  const ringingAck = await B(`/calls/direct/${answeredCallId}/ringing`, { method: 'POST' }, GATEWAY);
  record(
    'POST .../ringing acknowledges the live call',
    ringingAck.status === 200 && ringingAck.json?.live === true,
    `${size(ringingAck)}, live=${ringingAck.json?.live}`,
  );
  const afterRinging = await B(`/calls/direct/${answeredCallId}`, {}, GATEWAY);
  record(
    'calling -> ringing',
    afterRinging.json?.state === 'ringing',
    `state=${afterRinging.json?.state}`,
  );
  const answering = await B(`/calls/direct/${answeredCallId}/answering`, { method: 'POST' }, GATEWAY);
  record(
    'POST .../answering holds the ringing window while the app comes up',
    answering.status === 200 && answering.json?.held === true,
    `${size(answering)}, held=${answering.json?.held}`,
  );
  const peerJoin = await callJoin(b.token, answeredCallId, hostAccountId ?? undefined);
  record('the callee joins the existing call (no verification needed)', peerJoin.ok === true, `ok=${peerJoin.ok}, code=${peerJoin.code ?? '-'}`);
  const afterAnswer = await B(`/calls/direct/${answeredCallId}`, {}, GATEWAY);
  record(
    'ringing -> answered (the join is the answer, not the push)',
    ['answered', 'connecting', 'connected'].includes(String(afterAnswer.json?.state)),
    `state=${afterAnswer.json?.state}, answeredAtMs set=${typeof afterAnswer.json?.answeredAtMs === 'number'}`,
  );
  peerJoin.socket?.disconnect();
  answeredCall.socket?.disconnect();
  await sleep(3000);
  const afterHangUp = await B(`/calls/direct/${answeredCallId}`, {}, GATEWAY);
  record(
    'hanging up ends it, and the stale check stops ringing',
    afterHangUp.status === 404 || (afterHangUp.json?.ring === false && String(afterHangUp.json?.state) === 'ended'),
    afterHangUp.status === 404 ? 'HTTP 404 (forgotten)' : `state=${afterHangUp.json?.state}, ring=${afterHangUp.json?.ring}`,
  );

  // ---- the declined lane
  const declinedCallId = `probe-${randomBytes(5).toString('hex')}`;
  const declinedCall = await callJoin(hostToken, declinedCallId, b.accountId);
  await B(`/calls/direct/${declinedCallId}/ringing`, { method: 'POST' }, GATEWAY);
  const declined = await B(`/calls/direct/${declinedCallId}/decline`, { method: 'POST' }, GATEWAY);
  record(
    'POST .../decline declines a ringing call',
    declined.status === 200 && declined.json?.declined === true,
    `${size(declined)}, declined=${declined.json?.declined}`,
  );
  const afterDecline = await B(`/calls/direct/${declinedCallId}`, {}, GATEWAY);
  record(
    'ringing -> declined, and a late push finds ring=false',
    afterDecline.json?.state === 'declined' && afterDecline.json?.ring === false,
    `state=${afterDecline.json?.state}, ring=${afterDecline.json?.ring}`,
  );
  const secondDecline = await B(`/calls/direct/${declinedCallId}/decline`, { method: 'POST' }, GATEWAY);
  record(
    'declining twice is honest about the second one',
    secondDecline.status === 200 && secondDecline.json?.declined === false,
    `declined=${secondDecline.json?.declined}`,
  );
  declinedCall.socket?.disconnect();

  // ---- the no-answer lane
  if (process.env.PROBE_NO_ANSWER_WAIT === '0') {
    skip('ringing -> no_answer after the 30 s window', 'PROBE_NO_ANSWER_WAIT=0');
  } else {
    const silentCallId = `probe-${randomBytes(5).toString('hex')}`;
    const silentCall = await callJoin(hostToken, silentCallId, b.accountId);
    await B(`/calls/direct/${silentCallId}/ringing`, { method: 'POST' }, GATEWAY);
    console.log('    (waiting 35 s for the ringing window to close)');
    await sleep(35_000);
    const afterWindow = await B(`/calls/direct/${silentCallId}`, {}, GATEWAY);
    record(
      'nobody answers within the window -> no_answer, and the check stops ringing',
      afterWindow.status === 200 && afterWindow.json?.state === 'no_answer' && afterWindow.json?.ring === false,
      `${size(afterWindow)}, state=${afterWindow.json?.state}, ring=${afterWindow.json?.ring}`,
    );
    silentCall.socket?.disconnect();
  }
}

// ------------------------------------------------------------ call history
/*
 * CALL HISTORY. Founder ruling (29 Aug 2026): "calls are part of the
 * conversation" -- a finished direct call rides the SAME timeline as the
 * messages, newest first, direction relative to the reader, told apart by
 * `kind: 'call'`. This is the only place the phone reads call history from,
 * so it is read here the way the chat screen reads it.
 */
console.log('\nCall history (the account timeline the chat screen reads)');
if (B === null || !partnerReachable) {
  skip('a finished call appears in the conversation timeline', 'no reachable partner account');
} else {
  const timeline = await A(`/messages/with/${b.accountId}`);
  const items = Array.isArray(timeline.json?.messages) ? timeline.json.messages : [];
  const callItems = items.filter((item) => item?.kind === 'call');
  record(
    'GET /messages/with/:id returns ONE timeline of messages and calls',
    timeline.status === 200 && Array.isArray(timeline.json?.messages),
    `${size(timeline)}, ${items.length} items, ${callItems.length} of kind 'call'`,
  );
  const atMsOf = (item) => (item?.kind === 'call' ? item.endedAtMs : item?.createdAtMs);
  const ordered = items.every((item, index) => index === 0 || atMsOf(items[index - 1]) >= atMsOf(item));
  record('the timeline is newest first', ordered, `${items.length} items checked`);
  if (callItems.length === 0) {
    blocked(
      'a kind:"call" item carries the fields the chat screen renders',
      lifecycleDriven
        ? 'the driven calls have not been recorded against this pair yet'
        : 'no completed direct call exists between the probes (creation needs session.host)',
    );
  } else {
    const CALL_ITEM_FIELDS = [
      'callId',
      'direction',
      'mode',
      'outcome',
      'durationSeconds',
      'createdAtMs',
      'endedAtMs',
      'endedByMe',
    ];
    const newest = callItems[0];
    record(
      'a kind:"call" item carries the fields the chat screen renders',
      CALL_ITEM_FIELDS.every((field) => field in newest) &&
        (newest.direction === 'incoming' || newest.direction === 'outgoing') &&
        typeof newest.durationSeconds === 'number' &&
        typeof newest.endedByMe === 'boolean',
      `fields=${Object.keys(newest).sort().join(',')}, direction=${newest.direction}, outcome=${newest.outcome}, ${newest.durationSeconds} s`,
    );
    const outcomes = new Set(['completed', 'missed', 'declined', 'busy', 'unavailable', 'network', 'failed']);
    record(
      'every call item names a known outcome and a known mode',
      callItems.every((item) => outcomes.has(item.outcome) && (item.mode === 'normal' || item.mode === 'translated')),
      `outcomes=${[...new Set(callItems.map((item) => item.outcome))].join(',')}`,
    );
  }
}

// ---------------------------------------------------------------- devices
console.log('\nPush devices (device-routes.ts)');
const deviceId = `probe-contract-${randomBytes(6).toString('hex')}`;
const registered = await A('/devices', jsonInit('POST', { deviceId, platform: 'android', pushToken: `probe-not-a-real-token-${randomBytes(8).toString('hex')}`, label: 'contract-probe' }));
record('POST /devices registers an install (fake token tolerated)', registered.status === 201 && registered.json?.device?.deviceId === deviceId && !('pushToken' in (registered.json?.device ?? {})), size(registered));
const devices = await A('/devices');
record('GET /devices lists it without the token', devices.status === 200 && (devices.json?.devices ?? []).some((d) => d.deviceId === deviceId) && !JSON.stringify(devices.json).includes('pushToken'), size(devices));
const revoked = await A(`/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
record('DELETE /devices/:id revokes it', revoked.status === 200 || revoked.status === 204, size(revoked));
const badPlatform = await A('/devices', jsonInit('POST', { deviceId, platform: 'blackberry', pushToken: 'x' }));
record('POST /devices refuses an unknown platform', badPlatform.status === 400, size(badPlatform));

// ---------------------------------------------------------------- cleanup
console.log('\nCleanup');
for (const id of sentIds) {
  const r = await A(`/messages/${id}/retract`, { method: 'POST' });
  record(`retract sent message`, r.status === 200 && typeof r.json?.message?.retractedAtMs === 'number', size(r));
}
if (contactMade && B !== null) {
  const r = await A('/contacts/remove', jsonInit('POST', { accountId: b.accountId }));
  record('remove the contact this run created', r.status === 200, size(r));
}
if (createdB) leftovers.push(...created);
if (B !== null) {
  const out = await B('/sessions', { method: 'DELETE' });
  record('partner signs out (DELETE /sessions)', out.status === 200 || out.status === 204, size(out));
}
const signOut = await A('/sessions', { method: 'DELETE' });
record('DELETE /sessions signs out', signOut.status === 200 || signOut.status === 204, size(signOut));
const afterOut = await A('/sessions/current');
record('the token is dead after sign-out', afterOut.status === 401, size(afterOut));

const passed = results.length - failed;
const blockedChecks = notRun.filter((item) => item.kind === 'BLOCKED');
const skippedChecks = notRun.filter((item) => item.kind !== 'BLOCKED');
/*
 * FOUR NUMBERS, ALWAYS, INCLUDING THE ZEROES. `101/101 checks passed` on its
 * own is the line somebody screenshots, and it is equally true of a run that
 * verified two thirds of what its name claims to cover. Printing the blocked
 * count even when it is 0 makes its absence impossible to arrange: a reader
 * who sees `0 blocked` has learned something, a reader who sees no such word
 * has learned nothing and cannot tell which run they are looking at.
 */
console.log(
  `\n${passed}/${results.length} checks passed — ${failed} failed, ` +
    `${blockedChecks.length} blocked, ${skippedChecks.length} skipped`,
);
if (notRun.length > 0) {
  console.log(`${notRun.length} check(s) did NOT run, and are not counted as passes:`);
  for (const item of notRun) console.log(`  - ${item.kind} ${item.name} — ${item.why}`);
}
if (leftovers.length > 0) {
  console.log('Left behind (no HTTP route deletes these):');
  for (const item of leftovers) console.log(`  - ${item}`);
}
/*
 * A BLOCKED CHECK FAILS THE RUN. The deployment withheld evidence this suite
 * came to collect, so the suite has not established the thing its name says it
 * establishes, and an exit status of 0 would pass that unverified state on to
 * whatever reads it. `--allow-blocked` is the accepted-block escape hatch and
 * announces itself in the output, so an accepted block still reads as a block.
 */
if (blockedChecks.length > 0) {
  console.log(
    allowBlocked
      ? `--allow-blocked: exiting 0 with ${blockedChecks.length} block(s) ACCEPTED, not resolved.`
      : `${blockedChecks.length} blocked check(s) fail this run. Resolve them, or re-run with --allow-blocked to accept them.`,
  );
}
const blockedFails = blockedChecks.length > 0 && !allowBlocked;
process.exit(failed === 0 && !blockedFails ? 0 : 1);
