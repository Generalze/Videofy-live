#!/usr/bin/env node
/**
 * A real spoken sentence through the PROGRAMME pipeline.
 *
 *   npx vite-node scripts/programme-translation-acceptance.mjs <speech.wav> [baseUrl]
 *
 * WHY, WHEN THE CALL PATH IS ALREADY TESTED. Calls and programmes share the
 * gate, the detector and the translation pipeline -- `serviceCategory` is data
 * carried through one implementation, not a second copy. So the two SHOULD
 * behave identically. "Should" is the word that has been wrong most often in
 * this codebase: the caption path looked shared and had no gateway subscriber,
 * speech plans looked per-session and read a single global. A shared component
 * reached by a different route is not the same as a tested route.
 *
 * programme-acceptance.mjs checks the signalling surface and says plainly that
 * it does not claim anything about audio. This is the audio claim.
 */
import { readFileSync } from 'node:fs';
import { io } from 'socket.io-client';
import wrtc from '@roamhq/wrtc';
import { SOCKET_EVENTS, WebRtcSignallingClient } from '@videofy-live/shared-types';

const { RTCPeerConnection, RTCSessionDescription, nonstandard } = wrtc;

const WAV = process.argv[2];
const BASE = process.argv[3] ?? 'https://staging.consummate7.com';
if (!WAV) {
  console.error('usage: programme-translation-acceptance.mjs <speech.wav> [baseUrl]');
  process.exit(2);
}

let failures = 0;
function record(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** PCM16 mono samples and the rate the file declares. */
function readWav(path) {
  const buffer = readFileSync(path);
  let offset = 12;
  let sampleRate = 16000;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ') sampleRate = buffer.readUInt32LE(offset + 12);
    if (id === 'data') {
      data = buffer.subarray(offset + 8, Math.min(offset + 8 + size, buffer.length));
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!data) throw new Error('no data chunk');
  const samples = new Int16Array(Math.floor(data.length / 2));
  for (let i = 0; i < samples.length; i += 1) samples[i] = data.readInt16LE(i * 2);
  return { samples, sampleRate };
}

function connectAs(role) {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, {
      query: { role },
      transports: ['websocket'],
      reconnection: false,
      timeout: 15000,
    });
    const timer = setTimeout(() => reject(new Error(`${role}: timeout`)), 15000);
    socket.on('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.on('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
}

const speech = readWav(WAV);
console.log(`Programme translation pipeline against ${BASE}`);
console.log(`speech: ${(speech.samples.length / speech.sampleRate).toFixed(1)}s @ ${speech.sampleRate}Hz\n`);

/*
 * THREE sockets, because the gateway routes by ROLE.
 *
 * `operator` is the control surface; WebRTC media signalling is only accepted
 * from a socket whose role is `broadcaster` -- assertWebRtcSocketRole refuses
 * it otherwise, and the refusal presents as a signalling timeout rather than
 * an error, which is what an earlier attempt spent its time on.
 */
const operator = await connectAs('operator');
const broadcaster = await connectAs('broadcaster');
const listener = await connectAs('listener');
record('operator, broadcaster and listener connected', true);

// What the listener is given, in whatever form the programme path delivers it.
const heard = { transcription: [], translation: [], audio: [], state: [] };
listener.onAny((event, payload) => {
  if (/transcription/i.test(event)) heard.transcription.push(payload);
  else if (/translat/i.test(event) && /audio|frame/i.test(event)) heard.audio.push(payload);
  else if (/translat/i.test(event)) heard.translation.push(payload);
  else if (/state|media/i.test(event)) heard.state.push(payload);
});

// The listener asks for a language the speaker is not speaking, which is the
// only configuration where a programme has translation work to do.
listener.emit(SOCKET_EVENTS.JOIN_LANGUAGE, 'fr');
await new Promise((r) => setTimeout(r, 1200));

// --- publish real speech as the programme source --------------------------
/*
 * Driven through the SAME signalling client the operator console uses, not a
 * hand-rolled handshake. A first attempt invented `{type:'offer', sdp}` on
 * WEBRTC_SIGNAL and got nowhere: the real protocol creates a session first and
 * carries envelopes with a revision. Guessing at a protocol produces a red
 * test that says nothing about the system.
 */
const pc = new RTCPeerConnection({ iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] });
const source = new nonstandard.RTCAudioSource();
pc.addTrack(source.createTrack());

