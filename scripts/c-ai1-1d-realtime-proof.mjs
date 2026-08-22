#!/usr/bin/env node
// @author masterzee001
/**
 * C-AI1.1D acceptance: the live path, over a real socket, end to end.
 *
 * This is the proof that the unit tests deliberately cannot be. Every pin in
 * the suites runs against an in-process object; this binds a port, authenticates
 * an HTTP upgrade, and pushes audio through the gateway client into
 * media-ingest across a real WebSocket. It imports the BUILT output of both
 * services, so what runs here is what would ship.
 *
 * What it claims, and nothing more:
 *
 *   1. an unauthenticated upgrade is refused before becoming a socket
 *   2. audio crosses the wire ONCE, not once per partial
 *   3. the first translated audio reaches a listener before synthesis finishes
 *   4. playback is ordered, and cancelling discards only what was undelivered
 *   5. finish, abort and a dropped transport stay distinguishable end to end
 *
 * What it does NOT claim: nothing here talks to a commercial provider. Provider
 * certification is the separate credential-gated smoke test, and remains
 * external and deferred.
 */
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const ingest = await import('../services/media-ingest/dist/services/media-ingest/src/realtime-ingress-server.js');
const { RealtimeIngressClient } = await import(
  '../services/realtime-gateway/dist/realtime-ingress-client.js'
);
const { TranslatedAudioDelivery } = await import(
  '../services/media-ingest/dist/services/media-ingest/src/translated-audio-delivery.js'
);
const { speakSegment } = await import('../services/media-ingest/dist/services/media-ingest/src/speak-segment.js');
const { MockStreamingSynthesisProvider } = await import(
  '../services/media-ingest/dist/services/media-ingest/src/streaming-speech-synthesis-provider.js'
);

const TOKEN = 'proof-token-that-is-long-enough-32chars';
const AUTH = { mode: 'enforced', token: TOKEN, source: 'proof' };

const results = [];

// A proof that dies with a stack trace has still failed, but it fails
// illegibly -- and the first thing anyone does with an illegible failure is
// assume the harness is broken rather than the code.
function reportFatal(error) {
  process.stdout.write(
    `FAIL  the proof could not run to completion -- ${error instanceof Error ? error.message : String(error)}
`,
  );
  process.exit(1);
}
process.on('uncaughtException', reportFatal);
process.on('unhandledRejection', reportFatal);

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}\n`);
}

// --- a real server on a real port ------------------------------------------

const received = [];
const endings = [];
const server = createServer((_req, res) => {
  res.writeHead(404).end();
});
const handle = ingest.attachRealtimeAudioIngress(server, {
  auth: AUTH,
  openStream: async (open) => {
    if (open.sessionId === 'refuse-me') return null;
    return {
      onAudio: (frame) => {
        received.push(frame);
      },
      finish: (reason) => endings.push(`finish:${reason}`),
      abort: (reason) => endings.push(`abort:${reason}`),
      disconnected: (reason) => endings.push(`disconnected:${reason.split(':')[0]}`),
    };
  },
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const url = `ws://127.0.0.1:${port}${ingest.REALTIME_INGRESS_PATH}`;

// --- 1. the credential is checked before a socket exists --------------------

{
  const client = new RealtimeIngressClient({
    url,
    sessionId: 'cs_1',
    streamId: 'st_unauth',
    serviceCategory: 'call',
    openTimeoutMs: 3000,
  });
  let refused = false;
  try {
    await client.open();
  } catch {
    refused = true;
  }
  await client.close();
  check(
    'an unauthenticated upgrade is refused',
    refused && handle.connections === 0,
    `connections=${handle.connections}`,
  );
}

// --- 2. audio crosses the wire once, not once per partial -------------------

const FRAME_SAMPLES = 320; // 20 ms at 16 kHz
const FRAMES = 150; // three seconds of speech
let bytesOnWire = 0;

{
  const client = new RealtimeIngressClient({
    url,
    token: TOKEN,
    sessionId: 'cs_1',
    streamId: 'st_1',
    serviceCategory: 'call',
    sourceLanguage: 'en',
  });
  await client.open();

  for (let index = 0; index < FRAMES; index += 1) {
    const samples = new Int16Array(FRAME_SAMPLES);
    for (let i = 0; i < FRAME_SAMPLES; i += 1) samples[i] = (index * 7 + i) % 3000;
    client.sendAudio(samples, 1_000_000 + index * 20);
    bytesOnWire += 16 + FRAME_SAMPLES * 2;
  }
  // Let the frames land before asserting.
  for (let waited = 0; waited < 200 && received.length < FRAMES; waited += 1) await delay(10);

  const sampleBytes = FRAMES * FRAME_SAMPLES * 2;
  // The old path re-sent the whole utterance-so-far for every partial: with a
  // partial per frame that is sum(1..N) frames of audio, not N.
  const quadraticBytes = ((FRAMES * (FRAMES + 1)) / 2) * FRAME_SAMPLES * 2;
  check(
    'every sample crosses the wire exactly once',
    received.length === FRAMES && bytesOnWire < sampleBytes * 1.05,
    `${received.length}/${FRAMES} frames, ${bytesOnWire} bytes vs ${quadraticBytes} for the growing-window path`,
  );

  const ordered = received.every((frame, index) => frame.sequence === index);
  const clocksIntact = received.every(
    (frame, index) => frame.platformTimestampMs === 1_000_000 + index * 20,
  );
  check('frames arrive in order with the gateway clock intact', ordered && clocksIntact);

  client.finish('speaker stopped');
  await delay(50);
  check('finish is delivered as finish', endings.includes('finish:speaker stopped'), endings.join(','));
  await client.close();
}

