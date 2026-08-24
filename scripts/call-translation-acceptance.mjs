#!/usr/bin/env node
/**
 * A real spoken sentence through the WHOLE live translation pipeline.
 *
 *   node scripts/call-translation-acceptance.mjs <speech.wav> [baseUrl]
 *
 * WHY THIS EXISTS. Every other acceptance script here stops short of the thing
 * people actually complain about. call-media-acceptance proves audio reaches
 * the server, but it publishes a TONE -- which cannot be transcribed, so it can
 * never exercise recognition, translation or synthesis. Diagnosing this by
 * asking somebody to place a call, speak, and report back cost most of a night
 * and a dozen round trips, each one testing a single hypothesis.
 *
 * This joins two participants on different languages, publishes real recorded
 * SPEECH from one of them, and waits for the other to receive translated audio.
 * It reports which stage produced output, so a failure names its own leg
 * instead of presenting as "silence".
 */
import { readFileSync } from 'node:fs';
import { io } from 'socket.io-client';
import wrtc from '@roamhq/wrtc';

const { RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, nonstandard } = wrtc;

const WAV = process.argv[2];
const BASE = process.argv[3] ?? 'https://staging.consummate7.com';
if (!WAV) {
  console.error('usage: call-translation-acceptance.mjs <speech.wav> [baseUrl]');
  process.exit(2);
}

let failures = 0;
function record(name, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** PCM16 mono samples out of a RIFF/WAVE file, with its declared rate. */
function readWav(path) {
  const buffer = readFileSync(path);
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a RIFF file');
  let offset = 12;
  let sampleRate = 16000;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') sampleRate = buffer.readUInt32LE(body + 4);
    if (id === 'data') {
      data = buffer.subarray(body, Math.min(body + size, buffer.length));
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!data) throw new Error('no data chunk');
  return { samples: new Int16Array(data.buffer, data.byteOffset, Math.floor(data.length / 2)), sampleRate };
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
    socket.on('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.on('connect_error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function emitAck(socket, event, payload, ms = 25000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'ack timeout' }), ms);
    socket.emit(event, payload, (response) => { clearTimeout(timer); resolve(response ?? { ok: false, error: 'empty ack' }); });
  });
}

const speech = readWav(WAV);
const callId = `TRA${Math.floor(Date.now() / 1000) % 100000}`;
console.log(`Live translation pipeline against ${BASE}`);
console.log(`speech: ${(speech.samples.length / speech.sampleRate).toFixed(1)}s @ ${speech.sampleRate}Hz\n`);

const speaker = await connect();
const listener = await connect();

const base = {
  callId, captionsEnabled: true, voiceGender: 'female',
  audioMode: 'translated', callType: 'conference', callMode: 'translated',
};
const speakerJoin = await emitAck(speaker, 'call:join', {
  ...base, displayName: 'EN', speakLanguage: 'en', hearLanguage: 'en',
});
const listenerJoin = await emitAck(listener, 'call:join', {
  ...base, displayName: 'FR', speakLanguage: 'fr', hearLanguage: 'fr',
});
record('two participants joined on different languages',
  speakerJoin?.ok !== false && listenerJoin?.ok !== false, callId);
if (speakerJoin?.ok === false || listenerJoin?.ok === false) process.exit(1);

// --- what the listener receives -------------------------------------------
const captions = [];
const frames = [];
listener.on('call:caption', (payload) => captions.push(payload));
listener.on('call:translated-audio-frame', (payload) => frames.push(payload));
// Anything the runtime refuses is worth seeing rather than timing out on.
for (const [name, socket] of [['speaker', speaker], ['listener', listener]]) {
  socket.on('call:error', (event) => console.log(`  (${name} call:error) ${event?.code}: ${event?.message}`));
}

// --- publish the speech ----------------------------------------------------
const pc = new RTCPeerConnection({ iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }] });
const source = new nonstandard.RTCAudioSource();
pc.addTrack(source.createTrack());

pc.onicecandidate = (event) => {
  if (event.candidate) {
    speaker.emit('call:publish:ice', {
      callId, participantId: speakerJoin.participantId, candidate: event.candidate,
    });
  }
};
// The backend answers with ITS candidates on the same event name, in the
// opposite direction.
speaker.on('call:publish:ice', (payload) => {
  if (payload?.candidate) pc.addIceCandidate(new RTCIceCandidate(payload.candidate)).catch(() => {});
});

const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
const published = await emitAck(speaker, 'call:publish:offer', {
  callId, participantId: speakerJoin.participantId, sdp: offer.sdp,
});
record('publish peer negotiated', published?.ok === true && typeof published.sdp === 'string',
  published?.ok === true ? '' : JSON.stringify(published).slice(0, 120));
if (published?.ok !== true) process.exit(1);
await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: published.sdp }));

const ice = await new Promise((resolve) => {
  const deadline = setTimeout(() => resolve(pc.iceConnectionState), 30000);
  pc.oniceconnectionstatechange = () => {
    const state = pc.iceConnectionState;
    if (state === 'connected' || state === 'completed' || state === 'failed') {
      clearTimeout(deadline);
      resolve(state);
    }
  };
});
record('media path connected', ice === 'connected' || ice === 'completed', ice);

// Fed in 10ms frames at real time. Faster than real time is not a shortcut:
// the recogniser's endpointing works on wall-clock silence, so a burst arrives
// as one unbroken utterance and behaves nothing like speech.
const frameSize = speech.sampleRate / 100;
let cursor = 0;
await new Promise((resolve) => {
  const timer = setInterval(() => {
    if (cursor + frameSize > speech.samples.length) {
      clearInterval(timer);
      resolve();
      return;
    }
    source.onData({
      // COPIED, not a subarray. wrtc inspects the underlying buffer, and a
      // view onto the whole file fails with "expected a .byteLength of 320".
      samples: speech.samples.slice(cursor, cursor + frameSize),
      sampleRate: speech.sampleRate,
      bitsPerSample: 16,
      channelCount: 1,
    });
    cursor += frameSize;
  }, 10);
});
// Trailing silence, so the recogniser sees the utterance END rather than an
// abrupt stop it may still be waiting on.
const silence = new Int16Array(frameSize);
for (let i = 0; i < 150; i += 1) {
  source.onData({ samples: silence, sampleRate: speech.sampleRate, bitsPerSample: 16, channelCount: 1 });
  await new Promise((r) => setTimeout(r, 10));
}
console.log('  (spoke, waiting for the pipeline)');

const deadline = Date.now() + 45000;
while (Date.now() < deadline && frames.length === 0) {
  await new Promise((r) => setTimeout(r, 500));
}

console.log('');
record('the listener received captions', captions.length > 0, `${captions.length} caption(s)`);
const withText = captions.filter((c) => (c?.originalText ?? c?.text ?? '').trim().length > 0);
record('a caption carried recognised words', withText.length > 0,
  withText[0] ? JSON.stringify(withText[0].originalText ?? withText[0].text).slice(0, 80) : 'none');
const translated = captions.filter((c) => (c?.translatedText ?? '').trim().length > 0);
record('a caption carried TRANSLATED text', translated.length > 0,
  translated[0] ? JSON.stringify(translated[0].translatedText).slice(0, 80) : 'no translated caption');
record('the listener received TRANSLATED AUDIO', frames.length > 0,
  frames.length > 0
    ? `${frames.length} frame(s), ${frames.filter((f) => f.final).length} final`
    : 'no call:translated-audio-frame arrived');

pc.close();
speaker.close();
listener.close();
console.log(`\n${failures === 0 ? 'live translation pipeline OK' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
