#!/usr/bin/env node
/**
 * The REAL CallVideoMesh, two of them, through the deployed gateway.
 *
 *   npx vite-node scripts/call-mesh-acceptance.mjs https://staging.consummate7.com
 *
 * WHY THIS EXISTS SEPARATELY FROM call-video-acceptance.mjs. That script
 * hand-rolls its peer connections, so it proves the GATEWAY relays offers,
 * answers and candidates. It does not execute a single line of the mesh, which
 * is the code the browser actually runs -- so it passed while the product was
 * broken, which is worse than not existing.
 *
 * It also reproduces the ORDER the app uses, which is where the interesting
 * bug lives. The app builds its mesh peers when the call connects, typically
 * with the CAMERA OFF, and only attaches a track later when the person turns
 * their camera on. A peer created with no track has no video m-line at all, so
 * everything afterwards depends on the late attach renegotiating correctly.
 * A test that attaches the camera up front never exercises that path.
 */
import { io } from 'socket.io-client';
import wrtc from '@roamhq/wrtc';
import { CallVideoMesh } from '../packages/call-client-core/src/callVideoMesh.ts';

const { RTCPeerConnection, MediaStream, nonstandard } = wrtc;
const BASE = process.argv[2] ?? 'https://staging.consummate7.com';

let failures = 0;
function record(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function connect() {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, {
      query: { role: 'call-participant' },
      transports: ['websocket'],
      reconnection: false,
      timeout: 15000,
    });
    const timer = setTimeout(() => reject(new Error('socket timeout')), 15000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function emitAck(socket, event, payload, ms = 20000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'ack timeout' }), ms);
    socket.emit(event, payload, (response) => {
      clearTimeout(timer);
      resolve(response ?? { ok: false, error: 'empty ack' });
    });
  });
}

/** A synthetic camera, switched on only when the test asks for it. */
function camera() {
  const source = new nonstandard.RTCVideoSource();
  const track = source.createTrack();
  const width = 320;
  const height = 240;
  const data = new Uint8ClampedArray((width * height * 3) / 2);
  data.fill(128);
  const timer = setInterval(() => {
    data.fill(Math.floor(Math.random() * 60) + 60, 0, width * height);
    try {
      source.onFrame({ width, height, data });
    } catch {
      /* ended */
    }
  }, 100);
  return { stream: new MediaStream([track]), stop: () => clearInterval(timer) };
}

/**
 * Node's wrtc binding is not a browser, and one gap matters here.
 *
 * The mesh calls `setLocalDescription()` with no arguments -- the implicit
 * form, where the implementation works out whether an offer or an answer is
 * due. Every current browser supports it; @roamhq/wrtc rejects it outright
 * with "Expected an object". Left alone, that makes every negotiation in this
 * test throw and the mesh look completely broken when the fault is entirely
 * in the harness. This shim supplies the description the browser would have
 * derived, and changes nothing about the code under test.
 */
function browserLikePeerConnection(config) {
  const pc = new RTCPeerConnection(config);
  const native = pc.setLocalDescription.bind(pc);
  pc.setLocalDescription = async (description) => {
    if (description) return native(description);
    const derived =
      pc.signalingState === 'have-remote-offer' || pc.signalingState === 'have-local-pranswer'
        ? await pc.createAnswer()
        : await pc.createOffer();
    return native(derived);
  };
  return pc;
}

async function iceServers() {
  try {
    const response = await fetch(`${BASE}/webrtc/ice`);
    const payload = await response.json();
    return Array.isArray(payload.iceServers) ? payload.iceServers : [];
  } catch {
    return [];
  }
}

const servers = await iceServers();
console.log(`Real CallVideoMesh against ${BASE}`);
console.log(`ICE servers from the gateway: ${servers.length}\n`);

const callId = `MESH${Math.floor(Date.now() / 1000) % 100000}`;
const alice = await connect();
const bob = await connect();

const joinPayload = (name) => ({
  callId,
  displayName: name,
  speakLanguage: 'en',
  hearLanguage: 'en',
  captionsEnabled: true,
  voiceGender: 'female',
  audioMode: 'translated',
  callType: 'conference',
  callMode: 'normal',
});

const aliceJoin = await emitAck(alice, 'call:join', joinPayload('Alice'));
const bobJoin = await emitAck(bob, 'call:join', joinPayload('Bob'));
record('two participants joined', aliceJoin?.ok !== false && bobJoin?.ok !== false, callId);
if (aliceJoin?.ok === false || bobJoin?.ok === false) process.exit(1);

const aliceId = aliceJoin.participantId;
const bobId = bobJoin.participantId;

const remoteStreams = { alice: new Map(), bob: new Map() };

function buildMesh(who, socket, selfId) {
  const mesh = new CallVideoMesh({
    callId,
    selfParticipantId: selfId,
    iceServers: servers,
    createPeerConnection: () => browserLikePeerConnection({ iceServers: servers }),
    sendOffer: (payload) => socket.emit('call:video:offer', payload),
    sendAnswer: (payload) => socket.emit('call:video:answer', payload),
    sendIce: (payload) => socket.emit('call:video:ice', payload),
    onRemoteStream: (participantId, stream) => {
      if (stream) remoteStreams[who].set(participantId, stream);
      else remoteStreams[who].delete(participantId);
    },
    onPeerState: () => {},
  });
  socket.on('call:video:offer', (p) => void mesh.handleOffer(p.participantId, p));
  socket.on('call:video:answer', (p) => void mesh.handleAnswer(p.participantId, p));
  socket.on('call:video:ice', (p) => void mesh.handleIce(p.participantId, p));
  return mesh;
}

const aliceMesh = buildMesh('alice', alice, aliceId);
const bobMesh = buildMesh('bob', bob, bobId);

// --- the app's order: peers first, cameras OFF -----------------------------
aliceMesh.syncParticipants([bobId]);
bobMesh.syncParticipants([aliceId]);
await new Promise((r) => setTimeout(r, 2000));
record(
  'a mesh with no camera sends no video to anyone',
  remoteStreams.alice.size === 0 && remoteStreams.bob.size === 0,
  'nothing published before a camera exists',
);

// --- Alice turns her camera on, well after the peer was built --------------
const aliceCam = camera();
aliceMesh.setLocalStream(aliceCam.stream);
await new Promise((r) => setTimeout(r, 6000));
record(
  'turning a camera on AFTER the peer exists reaches the other side',
  remoteStreams.bob.has(aliceId),
  remoteStreams.bob.has(aliceId)
    ? "Bob received Alice's video"
    : 'Bob got nothing — the late attach never renegotiated',
);

// --- Bob answers with his own camera, later still ---------------------------
const bobCam = camera();
bobMesh.setLocalStream(bobCam.stream);
await new Promise((r) => setTimeout(r, 6000));
record(
  'the second camera to arrive also reaches the other side',
  remoteStreams.alice.has(bobId),
  remoteStreams.alice.has(bobId)
    ? "Alice received Bob's video"
    : 'Alice got nothing — the reverse direction never negotiated',
);

console.log('\ndiagnostics');
console.log('  alice:', JSON.stringify(aliceMesh.diagnostics?.() ?? {}));
console.log('  bob:  ', JSON.stringify(bobMesh.diagnostics?.() ?? {}));

aliceCam.stop();
bobCam.stop();
aliceMesh.dispose();
bobMesh.dispose();
alice.close();
bob.close();

console.log(`\n${failures === 0 ? 'call video mesh OK' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
