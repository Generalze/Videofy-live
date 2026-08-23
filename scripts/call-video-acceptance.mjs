#!/usr/bin/env node
/**
 * Two real participants, one real video mesh, against deployed staging.
 *
 *   node scripts/call-video-acceptance.mjs https://staging.consummate7.com
 *
 * WHY THIS EXISTS. Call video is a peer-to-peer MESH: the gateway relays SDP
 * and ICE and never carries the media. That makes it fail in a completely
 * different way from audio, which is server-mediated — and it fails silently,
 * because the relay is fire-and-forget and logs nothing.
 *
 * Running both peers from ONE machine is deliberate. They reach each other on
 * host candidates, so this isolates the QUESTION: does the signalling and mesh
 * logic work at all? A pass here with a failure in the field means the logic is
 * fine and the peers could not traverse their NATs. A failure here means the
 * bug is ours and no amount of TURN would help.
 */
import { io } from 'socket.io-client';
import wrtc from '@roamhq/wrtc';

const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, nonstandard } = wrtc;
const BASE = process.argv[2] ?? 'https://staging.consummate7.com';
const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302'] }];

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

/** A synthetic camera: green frames, so there is genuinely video on the wire. */
function localVideoTrack() {
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
      /* track ended */
    }
  }, 100);
  return { track, stop: () => clearInterval(timer) };
}

const callId = `VID${Math.floor(Date.now() / 1000) % 100000}`;
console.log(`Call video mesh against ${BASE}\n`);

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

// --- one mesh peer each ----------------------------------------------------
const aliceCam = localVideoTrack();
const bobCam = localVideoTrack();
const alicePc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
const bobPc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
alicePc.addTrack(aliceCam.track);
bobPc.addTrack(bobCam.track);

const relayed = { offers: 0, answers: 0, ice: 0 };
let bobSawAliceTrack = false;
let aliceSawBobTrack = false;

bobPc.ontrack = () => {
  bobSawAliceTrack = true;
};
alicePc.ontrack = () => {
  aliceSawBobTrack = true;
};

alicePc.onicecandidate = (event) => {
  if (event.candidate) {
    alice.emit('call:video:ice', {
      callId,
      participantId: aliceId,
      targetParticipantId: bobId,
      candidate: event.candidate,
    });
  }
};
bobPc.onicecandidate = (event) => {
  if (event.candidate) {
    bob.emit('call:video:ice', {
      callId,
      participantId: bobId,
      targetParticipantId: aliceId,
      candidate: event.candidate,
    });
  }
};

bob.on('call:video:offer', async (payload) => {
  relayed.offers += 1;
  await bobPc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: payload.sdp }));
  const answer = await bobPc.createAnswer();
  await bobPc.setLocalDescription(answer);
  bob.emit('call:video:answer', {
    callId,
    participantId: bobId,
    targetParticipantId: aliceId,
    sdp: answer.sdp,
  });
});

alice.on('call:video:answer', async (payload) => {
  relayed.answers += 1;
  await alicePc.setRemoteDescription(
    new RTCSessionDescription({ type: 'answer', sdp: payload.sdp }),
  );
});

for (const [socket, pc] of [
  [alice, alicePc],
  [bob, bobPc],
]) {
  socket.on('call:video:ice', (payload) => {
    relayed.ice += 1;
    if (payload?.candidate) {
      pc.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(() => {});
    }
  });
}

const offer = await alicePc.createOffer();
await alicePc.setLocalDescription(offer);
alice.emit('call:video:offer', {
  callId,
  participantId: aliceId,
  targetParticipantId: bobId,
  sdp: offer.sdp,
});

const state = await new Promise((resolve) => {
  const deadline = setTimeout(() => resolve(alicePc.iceConnectionState), 30000);
  alicePc.oniceconnectionstatechange = () => {
    const current = alicePc.iceConnectionState;
    if (current === 'connected' || current === 'completed' || current === 'failed') {
      clearTimeout(deadline);
      resolve(current);
    }
  };
});

// Give the negotiated tracks a moment to surface.
await new Promise((resolve) => setTimeout(resolve, 2000));

console.log('');
record('gateway relayed the video offer', relayed.offers > 0, `${relayed.offers} offer(s)`);
record('gateway relayed the video answer', relayed.answers > 0, `${relayed.answers} answer(s)`);
record('gateway relayed ICE candidates', relayed.ice > 0, `${relayed.ice} candidate(s)`);
record('video peer connection established', state === 'connected' || state === 'completed', state);
// The claim that actually matters to a person in a call: the OTHER side's
// camera arrived. Everything above can succeed while this fails.
record('each participant received the other video track', bobSawAliceTrack && aliceSawBobTrack,
  `bob<-alice: ${bobSawAliceTrack}, alice<-bob: ${aliceSawBobTrack}`);

aliceCam.stop();
bobCam.stop();
alicePc.close();
bobPc.close();
alice.close();
bob.close();

console.log(`\n${failures === 0 ? 'call video mesh OK' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
