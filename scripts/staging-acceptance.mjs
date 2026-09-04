#!/usr/bin/env node
/**
 * Staging acceptance — run against a DEPLOYED Videofy Live, from outside it.
 *
 *   node scripts/staging-acceptance.mjs http://169.58.215.77
 *
 *   env (names; values are never printed):
 *     STREAM_HANDLE            a channel handle expected to exist (default: meakzoe);
 *                              set to "-" to skip the public channel checks.
 *     C7_SESSION_TOKEN_FILE    a file holding a VERIFIED account's session token;
 *                              with it the authenticated call-creation path is
 *                              exercised. Without it only the anonymous refusal
 *                              is asserted, which is the fail-closed half.
 *
 * This deliberately talks to the public edge only. Every check here is a fact
 * about the deployment: the reverse proxy, the private-port policy, the
 * WebSocket upgrade, the call runtime. A check that passed by reaching a
 * service directly on its own port would prove nothing about the thing users
 * actually connect to.
 *
 * WHAT THIS CANNOT PROVE, and does not pretend to:
 *   - audible translated speech. That needs a real microphone, and browsers
 *     refuse getUserMedia outside a secure context, so it needs TLS first.
 *   - any commercial provider. Those need the owner's vendor credentials, and
 *     running them would spend real money to re-observe a known result.
 */
import { io } from 'socket.io-client';

const base = (process.argv[2] ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
const results = [];
let failed = 0;

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!ok) failed += 1;
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  ${mark}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function status(path) {
  const response = await fetch(`${base}${path}`, { redirect: 'manual' });
  return response.status;
}

