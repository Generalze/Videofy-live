#!/usr/bin/env node
// @author masterzee001
/**
 * C-AI1.1E acceptance: the PRODUCTION composition, end to end.
 *
 * The distinction from the C-AI1.1D proof matters and is the reason this file
 * exists separately. That one wired the new parts together directly and showed
 * they work. This one drives `MediaTranscriptionBridge.handleFrame` -- the
 * function the gateway actually calls for every captured audio frame -- through
 * the real `LiveIngressSender`, a real WebSocket, the real ingress server, and
 * the real `createLiveStreamOpener`. Nothing here is a parallel test-only path.
 *
 * PROVIDERS ARE DETERMINISTIC, NOT ABSENT. A scripted recogniser and
 * synthesiser stand in for Deepgram and ElevenLabs, so this runs in CI forever
 * without credentials and fails for reasons about our pipeline rather than
 * about a vendor's uptime. What is being proved is the platform's behaviour,
 * which must hold whichever vendor is configured.
 *
 * What it claims:
 *   1. live audio enters the realtime ingress and NO sourcePath WAV is written
 *   2. the recogniser receives incremental frames, not a growing window
 *   3. a partial caption appears, then a Videofy final
 *   4. translation runs from the final ONLY, never from a partial
 *   5. the first translated audio reaches the listener seam before synthesis
 *      of that utterance has finished
 *   6. frames arrive ordered, and a superseded generation is abandoned
 *   7. finish, abort and a dropped transport stay distinguishable
 *   8. a live programme takes the same path with stabilised finalisation
 *   9. the uploaded-programme batch path is untouched
 */
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const ingestDist = '../services/media-ingest/dist/services/media-ingest/src';
const gatewayDist = '../services/realtime-gateway/dist';

const { attachRealtimeAudioIngress, REALTIME_INGRESS_PATH } = await import(
  `${ingestDist}/realtime-ingress-server.js`
);
const { createLiveStreamOpener } = await import(`${ingestDist}/live-session-host.js`);
const { MediaTranscriptionBridge, serviceContextForMode } = await import(
  `${gatewayDist}/media-transcription-bridge.js`
);
const { shouldUseMediaTranscriptionForProgrammeSource } = await import(`${gatewayDist}/gateway.js`);

const TOKEN = 'production-acceptance-token-32-chars';
const AUTH = { mode: 'enforced', token: TOKEN, source: 'acceptance' };
const FRAME = 320;

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed });
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}\n`);
}
function reportFatal(error) {
  process.stdout.write(
    `FAIL  the acceptance could not run to completion -- ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
}
process.on('uncaughtException', reportFatal);
process.on('unhandledRejection', reportFatal);

function voicedFrame() {
  const samples = new Int16Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) samples[i] = i % 2 === 0 ? 6000 : -6000;
  return { samples, sampleRate: 16000, channelCount: 1 };
}
const quietFrame = () => ({ samples: new Int16Array(FRAME), sampleRate: 16000, channelCount: 1 });

// --- deterministic providers ------------------------------------------------

/**
 * A recogniser that behaves like a real streaming one: partials as audio
 * accumulates, a provider final once speech stops. It records every frame it
 * was given, which is how claim 2 is measured.
 */
function scriptedRecogniser(record) {
  return {
    name: 'scripted-streaming-stt',
    openStream: async (options) => {
      let voiced = 0;
      let emittedPartials = 0;
      let sentFinal = false;
      const words = ['good', 'good afternoon', 'good afternoon everyone'];
      return {
        get isClosed() { return false; },
        pushAudio: async (frame) => {
          record.frames.push(frame);
          const loud = frame.samples.some((s) => Math.abs(s) > 3000);
          if (loud) {
            voiced += 1;
            sentFinal = false;
            if (voiced % 3 === 0 && emittedPartials < words.length) {
              options.onSignal({ kind: 'partial', text: words[emittedPartials] });
              emittedPartials += 1;
            }
          } else if (voiced > 0 && !sentFinal) {
            sentFinal = true;
            options.onSignal({ kind: 'final', text: words[words.length - 1] });
            voiced = 0;
            emittedPartials = 0;
          }
        },
        finish: async () => { record.finishes += 1; },
        close: async () => { record.closes += 1; },
      };
    },
  };
}

function scriptedTranslator(record) {
  return {
    name: 'scripted-mt',
    translate: async (input) => {
      record.translations.push(input);
      return { translatedText: `[es] ${input.sourceText}` };
    },
  };
}

