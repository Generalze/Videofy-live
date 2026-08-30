#!/usr/bin/env node
/** @author masterzee001 */
/**
 * Mobile CONTRACT acceptance — the phone's whole HTTP surface, driven the way
 * the app drives it, against a deployed Videofy Live.
 *
 *   node scripts/mobile-contract-acceptance.mjs [baseUrl]
 *
 *   env (NAMES; the values are never printed):
 *     PROBE_EMAIL            the first probe account            (default probe-call-a@consummate7.com)
 *     PROBE_PASSWORD_FILE    file holding that account's password (required)
 *     PROBE_B_EMAIL          a second probe account, the messaging partner (optional)
 *     PROBE_B_PASSWORD_FILE  its password file (optional; falls back to PROBE_PASSWORD_FILE)
 *     STREAM_HANDLE          a channel handle known to exist (optional; default meakzoe)
 *
 * WHY THIS EXISTS. When the APK cannot be built, the only thing about the
 * phone that can still be verified is the contract it depends on. Every
 * request below is transcribed from apps/mobile/src/api/client.ts and
 * src/auth/authSessionManager.ts: the same paths, methods, bodies and header
 * shape, so a PASS here is a statement about what the real app will get back.
 *
 * WHAT IT PRINTS. PASS/FAIL per check with the status code and byte size.
 * Never a body that could carry a token, never a credential, never an
 * account id. Ids are held in memory for the run and dropped.
 *
 * WHAT IT CLEANS UP. Messages it sent are retracted; a device it registered
 * is revoked; profile fields it changed are restored; a follow or contact it
 * created is removed. Accounts cannot be deleted over HTTP, so an account it
 * had to create is listed at the end rather than pretended away.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const base = (process.argv[2] ?? 'https://staging.consummate7.com').replace(/\/$/, '');
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
function skip(name, why) {
  results.push({ name, ok: true, detail: `SKIP: ${why}` });
  console.log(`  SKIP  ${name} — ${why}`);
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
    const translated = await B(`/messages/${voiceId}/voice/translated`);
    const available = voice.json?.message?.translatedAudioAvailable === true;
    record(
      'GET /messages/:id/voice/translated agrees with translatedAudioAvailable',
      available ? translated.status === 200 : translated.status === 404,
      `${size(translated)}, translatedAudioAvailable=${available}`,
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
console.log(`\n${passed}/${results.length} checks passed`);
if (leftovers.length > 0) {
  console.log('Left behind (no HTTP route deletes these):');
  for (const item of leftovers) console.log(`  - ${item}`);
}
process.exit(failed === 0 ? 0 : 1);