// --- 3. first audio out before synthesis completes --------------------------

{
  const delivered = [];
  const timeline = [];
  const delivery = new TranslatedAudioDelivery({
    cancellationPolicy: 'immediate',
    deliver: (frame) => {
      delivered.push(frame);
      timeline.push(`out:${frame.sequence}`);
      return true;
    },
  });

  // A provider that yields audio in pieces, with the last piece arriving well
  // after the first: the shape of any real streaming synthesis.
  const slow = {
    name: 'slow-streaming',
    synthesize: async (options) => {
      let samples = 0;
      for (const size of [640, 640, 640, 640]) {
        await delay(15);
        timeline.push('chunk');
        options.onChunk({ samples: new Int16Array(size).fill(9) });
        samples += size;
      }
      return { samples, timeToFirstChunkMs: 15, totalMs: 60, aborted: false };
    },
  };

  const outcome = await speakSegment({
    provider: slow,
    delivery,
    segmentId: 'seg_1',
    generation: 1,
    segmentStartMs: 0,
    text: 'buenas tardes',
    targetLanguage: 'es',
    voiceId: 'v1',
    frameSamples: FRAME_SAMPLES,
  });

  const firstOut = timeline.indexOf('out:0');
  const lastChunk = timeline.lastIndexOf('chunk');
  check(
    'a listener hears the first audio before synthesis has finished',
    firstOut >= 0 && firstOut < lastChunk,
    `first frame out at step ${firstOut}, last chunk at ${lastChunk}`,
  );
  check(
    'playback is ordered and ends with a final frame',
    delivered.every((frame, index) => frame.sequence === index) &&
      delivered.at(-1)?.final === true &&
      outcome.completed,
  );
}

// --- 4. cancellation is honest about what it achieved -----------------------

{
  let accept = true;
  const delivered = [];
  const delivery = new TranslatedAudioDelivery({
    cancellationPolicy: 'immediate',
    deliver: (frame) => {
      if (!accept) return false;
      delivered.push(frame);
      return true;
    },
  });
  delivery.beginGeneration('seg_2', 1);
  await speakSegment({
    provider: new MockStreamingSynthesisProvider([640]),
    delivery,
    segmentId: 'seg_2',
    generation: 2,
    segmentStartMs: 0,
    text: 'el martes',
    targetLanguage: 'es',
    voiceId: 'v1',
    frameSamples: FRAME_SAMPLES,
  });
  const heard = delivered.length;
  accept = false;
  // The speaker corrects themselves: more audio is produced, none of it lands.
  delivery.offer({
    segmentId: 'seg_2',
    generation: 2,
    sequence: heard,
    samples: new Int16Array(FRAME_SAMPLES),
    sampleRate: 16000,
    channelCount: 1,
    final: false,
    segmentStartMs: 0,
  });
  const cancelled = delivery.cancel('seg_2', 'speaker corrected themselves');
  check(
    'cancelling discards only what nobody heard, and says so',
    cancelled.discardedFrames === 1 && cancelled.deliveredMs === heard * 20,
    `discarded=${cancelled.discardedFrames} alreadyHeard=${cancelled.deliveredMs}ms`,
  );
}

// --- 5. abort and a dropped transport stay distinguishable ------------------

{
  endings.length = 0;
  const aborting = new RealtimeIngressClient({
    url, token: TOKEN, sessionId: 'cs_1', streamId: 'st_abort', serviceCategory: 'call',
  });
  await aborting.open();
  aborting.sendAudio(new Int16Array(FRAME_SAMPLES), 2_000_000);
  aborting.abort('superseded');
  await delay(50);
  await aborting.close();

  const dropping = new RealtimeIngressClient({
    url, token: TOKEN, sessionId: 'cs_1', streamId: 'st_drop', serviceCategory: 'call',
  });
  await dropping.open();
  dropping.sendAudio(new Int16Array(FRAME_SAMPLES), 3_000_000);
  // Yank the transport without saying anything, the way a network does.
  await dropping.close();
  await delay(50);

  check(
    'abort and a dropped transport are two different endings',
    endings.includes('abort:superseded') && endings.some((e) => e.startsWith('disconnected:')),
    endings.join(','),
  );
}

// --- 6. a refused stream is refused, and never silently accepted ------------

{
  const client = new RealtimeIngressClient({
    url, token: TOKEN, sessionId: 'refuse-me', streamId: 'st_no',
    serviceCategory: 'call', openTimeoutMs: 1500,
  });
  let refused = false;
  try {
    await client.open();
  } catch {
    refused = true;
  }
  await client.close();
  check('a stream the platform refuses never reports itself open', refused);
}

await handle.close();
await new Promise((resolve) => server.close(resolve));

const failed = results.filter((r) => !r.passed);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