/** The programme-control routes are POST; a GET at the same path is Express's 404, not the guard. */
async function postStatus(path) {
  const response = await fetch(`${base}${path}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json' }, body: '{}' });
  return response.status;
}

async function httpChecks() {
  console.log('\nEdge routing');
  const cases = [
    ['C7 ecosystem site served at root', '/', (s) => s === 200],
    // Three distinct public layers, all served by the one ecosystem bundle via
    // the proxy's SPA fallback.
    ['Videofy family page at /videofy/', '/videofy/', (s) => s === 200],
    ['Videofy-Live page at /videofy/live/', '/videofy/live/', (s) => s === 200],
    ['direct refresh at /videofy/live/ serves the app', '/videofy/live', (s) => s === 200],
    // The shell is still delivered for unknown paths -- the proxy cannot know
    // which paths the app considers real -- but the APP must render NOT FOUND
    // rather than the homepage. Verified below by content, not by status.
    ['unknown path still delivers the shell', '/definitely-not-a-real-page', (s) => s === 200],
    ['call-web served at /call/', '/call/', (s) => s === 200],
    // A visitor WILL refresh on a sub-path. A single-page app must answer with
    // itself there, not with a 404 from the file server.
    ['direct refresh inside /call/ serves the app', '/call/join/ABC123', (s) => s === 200],
    ['listener-web served at /listen/', '/listen/', (s) => s === 200],
    ['operator-web served at /operator/', '/operator/', (s) => s === 200],
    ['gateway health through the proxy', '/health', (s) => s === 200],
    ['media-ingest health via /media', '/media/health', (s) => s === 200],
    ['account via /auth (401 unauthenticated)', '/auth/sessions/current', (s) => s === 401 || s === 200],
  ];
  for (const [name, path, ok] of cases) {
    try {
      const code = await status(path);
      record(name, ok(code), `HTTP ${code}`);
    } catch (error) {
      record(name, false, String(error?.message ?? error));
    }
  }

  // The Vite --base defect, checked rather than assumed. An app built with the
  // wrong base serves a perfectly good index.html whose script tag points at a
  // path that 404s -- so the page loads, blank, and the status check passes.
  console.log('\nAsset bases');
  for (const [name, page, prefix] of [
    ['C7 ecosystem', '/', '/assets/'],
    // The deep route must load the SAME bundle from an absolute /assets/ path.
    // A relative base here would resolve to /videofy/live/assets/... and 404,
    // which renders a blank page while the HTTP check above still passes.
    ['Videofy family', '/videofy/', '/assets/'],
    ['Videofy-Live', '/videofy/live/', '/assets/'],
    ['call-web', '/call/', '/call/assets/'],
    ['listener-web', '/listen/', '/listen/assets/'],
    ['operator-web', '/operator/', '/operator/assets/'],
  ]) {
    try {
      const html = await (await fetch(`${base}${page}`)).text();
      const match = /<script[^>]+src="([^"]+)"/.exec(html);
      if (match === null) {
        record(`${name} asset base`, false, 'no script tag found');
        continue;
      }
      const src = match[1];
      if (!src.startsWith(prefix)) {
        record(`${name} asset base`, false, `script src ${src} is not under ${prefix}`);
        continue;
      }
      const assetStatus = await status(src);
      record(`${name} asset base`, assetStatus === 200, `${src} -> HTTP ${assetStatus}`);
    } catch (error) {
      record(`${name} asset base`, false, String(error?.message ?? error));
    }
  }

  // Read by WhatsApp and friends WITHOUT running JavaScript, so this fetches
  // the HTML and inspects it exactly as a crawler would. A runtime-set title is
  // invisible here, which is the whole reason the build stamps these files.
  console.log('\nCrawler-readable metadata');
  for (const [name, page, expectTitle] of [
    ['C7 root', '/', 'Building Technology for What Comes Next'],
    ['Videofy family', '/videofy/', 'Communication. Creation. Entertainment. Reach.'],
    ['Videofy-Live', '/videofy/live/', 'Speak Naturally. Understand Globally.'],
  ]) {
    try {
      const html = await (await fetch(`${base}${page}`)).text();
      const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
      record(`${name} title in raw HTML`, title.includes(expectTitle), title || '(none)');

      const ogUrl = /property="og:url" content="([^"]*)"/.exec(html)?.[1] ?? '';
      const ogImage = /property="og:image" content="([^"]*)"/.exec(html)?.[1] ?? '';
      const card = /name="twitter:card" content="([^"]*)"/.exec(html)?.[1] ?? '';
      record(
        `${name} og:url absolute and correct`,
        ogUrl.startsWith('https://') && ogUrl.endsWith(page),
        ogUrl || '(none)',
      );
      record(
        `${name} og:image absolute`,
        ogImage.startsWith('https://') && !ogImage.includes('localhost'),
        ogImage || '(none)',
      );
      record(`${name} twitter:card large`, card === 'summary_large_image', card || '(none)');
    } catch (error) {
      record(`${name} metadata`, false, String(error?.message ?? error));
    }
  }

  // The share image must actually be fetchable, or the preview is blank.
  try {
    const response = await fetch(`${base}/share/c7-share.png`);
    const type = response.headers.get('content-type') ?? '';
    record(
      'share image served as an image',
      response.status === 200 && type.startsWith('image/'),
      `HTTP ${response.status} ${type}`,
    );
  } catch (error) {
    record('share image served as an image', false, String(error?.message ?? error));
  }

  console.log('\nRefused at the edge');
  // The internal prefix covers the internal media API AND the realtime ingress
  // WebSocket. The third case is the one worth keeping: without a matcher that
  // runs AFTER the prefix is stripped, /media/internal/... arrives upstream as
  // /internal/... and the deny above never sees it.
  const denied = [
    ['internal media API', '/internal/media/sessions'],
    ['realtime ingress websocket', '/internal/media/ingress/v1'],
    ['internal API smuggled through /media', '/media/internal/media/sessions'],
    ['account internals through /auth', '/auth/internal/accounts'],
  ];
  for (const [name, path] of denied) {
    try {
      const code = await status(path);
      record(`${name} refused`, code === 404, `HTTP ${code}`);
    } catch (error) {
      record(`${name} refused`, false, String(error?.message ?? error));
    }
  }
}

/**
 * The public, unauthenticated routes the phone and the listener page read
 * before anybody signs in: the canonical /streams/<handle> resolution, the
 * public conference listing and the status word for a held call code.
 */
async function publicRouteChecks() {
  console.log('\nPublic channel and conference routes');
  const handle = process.env['STREAM_HANDLE'] ?? 'meakzoe';
  if (handle === '-') {
    console.log('  SKIP  /auth/streams/<handle> (STREAM_HANDLE=-)');
  } else {
    try {
      const response = await fetch(`${base}/auth/streams/${encodeURIComponent(handle)}`);
      const body = await response.json().catch(() => null);
      const keys = Object.keys(body ?? {}).sort();
      record(
        `/auth/streams/${handle} resolves to a public profile`,
        response.status === 200 && typeof body?.channelId === 'string' && body?.handle === handle,
        `HTTP ${response.status}, keys=${keys.join(',') || '(none)'}`,
      );
      // The public shape must never carry the owner: the handle route exists so
      // links do not expose account ids.
      record(
        'public channel profile carries no owner id',
        !keys.some((key) => /owner|account/i.test(key)),
        keys.join(','),
      );
      const shell = await status(`/streams/${encodeURIComponent(handle)}`);
      record('/streams/<handle> serves the listener shell', shell === 200, `HTTP ${shell}`);
    } catch (error) {
      record(`/auth/streams/${handle}`, false, String(error?.message ?? error));
    }
  }
  try {
    const missing = await status('/auth/streams/no-such-handle-xyz');
    record('/auth/streams/<unknown> answers 404', missing === 404, `HTTP ${missing}`);
    const publicCalls = await fetch(`${base}/calls/public`);
    const listing = await publicCalls.json().catch(() => null);
    record(
      '/calls/public lists public conferences',
      publicCalls.status === 200 && Array.isArray(listing?.calls),
      `HTTP ${publicCalls.status}, ${listing?.calls?.length ?? '?'} rooms`,
    );
    const statusResponse = await fetch(`${base}/calls/ZZZZZZ/status`);
    const word = await statusResponse.json().catch(() => null);
    record(
      '/calls/:id/status answers a status word and nothing else',
      statusResponse.status === 200 && typeof word?.status === 'string' && Object.keys(word).length === 1,
      `HTTP ${statusResponse.status}, status=${word?.status}`,
    );
  } catch (error) {
    record('public conference routes', false, String(error?.message ?? error));
  }
}

function connectSocket(label, token) {
  return new Promise((resolve, reject) => {
    const socket = io(base, {
      // The gateway routes by CONNECTION ROLE, not by which events you send.
      // Without this a socket is registered as a programme listener, and
      // `call:join` is simply never dispatched -- no error, no response, which
      // is a confusing silence to debug from the client side.
      query: { role: 'call-participant' },
      ...(token ? { auth: { token } } : {}),
      // websocket ONLY. Allowing a polling fallback would let this pass while
      // the proxy silently failed to carry an upgrade -- which is precisely the
      // failure a reverse proxy in front of a realtime service tends to have.
      transports: ['websocket'],
      timeout: 15_000,
      reconnection: false,
    });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`${label}: no connection within 15s`));
    }, 15_000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (error) => {
      clearTimeout(timer);
      socket.close();
      reject(new Error(`${label}: ${error.message}`));
    });
  });
}

function joinCall(socket, payload) {
  return new Promise((resolve) => {
    // The gateway answers a join with a socket.io ACKNOWLEDGEMENT, not with a
    // broadcast event. Listening for an event here waits forever against a
    // perfectly healthy server -- the reply was already delivered, to a
    // callback that was never passed.
    const timer = setTimeout(() => resolve({ kind: 'timeout' }), 15_000);
    socket.emit('call:join', payload, (response) => {
      clearTimeout(timer);
      if (response?.ok === false || response?.error) {
        resolve({ kind: 'error', data: response });
        return;
      }
      resolve({ kind: 'joined', data: response });
    });
  });
}

async function socketChecks() {
  // --- operator / programme authorization -------------------------------
  //
  // The question is not whether the SPA shell is served -- it may be -- but
  // whether an anonymous caller can reach privileged programme data or perform
  // operator mutations.
  console.log('\nOperator and programme authorization');
  try {
    const shell = await status('/operator/');
    record('operator shell is served', shell === 200, `HTTP ${shell}`);

    // Auth must be checked BEFORE existence. A 404 for a well-formed but
    // non-existent id means there is no authentication layer at all, and the
    // only thing protecting a live programme is knowing its session id.
    //
    // These two checks FAILED ON PURPOSE from 2026-08-23 to 2026-08-30, while
    // programme control was anonymous and media-ingest refused to boot in
    // production. Programme control now demands a verified C7 session plus
    // the OPERATOR_CONSOLE_ACCOUNT_IDS allowlist; a deployment where either
    // check fails again has regressed, not merely fallen behind.
    const fake = 'ps_00000000-0000-0000-0000-000000000000';
    const pause = await postStatus(`/media/sessions/${fake}/pause`);
    record(
      'programme control demands authentication before existence',
      pause === 401 || pause === 403,
      `POST pause -> HTTP ${pause} (expected 401/403, got existence-check)`,
    );

    // The duplicate-rejection path must not hand an anonymous caller a live
    // session id, stream id and processing state.
    const duplicate = await fetch(`${base}/media/microphone/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    const text = await duplicate.text();
    const leaks = /"(id|streamId)"\s*:\s*"(ps_|stream_)/.test(text);
    record(
      'anonymous session creation does not disclose an active session',
      !leaks,
      leaks ? 'response carried a live session id / streamId' : 'no session disclosed',
    );
  } catch (error) {
    record('operator authorization probes', false, String(error?.message ?? error));
  }

  console.log('\nRealtime transport');
  /*
   * ONLY A VERIFIED ACCOUNT MAY CREATE A CALL (gateway call-runtime,
   * 'host-not-authorized'). An anonymous join of a fresh code must therefore
   * be refused, and that refusal is asserted first. The creation path itself
   * runs only when a verified session token is supplied by file name.
   */
  const tokenFile = process.env['C7_SESSION_TOKEN_FILE'];
  let hostToken = null;
  if (tokenFile) {
    try {
      hostToken = (await import('node:fs')).readFileSync(tokenFile, 'utf8').trim() || null;
    } catch {
      record('C7_SESSION_TOKEN_FILE readable', false, 'could not read the named file');
    }
  }
  try {
    const anonymous = await connectSocket('anonymous');
    const probeId = `stg${anonymous.id.replace(/[^a-z0-9]/gi, '').slice(0, 6)}`.toUpperCase();
    const refused = await joinCall(anonymous, {
      callId: probeId,
      displayName: 'Anonymous',
      speakLanguage: 'en',
      hearLanguage: 'en',
      captionsEnabled: false,
      voiceGender: 'female',
      audioMode: 'translated',
      callType: 'personal',
      callMode: 'normal',
    });
    anonymous.close();
    record(
      'anonymous call creation is refused (host-not-authorized)',
      refused.kind === 'error' && refused.data?.code === 'host-not-authorized',
      refused.kind === 'error' ? `code=${refused.data?.code}` : refused.kind,
    );
  } catch (error) {
    record('anonymous call creation is refused (host-not-authorized)', false, String(error?.message ?? error));
  }
  if (hostToken === null) {
    console.log('  SKIP  call created and joined through the edge (no C7_SESSION_TOKEN_FILE; needs a verified account)');
    return;
  }
  let speaker;
  try {
    speaker = await connectSocket('speaker', hostToken);
    record('websocket upgrade through the proxy', true, `transport=${speaker.io.engine.transport.name}`);
  } catch (error) {
    record('websocket upgrade through the proxy', false, String(error?.message ?? error));
    return;
  }

  // A call code is shared state between the two participants; deriving it from
  // the connection id keeps concurrent runs from colliding on one box.
  const callId = `stg${speaker.id.replace(/[^a-z0-9]/gi, '').slice(0, 6)}`.toUpperCase();

  const joined = await joinCall(speaker, {
    callId,
    displayName: 'Staging Speaker',
    speakLanguage: 'en',
    hearLanguage: 'en',
    captionsEnabled: true,
    voiceGender: 'female',
    audioMode: 'translated',
    callType: 'personal',
    callMode: 'normal',
  });
  record(
    'call created and joined through the edge',
    joined.kind === 'joined',
    joined.kind === 'joined'
      ? `callId=${callId}`
      : `refused: ${JSON.stringify(joined.data)?.slice(0, 160)}`,
  );

  if (joined.kind !== 'joined') {
    speaker.close();
    return;
  }

  let listener;
  try {
    listener = await connectSocket('listener');
  } catch (error) {
    record('second participant connects', false, String(error?.message ?? error));
    speaker.close();
    return;
  }

  // The roster broadcast is the signal that the call runtime -- not merely the
  // socket server -- is actually running: it means the first participant was
  // held in call state and told about the second.
  const rosterSeen = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 15_000);
    // The FIRST participant being told about the second is the signal that a
    // call runtime is holding state, not merely that a socket server answered.
    speaker.on('call:state', (data) => {
      const participants = data?.participants ?? [];
      if (participants.length >= 2) {
        clearTimeout(timer);
        resolve(data);
      }
    });
  });

  const secondJoin = await joinCall(listener, {
    callId,
    displayName: 'Staging Listener',
    speakLanguage: 'fr',
    hearLanguage: 'fr',
    captionsEnabled: true,
    voiceGender: 'female',
    audioMode: 'translated',
  });
  record(
    'second participant joins the same call',
    secondJoin.kind === 'joined',
    secondJoin.kind === 'joined' ? 'two-language call established' : JSON.stringify(secondJoin.data)?.slice(0, 160),
  );

  const roster = await rosterSeen;
  record(
    'call runtime broadcasts the roster to the first participant',
    roster !== null,
    roster === null ? 'no updated roster within 15s' : `${roster?.participants?.length ?? '?'} participants`,
  );

  // Reconnect: a dropped socket must be able to come back, which is the
  // recovery path a real network hands users constantly.
  //
  // This MUST present the resume credentials from the original join. A fresh
  // join is correctly refused with 'call-full', because the seat is still held
  // for the participant who dropped -- releasing it instantly would mean a
  // brief tunnel outage cost you your place in the call.
  listener.close();
  let rejoined;
  try {
    const again = await connectSocket('listener-rejoin');
    rejoined = await joinCall(again, {
      callId,
      displayName: 'Staging Listener',
      speakLanguage: 'fr',
      hearLanguage: 'fr',
      captionsEnabled: true,
      voiceGender: 'female',
      audioMode: 'translated',
      resumeParticipantId: secondJoin.data?.participantId,
      resumeToken: secondJoin.data?.resumeToken,
    });
    record(
      'participant reconnects and rejoins',
      rejoined.kind === 'joined',
      rejoined.kind === 'joined' ? 'rejoined' : JSON.stringify(rejoined.data)?.slice(0, 200),
    );
    again.close();
  } catch (error) {
    record('participant reconnects and rejoins', false, String(error?.message ?? error));
  }

  speaker.close();
}

console.log(`Videofy Live — staging acceptance against ${base}`);
await httpChecks();
await publicRouteChecks();
await socketChecks();

const passed = results.length - failed;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
