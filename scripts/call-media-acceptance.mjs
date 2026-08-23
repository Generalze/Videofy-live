/**
 * A REAL WebRTC client against deployed staging.
 *
 * Uses the same libwebrtc build the gateway itself uses, so this exercises the
 * actual media path: join over socket.io, publish an audio track, negotiate,
 * and wait for ICE to reach `connected`. That is the exact step that was
 * failing with ice-connection-failure.
 */
import { io } from 'socket.io-client';
import wrtc from '@roamhq/wrtc';

const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, nonstandard } = wrtc;
const BASE = process.argv[2] ?? 'https://staging.consummate7.com';
const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

function log(...parts) {
  console.log(...parts);
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
    socket.on('connect_error', (e) => {
      clearTimeout(timer);
      reject(e);
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

const callId = `MEDIA${Math.floor(Date.now() / 1000) % 100000}`;

const socket = await connect();
log(`socket connected (${socket.io.engine.transport.name})`);

const join = await emitAck(socket, 'call:join', {
  callId,
  displayName: 'Media Probe',
  speakLanguage: 'en',
  hearLanguage: 'es',
  captionsEnabled: true,
  voiceGender: 'female',
  audioMode: 'translated',
  callType: 'personal',
  callMode: 'normal',
});
if (join?.ok === false) {
  log('JOIN FAILED:', JSON.stringify(join).slice(0, 200));
  process.exit(1);
}
log(`joined call ${callId} as ${join.participantId}`);

// --- publish peer: a real audio track over a real peer connection ----------
const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
const source = new nonstandard.RTCAudioSource();
const track = source.createTrack();
pc.addTrack(track);

// A continuous 440Hz tone, so there is genuine audio on the wire rather than
// an empty track that could "connect" without carrying anything.
let sampleClock = 0;
const tone = setInterval(() => {
  const samples = new Int16Array(480); // 10ms @ 48kHz
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.round(Math.sin((2 * Math.PI * 440 * sampleClock) / 48000) * 8000);
    sampleClock += 1;
  }
  try {
    source.onData({ samples, sampleRate: 48000, bitsPerSample: 16, channelCount: 1 });
  } catch {
    /* peer closed */
  }
}, 10);

const candidates = { local: 0, localSrflx: 0, remote: 0 };
pc.onicecandidate = (event) => {
  if (event.candidate) {
    candidates.local += 1;
    if (event.candidate.candidate.includes('srflx')) candidates.localSrflx += 1;
    socket.emit('call:publish:ice', {
      callId,
      participantId: join.participantId,
      candidate: event.candidate,
    });
  }
};

// The backend returns ITS candidates for the publish peer on the SAME event
// name the client publishes with, in the opposite direction. Listening on
// `call:receive:ice` (which belongs to the receive peer) silently yields zero
// remote candidates and an ICE state stuck at `new`.
socket.on('call:publish:ice', (payload) => {
  if (payload?.candidate) {
    candidates.remote += 1;
    pc.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(() => {});
  }
});

const offer = await pc.createOffer();
await pc.setLocalDescription(offer);

const publish = await emitAck(socket, 'call:publish:offer', {
  callId,
  participantId: join.participantId,
  sdp: offer.sdp,
});
if (publish?.ok !== true || typeof publish.sdp !== 'string') {
  log('PUBLISH FAILED:', JSON.stringify(publish).slice(0, 250));
  process.exit(1);
}
await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: publish.sdp }));
log('offer/answer exchanged; waiting for ICE...');

const settled = await new Promise((resolve) => {
  const deadline = setTimeout(() => resolve(pc.iceConnectionState), 30000);
  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState;
    log(`  ice: ${state}`);
    if (state === 'connected' || state === 'completed' || state === 'failed') {
      clearTimeout(deadline);
      resolve(state);
    }
  };
});

clearInterval(tone);

log('');
log(`local candidates: ${candidates.local} (srflx: ${candidates.localSrflx})`);
log(`remote candidates received: ${candidates.remote}`);
log(`FINAL ICE STATE: ${settled}`);

const ok = settled === 'connected' || settled === 'completed';
log(ok ? 'RESULT: MEDIA PATH CONNECTED' : 'RESULT: MEDIA PATH FAILED');

pc.close();
socket.close();
process.exit(ok ? 0 : 1);