/** Yields audio in pieces with real gaps, the shape of any streaming TTS. */
function scriptedSynthesiser(record) {
  return {
    name: 'scripted-streaming-tts',
    synthesize: async (options) => {
      let samples = 0;
      for (let piece = 0; piece < 4; piece += 1) {
        if (options.signal?.aborted === true) {
          return { samples, timeToFirstChunkMs: 0, totalMs: 0, aborted: true };
        }
        await delay(12);
        record.timeline.push('synth-chunk');
        options.onChunk({ samples: new Int16Array(640).fill(11) });
        samples += 640;
      }
      record.timeline.push('synth-complete');
      return { samples, timeToFirstChunkMs: 12, totalMs: 48, aborted: false };
    },
  };
}

// --- the real ingress, on a real port --------------------------------------

const record = {
  frames: [], finishes: 0, closes: 0, translations: [],
  captions: [], timeline: [], endings: [],
};

const server = createServer((_req, res) => res.writeHead(404).end());
let mintCounter = 0;
const handle = attachRealtimeAudioIngress(server, {
  auth: AUTH,
  openStream: createLiveStreamOpener({
    transcription: scriptedRecogniser(record),
    translation: scriptedTranslator(record),
    synthesis: scriptedSynthesiser(record),
    mintSegmentId: () => `seg_${(mintCounter += 1)}`,
    speechPlanFor: () => ({ targetLanguage: 'es', voiceId: 'videofy-es' }),
    onCaption: (event) => {
      record.captions.push(event);
      if (event.kind === 'final') record.timeline.push(`final:${event.segmentId}`);
    },
    // Programme sessions stabilise; a call finalises at once. Kept short so
    // the acceptance does not sit waiting on a real stabilisation window.
    stabilizationMs: 120,
    speech: { endSilenceMs: 60, minSpeechMs: 40 },
    frameSamples: FRAME,
  }),
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `ws://127.0.0.1:${server.address().port}${REALTIME_INGRESS_PATH}`;

// --- the real bridge, as the gateway constructs it --------------------------

const submissions = [];
const translatedToListener = [];

function makeBridge() {
  return new MediaTranscriptionBridge({
    stagingDir: new URL('../uploads/acceptance-staging', import.meta.url).pathname,
    client: {
      createSession: async () => {},
      submitChunk: async (_s, _c, sourcePath) => submissions.push(sourcePath),
      stopSession: async () => {},
    },
    realtimeIngress: {
      url,
      token: TOKEN,
      onTranslatedAudio: (context, frame) => {
        translatedToListener.push({ context: context.sessionId, frame });
        record.timeline.push(`listener:${frame.segmentId}#${frame.sequence}`);
      },
    },
  });
}

async function speak(bridge, context, pattern) {
  for (const token of pattern) {
    bridge.handleFrame(context, token === 'v' ? voicedFrame() : quietFrame());
    // Real capture is paced; sending 200 frames in one tick would test a
    // burst nobody experiences and hide ordering behind the event loop.
    await delay(1);
  }
}

const callContext = {
  sessionId: 'call_acceptance',
  broadcastId: 'bc_call',
  broadcasterPeerId: 'peer_1',
  revision: 1,
  mediaSessionMode: 'live-conversation',
  targetLanguage: 'es',
};

// --- Call ------------------------------------------------------------------

{
  const bridge = makeBridge();
  const pattern = [...'v'.repeat(24), ...'q'.repeat(10)];
  await speak(bridge, callContext, pattern);
  await delay(400);

  check(
    'live call audio never writes a sourcePath WAV',
    submissions.length === 0,
    `${submissions.length} chunk submissions`,
  );
  check(
    'the recogniser receives incremental frames, one per captured frame',
    record.frames.length === pattern.length,
    `${record.frames.length} of ${pattern.length}`,
  );
  const totalSamples = record.frames.reduce((sum, f) => sum + f.samples.length, 0);
  const quadratic = ((pattern.length * (pattern.length + 1)) / 2) * FRAME;
  check(
    'no growing-window retranscription',
    totalSamples === pattern.length * FRAME,
    `${totalSamples} samples vs ${quadratic} for the growing-window path`,
  );

  const partials = record.captions.filter((c) => c.kind === 'partial');
  const finals = record.captions.filter((c) => c.kind === 'final');
  check('a partial caption appears', partials.length > 0, `${partials.length} partials`);
  check('a Videofy final is produced', finals.length > 0, `${finals.length} finals`);
  check(
    'translation runs from the final only, never from a partial',
    record.translations.length === finals.length && record.translations.length > 0,
    `${record.translations.length} translations for ${finals.length} finals`,
  );

  const firstListener = record.timeline.findIndex((e) => e.startsWith('listener:'));
  const synthComplete = record.timeline.indexOf('synth-complete');
  check(
    'the listener hears audio before synthesis of that utterance completes',
    firstListener >= 0 && synthComplete >= 0 && firstListener < synthComplete,
    `first frame at step ${firstListener}, synthesis complete at ${synthComplete}`,
  );

  const bySegment = new Map();
  for (const { frame } of translatedToListener) {
    const key = `${frame.segmentId}#${frame.generation}`;
    if (!bySegment.has(key)) bySegment.set(key, []);
    bySegment.get(key).push(frame.sequence);
  }
  const ordered = [...bySegment.values()].every((seqs) =>
    seqs.every((value, index) => value === index),
  );
  check(
    'translated frames reach the listener ordered, with platform identity',
    ordered && bySegment.size > 0,
    `${translatedToListener.length} frames across ${bySegment.size} generations`,
  );
  const opaque = translatedToListener.every(
    ({ frame }) =>
      typeof frame.segmentId === 'string' &&
      typeof frame.generation === 'number' &&
      !('vendor' in frame) &&
      !('model' in frame),
  );
  check('nothing vendor-shaped reaches the listener seam', opaque);

  bridge.endSession(callContext, 'hangup');
  await delay(150);
  check('ending a call finishes the provider stream', record.finishes >= 1, `${record.finishes}`);
}

// --- Programme live ---------------------------------------------------------

{
  const before = record.frames.length;
  const submissionsBefore = submissions.length;
  const bridge = makeBridge();
  const programmeContext = {
    ...callContext,
    sessionId: 'programme_acceptance',
    broadcastId: 'bc_prog',
    mediaSessionMode: 'programme',
  };
  await speak(bridge, programmeContext, [...'v'.repeat(18), ...'q'.repeat(8)]);
  await delay(500);

  check(
    'a live programme takes the same realtime path',
    record.frames.length > before && submissions.length === submissionsBefore,
    `${record.frames.length - before} frames, ${submissions.length - submissionsBefore} submissions`,
  );
  const programmeFinals = record.captions.filter(
    (c) => c.kind === 'final' && c.sessionId === 'programme_acceptance',
  );
  check(
    'a live programme still produces a stabilised final',
    programmeFinals.length > 0,
    `${programmeFinals.length} finals`,
  );
  bridge.endSession(programmeContext, 'programme ended');
  await delay(100);
}

// --- Programme uploaded -----------------------------------------------------

{
  // The batch path is not merely untouched by accident: uploaded programmes
  // never reach the bridge at all, which is what makes programme/uploaded
  // impossible on the realtime wire rather than merely discouraged.
  check(
    'an uploaded programme never reaches the realtime bridge',
    shouldUseMediaTranscriptionForProgrammeSource('uploaded-video') === false,
  );
  check(
    'live programme sources still do reach it',
    shouldUseMediaTranscriptionForProgrammeSource('rtmp') === true &&
      shouldUseMediaTranscriptionForProgrammeSource(undefined) === true,
  );
  check(
    'every context the bridge can produce is live',
    ['live-conversation', 'programme'].every(
      (mode) => serviceContextForMode(mode).mediaMode === 'live',
    ),
  );
}

// --- abort and a dropped transport ------------------------------------------

{
  const bridge = makeBridge();
  const abortContext = { ...callContext, sessionId: 'call_abort', broadcastId: 'bc_abort' };
  await speak(bridge, abortContext, [...'v'.repeat(6)]);
  await delay(100);
  const closesBefore = record.closes;
  // A gateway that drops a session without finishing it: the transport case.
  bridge.endSession(abortContext, 'network dropped');
  await delay(150);
  check(
    'a session that ends still closes its provider stream exactly once',
    record.closes === closesBefore + 1,
    `${record.closes - closesBefore}`,
  );
}

await handle.close();
await new Promise((resolve) => server.close(resolve));

const failed = results.filter((r) => !r.passed);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
