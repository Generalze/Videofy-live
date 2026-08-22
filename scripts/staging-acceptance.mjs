#!/usr/bin/env node
/**
 * Staging acceptance — run against a DEPLOYED Videofy Live, from outside it.
 *
 *   node scripts/staging-acceptance.mjs http://169.58.215.77
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

async function httpChecks() {
  console.log('\nEdge routing');
  const cases = [
    ['C7 ecosystem site served at root', '/', (s) => s === 200],
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

  console.log('\nRefused at the edge');
  // The internal prefix covers the internal media API AND the realtime ingress
  // WebSocket. The third case is the one worth keeping: without a matcher that
  // runs AFTER the prefix is stripped, /media/internal/... arrives upstream as
  // /internal/... and the deny above never sees it.
  const denied = [
    ['internal media API', '/internal/media/sessions'],
    ['realtime ingress websocket', '/internal/media/ingress/v1'],
    ['internal API smuggled through /media', '/media/internal/media/sessions'],
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

function connectSocket(label) {
  return new Promise((resolve, reject) => {
    const socket = io(base, {
      // The gateway routes by CONNECTION ROLE, not by which events you send.
      // Without this a socket is registered as a programme listener, and
      // `call:join` is simply never dispatched -- no error, no response, which
      // is a confusing silence to debug from the client side.
      query: { role: 'call-participant' },
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
  console.log('\nRealtime transport');
  let speaker;
  try {
    speaker = await connectSocket('speaker');
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
await socketChecks();

const passed = results.length - failed;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
