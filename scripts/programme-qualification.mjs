/**
 * A programme, driven from outside, over the network a real one uses.
 *
 * WHY THIS EXISTS RATHER THAN A TEST. Every proof of the protected path so far
 * has run inside one process: a bridge fed by a sink, a host fed by a bridge, a
 * relay authority driven by a loop. Those establish that the parts behave.
 * None of them travels the seam a broadcast travels -- TLS, the proxy,
 * Socket.IO, the signalling protocol, a genuine RTCPeerConnection, the
 * gateway's backend media registry -- and that seam is what is being certified.
 *
 * SO IT IMPORTS NOTHING FROM THE SERVICES. No Gateway, no
 * ProgrammeContributionHost, no media store, no timeline. socket.io-client and
 * a WebRTC implementation, exactly as a browser has. A qualification client
 * that reaches inside the system cannot certify the outside of it.
 *
 * THREE ROLES, KEPT APART. One process orchestrates them for convenience, and
 * they share no object: the operator holds an authenticated control socket, the
 * broadcaster holds signalling and a peer connection, the listener holds the
 * audience path. They speak to each other only through the deployment.
 *
 * THE MEDIA IS DELIBERATELY IDENTIFIABLE. A moving field with a frame-counter
 * bar, and a tone that steps frequency once a second, so a recording can be
 * told apart from stale material, a duplicate, another run, or silence. A
 * broadcast that renders "some video" proves far less than one that renders
 * frame 412 where frame 412 belongs.
 *
 *   node scripts/programme-qualification.mjs --mode=negative-control
 *   node scripts/programme-qualification.mjs --mode=protected-run --seconds=120
 *
 * The operator token comes from C7_OPERATOR_TOKEN in the environment. It is
 * never written to disk, never logged, and never derived: minting one from the
 * server's signing secret would prove this harness can forge an identity, not
 * that the operator path admits a real one.
 */
import { io } from 'socket.io-client';
import wrtc from '@roamhq/wrtc';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/u, '').split('=');
    return [k, v ?? 'true'];
  }),
);

const ORIGIN = args['origin'] ?? 'https://staging.consummate7.com';
const MODE = args['mode'] ?? 'negative-control';
const SECONDS = Number(args['seconds'] ?? (MODE === 'negative-control' ? 25 : 120));
const OPERATOR_TOKEN = process.env['C7_OPERATOR_TOKEN'] ?? '';

const WIDTH = 640;
const HEIGHT = 360;
const FRAME_RATE = 15;
const SAMPLE_RATE = 48_000;
const CHANNELS = 1;
const PROTOCOL_VERSION = 1;
const BACKEND_MEDIA_PEER_ID = 'peer_backend_media';

const stamp = () => new Date().toISOString();
const log = (message, detail) =>
  console.log(JSON.stringify({ at: stamp(), message, ...(detail ?? {}) }));

/** Everything measured, so the report is data rather than narration. */
const measured = {
  mode: MODE,
  origin: ORIGIN,
  sessionId: null,
  programmeRunId: null,
  operatorAccepted: null,
  firstSourceFrameAt: null,
  sourceVideoFrames: 0,
  sourceAudioChunks: 0,
  listenerOriginalMediaOffers: 0,
  listenerSignallingEvents: [],
  errors: [],
};

function envelope(type, payload, overrides = {}) {
  return {
    type,
    protocolVersion: PROTOCOL_VERSION,
    messageId: `msg_${type.replace(/-/gu, '_')}_${Math.random().toString(16).slice(2)}`,
    broadcastId: overrides.broadcastId ?? 'broadcast_qual',
    peerId: 'peer_broadcaster',
    senderRole: 'broadcaster',
    revision: 1,
    createdAt: stamp(),
    payload,
    ...overrides,
  };
}

const nonEmpty = (v) => (typeof v === 'string' && v.trim() ? v : null);
const mLine = (v) => (Number.isInteger(v) && v >= 0 && v <= 128 ? v : null);