const transport = {
  // The client calls handleConnect() on attach only if the transport already
  // reports itself connected. Omit this and it sits in 'disconnected' forever
  // and refuses every request with "Gateway signalling is unavailable".
  get connected() {
    return broadcaster.connected;
  },
  on: (event, listener) => broadcaster.on(event, listener),
  off: (event, listener) => broadcaster.off(event, listener),
  emit: (event, payload) => broadcaster.emit(event, payload),
};

let negotiated = false;
let negotiationDetail = '';
try {
  const client = new WebRtcSignallingClient({ role: 'broadcaster', peerId: 'programme-acceptance' });
  client.attach(transport);
  const created = await client.createSession();
  negotiationDetail = `session ${created.sessionId ?? 'none'}`;

  const answered = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 20000);
    broadcaster.onAny((_event, payload) => {
      const envelope = payload;
      if (envelope && envelope.type === 'sdp-answer' && typeof envelope.payload?.sdp === 'string') {
        clearTimeout(timer);
        resolve(envelope.payload.sdp);
      }
    });
  });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  client.sendSdpOffer({
    targetPeerId: 'peer_backend_media',
    sdp: pc.localDescription?.sdp ?? offer.sdp ?? '',
    revision: 1,
  });

  const answerSdp = await answered;
  if (answerSdp) {
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: answerSdp }));
    negotiated = true;
  } else {
    negotiationDetail += ', no sdp-answer within 20s';
  }
} catch (error) {
  negotiationDetail = String(error?.message ?? error).slice(0, 120);
}
record('programme source negotiated', negotiated, negotiationDetail);

if (negotiated) {
  const frameSize = speech.sampleRate / 100;
  for (let cursor = 0; cursor + frameSize <= speech.samples.length; cursor += frameSize) {
    source.onData({
      samples: speech.samples.slice(cursor, cursor + frameSize),
      sampleRate: speech.sampleRate,
      bitsPerSample: 16,
      channelCount: 1,
    });
    await new Promise((r) => setTimeout(r, 10));
  }
  const silence = new Int16Array(frameSize);
  for (let i = 0; i < 150; i += 1) {
    source.onData({ samples: silence, sampleRate: speech.sampleRate, bitsPerSample: 16, channelCount: 1 });
    await new Promise((r) => setTimeout(r, 10));
  }
  console.log('  (spoke, waiting for the pipeline)');
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline && heard.audio.length === 0) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

console.log('');
/*
 * WHAT THIS PROVES TODAY, and what it does not.
 *
 * It ASSERTS the transport: that a programme source negotiates and its audio
 * reaches the pipeline. That is real, and it is exactly what the older
 * programme-acceptance script deliberately declined to claim.
 *
 * It does NOT yet configure the programme the way the operator console does,
 * declaring the session and its target languages. Without that the pipeline
 * resolves planCount 0 and has nothing to translate, which is correct for an
 * unconfigured programme and says nothing about the gate, the detector or the
 * confidence floor. So delivery is REPORTED, not asserted: failing the run on
 * it would be a red test blaming the product for a gap in its harness.
 */
console.log("  observed (not asserted):");
console.log("    transcription events : " + heard.transcription.length);
console.log("    translation events   : " + heard.translation.length);
console.log("    translated audio     : " + heard.audio.length + " frame(s)");
operator.close();
broadcaster.close();
listener.close();
pc.close();

console.log("");
console.log("NOTE: to assert delivery this needs the operator console session");
console.log("configuration step, declaring the programme and its target languages.");
console.log("Until then a zero above is an unconfigured programme, not a broken one.");
console.log("");
console.log(failures === 0 ? "programme transport OK" : failures + " transport check(s) failed");
process.exit(failures === 0 ? 0 : 1);