function connect(role, auth) {
  const socket = io(ORIGIN, {
    query: { role },
    transports: ['websocket'],
    reconnection: false,
    timeout: 20_000,
    ...(auth ? { auth } : {}),
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${role}: socket timeout`)), 20_000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (error) => {
      clearTimeout(timer);
      reject(new Error(`${role}: ${error?.message ?? 'refused'}`));
    });
  });
}

/**
 * A frame a human can read and a decoder can check.
 *
 * The counter is a bar whose length encodes the frame number, over a field
 * that shifts every frame, so two recordings of the same second are
 * distinguishable. "Video arrived" is not the claim being tested.
 */
function videoFrame(index) {
  const data = new Uint8Array((WIDTH * HEIGHT * 3) / 2);
  const shift = (index * 3) % 255;
  for (let y = 0; y < HEIGHT; y += 1) {
    const row = y * WIDTH;
    for (let x = 0; x < WIDTH; x += 1) data[row + x] = (x + y + shift) % 255;
  }
  const barRow = Math.floor(HEIGHT / 2);
  for (let x = 0; x < index % WIDTH; x += 1) {
    for (let y = barRow; y < barRow + 8; y += 1) data[y * WIDTH + x] = 235;
  }
  // Flat chroma: colour carries nothing here, and a decoder reading noise in
  // it would be reading our own artefact rather than the transport.
  data.fill(128, WIDTH * HEIGHT);
  return { width: WIDTH, height: HEIGHT, data, rotation: 0 };
}

/** A tone that says which second it is, so gaps and repeats are audible. */
function audioChunk(chunkIndex) {
  const perChunk = SAMPLE_RATE / 100;
  const samples = new Int16Array(perChunk * CHANNELS);
  const frequency = 220 + (Math.floor(chunkIndex / 100) % 12) * 55;
  for (let i = 0; i < perChunk; i += 1) {
    const t = (chunkIndex * perChunk + i) / SAMPLE_RATE;
    samples[i] = Math.round(Math.sin(2 * Math.PI * frequency * t) * 12000);
  }
  return { samples, sampleRate: SAMPLE_RATE, bitsPerSample: 16, channelCount: CHANNELS };
}

/**
 * The operator: an authenticated control plane and nothing else.
 *
 * The token travels through Socket.IO `auth`, which is the path a console
 * uses. If the deployment refuses it, that refusal IS the result -- the
 * harness does not fall back to another credential, because a qualification
 * that finds a way in is not qualifying the door.
 */
async function bindProgramme(sessionId, broadcastId) {
  if (!OPERATOR_TOKEN) {
    throw new Error(
      'C7_OPERATOR_TOKEN is not set. Sign in as an entitled operator and export the session token; ' +
        'this harness will not mint one from the server secret.',
    );
  }
  const operator = await connect('operator', { token: OPERATOR_TOKEN });
  const accepted = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no CONTROL_ACK for the programme config')), 15_000);
    operator.on('operator:control_ack', (ack) => {
      if (ack?.action === 'programme-session-config') {
        clearTimeout(timer);
        resolve(ack);
      }
    });
    operator.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`operator refused: ${error?.message ?? 'unknown'}`));
    });
  });
  operator.emit('operator:programme-session-config', {
    sessionId,
    broadcastId,
    sourceRevision: 1,
    sourceLanguage: 'en',
    sourceLanguageMode: 'manual',
    targetLanguage: 'fr',
    targetLanguages: ['fr'],
    programmeTitle: 'Protected qualification run',
  });
  const ack = await accepted;
  measured.operatorAccepted = ack?.accepted ?? null;
  /*
   * THE SERVER'S OWN ANSWER, REQUIRED BEFORE A SINGLE FRAME.
   *
   * Not read from a log, not derived from a spool directory, not chosen here:
   * the run identity arrives on the acknowledgement of the programme this
   * operator just started. Publishing without it would mean producing media
   * for a run whose identity we would have to discover afterwards, and a
   * certification that learns what it broadcast after the fact is forensics.
   */
  measured.programmeRunId = typeof ack?.programmeRunId === 'string' ? ack.programmeRunId : null;
  if (measured.operatorAccepted !== true || measured.programmeRunId === null) {
    throw new Error('the operator was not given a server-established programmeRunId; aborting before media');
  }
  log('operator bound the programme', {
    sessionId,
    accepted: measured.operatorAccepted,
    programmeRunId: measured.programmeRunId,
  });
  return operator;
}

/** The audience path, counted. Original media reaching it is the leak. */
async function joinListener(sessionId) {
  const listener = await connect('listener');
  listener.on('webrtc:session:event', (event) => {
    if (!event || typeof event !== 'object') return;
    measured.listenerSignallingEvents.push(event.type);
    /*
     * An offer FROM the backend media peer is the gateway proposing to send
     * this listener the broadcaster's own tracks. On a protected run that must
     * never happen: the audience receives the programme through the delayed
     * public path or not at all.
     */
    if (event.type === 'sdp-offer' && event.peerId === BACKEND_MEDIA_PEER_ID) {
      measured.listenerOriginalMediaOffers += 1;
      log('LISTENER WAS OFFERED ORIGINAL MEDIA', { sessionId });
    }
  });
  listener.emit(
    'webrtc:session:join',
    envelope(
      'session-join',
      { requestedRole: 'listener' },
      { peerId: 'peer_listener_qual', senderRole: 'listener', sessionId, revision: 0 },
    ),
  );
  return listener;
}

/** The broadcaster: signalling, a real peer connection, and identifiable media. */
async function publish(sessionId, broadcastId, seconds) {
  const socket = await connect('broadcaster');
  const created = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no session-created')), 20_000);
    socket.on('webrtc:session:event', (event) => {
      if (event?.type === 'session-created') {
        clearTimeout(timer);
        resolve(event);
      }
      if (event?.type === 'signalling-error') {
        clearTimeout(timer);
        reject(new Error(`signalling refused: ${JSON.stringify(event.payload ?? {})}`));
      }
    });
  });
  socket.emit(
    'webrtc:session:create',
    envelope('session-create', { requestedSessionId: sessionId }, { broadcastId, revision: 0 }),
  );
  await created;
  log('broadcaster session created', { sessionId });

  const peer = new wrtc.RTCPeerConnection({ iceServers: [] });
  const videoSource = new wrtc.nonstandard.RTCVideoSource();
  const audioSource = new wrtc.nonstandard.RTCAudioSource();
  const videoTrack = videoSource.createTrack();
  const audioTrack = audioSource.createTrack();
  peer.addTrack(videoTrack);
  peer.addTrack(audioTrack);

  peer.onicecandidate = (event) => {
    const c = event?.candidate;
    if (!c?.candidate?.trim()) return;
    socket.emit(
      'webrtc:signal',
      envelope(
        'ice-candidate',
        {
          targetPeerId: BACKEND_MEDIA_PEER_ID,
          candidate: c.candidate,
          sdpMid: nonEmpty(c.sdpMid ?? null),
          sdpMLineIndex: mLine(c.sdpMLineIndex ?? null),
          usernameFragment: nonEmpty(c.usernameFragment ?? null),
        },
        { broadcastId, sessionId },
      ),
    );
  };
  socket.on('webrtc:session:event', (event) => {
    if (event?.type === 'sdp-answer') {
      void peer.setRemoteDescription({ type: 'answer', sdp: event.payload.sdp }).catch(() => undefined);
    }
    if (event?.type === 'ice-candidate' && event.payload?.candidate) {
      void peer
        .addIceCandidate({
          candidate: event.payload.candidate,
          sdpMid: event.payload.sdpMid ?? null,
          sdpMLineIndex: event.payload.sdpMLineIndex ?? null,
        })
        .catch(() => undefined);
    }
  });

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  socket.emit(
    'webrtc:signal',
    envelope(
      'sdp-offer',
      { targetPeerId: BACKEND_MEDIA_PEER_ID, sdp: peer.localDescription?.sdp ?? offer.sdp ?? '' },
      { broadcastId, sessionId },
    ),
  );

  /*
   * PUBLISH IMMEDIATELY. The opening race is the thing being qualified: a
   * broadcaster does not wait politely for the delivery announcement, and a
   * proof that starts five seconds in has skipped exactly the window a
   * protective delay exists to cover.
   */
  measured.firstSourceFrameAt = stamp();
  const video = setInterval(() => {
    try {
      videoSource.onFrame(videoFrame(measured.sourceVideoFrames));
      measured.sourceVideoFrames += 1;
    } catch {
      /* closing */
    }
  }, Math.round(1000 / FRAME_RATE));
  const audio = setInterval(() => {
    try {
      audioSource.onData(audioChunk(measured.sourceAudioChunks));
      measured.sourceAudioChunks += 1;
    } catch {
      /* closing */
    }
  }, 10);
  const report = setInterval(
    () =>
      log('publishing', {
        videoFrames: measured.sourceVideoFrames,
        audioChunks: measured.sourceAudioChunks,
        connection: peer.connectionState,
        listenerOriginalMediaOffers: measured.listenerOriginalMediaOffers,
      }),
    15_000,
  );

  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  clearInterval(video);
  clearInterval(audio);
  clearInterval(report);
  videoTrack.stop();
  audioTrack.stop();
  peer.close();
  socket.disconnect();
}

async function main() {
  const unique = Date.now().toString(36);
  const sessionId = `wrs_qual_${MODE === 'negative-control' ? 'neg_' : 'run_'}${unique}`;
  const broadcastId = `bcast_qual_${unique}`;
  measured.sessionId = sessionId;
  log('qualification starting', { mode: MODE, origin: ORIGIN, sessionId, seconds: SECONDS });

  const listener = await joinListener(sessionId);
  let operator = null;

  if (MODE === 'protected-run') {
    /*
     * Bound FIRST, then published immediately after. No artificial pause: the
     * opening frames are meant to stress the cutover, not to arrive once
     * everything has comfortably settled.
     */
    operator = await bindProgramme(sessionId, broadcastId);
  } else {
    /*
     * NEGATIVE CONTROL. Nothing binds this session, so the gateway has no run
     * for it and no delivery answer -- the exact pre-binding state that used
     * to relay by default. A disposable session id, so the run used for
     * certification is not contaminated by it.
     */
    log('negative control: publishing with NO operator binding');
  }

  await publish(sessionId, broadcastId, SECONDS);

  listener.disconnect();
  operator?.disconnect();

  const verdict =
    measured.listenerOriginalMediaOffers === 0
      ? 'no original media was offered to the audience path'
      : 'ORIGINAL MEDIA WAS OFFERED TO THE AUDIENCE PATH';
  log('qualification finished', { ...measured, verdict });
  if (measured.listenerOriginalMediaOffers > 0) process.exitCode = 1;
}

main().catch((error) => {
  measured.errors.push(error?.message ?? String(error));
  log('qualification FAILED', { ...measured });
  process.exitCode = 1;
});
