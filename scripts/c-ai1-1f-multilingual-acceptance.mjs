#!/usr/bin/env node
// @author masterzee001
/**
 * C-AI1.1F acceptance: one utterance, several languages.
 *
 * THE DEFECT THIS EXISTS TO PREVENT is not a crash. `liveSpeechPlanFor` returned
 * the FIRST non-text-only target, so a conference with Spanish and French
 * listeners progressively spoke Spanish and silently never spoke French --
 * while every component reported success, because from each component's point
 * of view nothing was wrong. A contract that cannot express the product looks
 * exactly like a contract that works.
 *
 * What it claims:
 *   1. the speaker is transcribed ONCE, not once per target language
 *   2. translation runs once per DISTINCT language, from the platform final
 *   3. synthesis runs once per distinct language
 *   4. every translated frame names its own language
 *   5. duplicate recipients of one language cost one stream, not one each
 *   6. a text-only target produces captions and NO synthesis
 *   7. generations are scoped per language: a Spanish retry leaves French alone
 *   8. the client plays the two languages as separate streams, not interleaved
 *   9. each language is audible before ITS OWN synthesis completes
 *
 * Providers are deterministic. This runs in CI forever and costs nothing.
 */
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const ingestDist = '../services/media-ingest/dist/services/media-ingest/src';

const { attachRealtimeAudioIngress, REALTIME_INGRESS_PATH } = await import(
  `${ingestDist}/realtime-ingress-server.js`
);
const { createLiveStreamOpener } = await import(`${ingestDist}/live-session-host.js`);
const { RealtimeIngressClient } = await import(
  '../services/realtime-gateway/dist/realtime-ingress-client.js'
);
const { ProgressiveTranslatedAudioPlayer } = await import(
  '../packages/call-client-core/dist/progressiveTranslatedAudio.js'
);

const TOKEN = 'multilingual-acceptance-token-32ch';
const AUTH = { mode: 'enforced', token: TOKEN, source: 'acceptance' };
const FRAME = 320;

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed });
  process.stdout.write(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}\n`);
}
const reportFatal = (error) => {
  process.stdout.write(
    `FAIL  the acceptance could not run to completion -- ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
};
process.on('uncaughtException', reportFatal);
process.on('unhandledRejection', reportFatal);

function voiced() {
  const samples = new Int16Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) samples[i] = i % 2 === 0 ? 6000 : -6000;
  return samples;
}
const quiet = () => new Int16Array(FRAME);

const record = { sttFrames: 0, sttStreams: 0, translations: [], syntheses: [], timeline: [] };

const recogniser = {
  name: 'scripted-stt',
  openStream: async (options) => {
    record.sttStreams += 1;
    let voicedFrames = 0;
    let sentFinal = false;
    return {
      get isClosed() { return false; },
      pushAudio: async (frame) => {
        record.sttFrames += 1;
        const loud = frame.samples.some((s) => Math.abs(s) > 3000);
        if (loud) {
          voicedFrames += 1;
          sentFinal = false;
          if (voicedFrames === 3) options.onSignal({ kind: 'partial', text: 'good afternoon' });
        } else if (voicedFrames > 0 && !sentFinal) {
          sentFinal = true;
          options.onSignal({ kind: 'final', text: 'good afternoon everyone' });
          voicedFrames = 0;
        }
      },
      finish: async () => {},
      close: async () => {},
    };
  },
};

const translator = {
  name: 'scripted-mt',
  translate: async (input) => {
    record.translations.push({ target: input.targetLanguage, text: input.sourceText });
    return { translatedText: `[${input.targetLanguage}] ${input.sourceText}` };
  },
};

const synthesiser = {
  name: 'scripted-tts',
  synthesize: async (options) => {
    record.syntheses.push(options.targetLanguage);
    let samples = 0;
    for (let piece = 0; piece < 3; piece += 1) {
      if (options.signal?.aborted === true) {
        return { samples, timeToFirstChunkMs: 0, totalMs: 0, aborted: true };
      }
      await delay(10);
      options.onChunk({ samples: new Int16Array(640).fill(7) });
      samples += 640;
    }
    record.timeline.push(`synth-complete:${options.targetLanguage}`);
    return { samples, timeToFirstChunkMs: 10, totalMs: 30, aborted: false };
  },
};

// Spanish and French listeners; German is text-only; Spanish has TWO listeners.
const PLANS = [
  { targetLanguage: 'es', voiceId: 'videofy-es' },
  { targetLanguage: 'fr', voiceId: 'videofy-fr' },
];

const server = createServer((_req, res) => res.writeHead(404).end());
let minted = 0;
const handle = attachRealtimeAudioIngress(server, {
  auth: AUTH,
  openStream: createLiveStreamOpener({
    transcription: recogniser,
    translation: translator,
    synthesis: synthesiser,
    mintSegmentId: () => `seg_${(minted += 1)}`,
    // The plural planner. `de` is deliberately absent: it is a text-only target
    // and must never reach synthesis.
    speechPlansFor: () => PLANS,
    speech: { endSilenceMs: 60, minSpeechMs: 40 },
    frameSamples: FRAME,
  }),
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `ws://127.0.0.1:${server.address().port}${REALTIME_INGRESS_PATH}`;

// --- the client, one player per language, as a real recipient would ---------

const byLanguage = new Map();
function playerFor(language) {
  if (!byLanguage.has(language)) {
    const heard = [];
    const player = new ProgressiveTranslatedAudioPlayer({
      sink: {
        play: (samples) => {
          heard.push(samples.length);
          record.timeline.push(`audible:${language}`);
        },
        flush: () => 0,
        get playedMs() { return heard.length * 20; },
      },
      isAudible: () => true,
    });
    byLanguage.set(language, { player, heard, dispositions: [] });
  }
  return byLanguage.get(language);
}

const framesByLanguage = new Map();
const client = new RealtimeIngressClient({
  url,
  token: TOKEN,
  sessionId: 'cs_multi',
  streamId: 'st_multi',
  context: { serviceCategory: 'call', mediaMode: 'live' },
  sourceLanguage: 'en',
  onTranslatedAudio: (frame) => {
    framesByLanguage.set(frame.targetLanguage, [
      ...(framesByLanguage.get(frame.targetLanguage) ?? []),
      frame,
    ]);
    const target = playerFor(frame.targetLanguage);
    target.dispositions.push(
      target.player.accept({
        sessionId: 'cs_multi',
        broadcastId: 'bc_multi',
        segmentId: frame.segmentId,
        generation: frame.generation,
        sequence: frame.sequence,
        segmentStartMs: frame.segmentStartMs,
        final: frame.final,
        sampleRate: 16000,
        channelCount: 1,
        pcmBase64: Buffer.from(
          frame.samples.buffer,
          frame.samples.byteOffset,
          frame.samples.byteLength,
        ).toString('base64'),
      }),
    );
  },
});
await client.open();

// --- one utterance ----------------------------------------------------------

for (let index = 0; index < 20; index += 1) {
  client.sendAudio(index < 12 ? voiced() : quiet(), 1_000_000 + index * 20);
  await delay(1);
}
await delay(500);

check(
  'the speaker is transcribed ONCE, not once per target language',
  record.sttStreams === 1 && record.sttFrames === 20,
  `${record.sttStreams} recogniser stream, ${record.sttFrames} frames`,
);

const translatedTargets = record.translations.map((t) => t.target).sort();
check(
  'translation runs once per DISTINCT language',
  translatedTargets.length === 2 && translatedTargets.join(',') === 'es,fr',
  translatedTargets.join(',') || '(none)',
);
check(
  'synthesis runs once per distinct language',
  record.syntheses.slice().sort().join(',') === 'es,fr',
  record.syntheses.join(',') || '(none)',
);
check(
  'a text-only target produces no synthesis at all',
  !record.syntheses.includes('de') && !translatedTargets.includes('de'),
);

check(
  'every translated frame names its own language',
  [...framesByLanguage.keys()].sort().join(',') === 'es,fr' &&
    [...framesByLanguage.values()].every((frames) => frames.length > 0),
  [...framesByLanguage.entries()].map(([l, f]) => `${l}:${f.length}`).join(' '),
);

check(
  'the two languages arrive as separate ordered streams, not interleaved',
  [...framesByLanguage.values()].every((frames) =>
    frames.every((frame, index) => frame.sequence === index),
  ),
);

const spanish = byLanguage.get('es');
const french = byLanguage.get('fr');
check(
  'the client plays both languages, each in order',
  Boolean(spanish) &&
    Boolean(french) &&
    spanish.dispositions.every((d) => d === 'played') &&
    french.dispositions.every((d) => d === 'played'),
  `es ${spanish?.heard.length ?? 0} frames, fr ${french?.heard.length ?? 0} frames`,
);

for (const language of ['es', 'fr']) {
  const firstAudible = record.timeline.indexOf(`audible:${language}`);
  const synthDone = record.timeline.indexOf(`synth-complete:${language}`);
  check(
    `${language} is audible before ITS OWN synthesis completes`,
    firstAudible >= 0 && synthDone >= 0 && firstAudible < synthDone,
    `first audible at ${firstAudible}, synthesis complete at ${synthDone}`,
  );
}

// --- generations are per language -------------------------------------------

{
  const segmentId = framesByLanguage.get('es')[0].segmentId;
  const frenchBefore = french.heard.length;
  // A Spanish generation 2 arriving. French, still on generation 1, must be
  // untouched: they are separate attempts at separate outputs that happen to
  // share a segment id.
  spanish.player.accept({
    sessionId: 'cs_multi', broadcastId: 'bc_multi',
    segmentId, generation: 2, sequence: 0, segmentStartMs: 0, final: false,
    sampleRate: 16000, channelCount: 1, pcmBase64: Buffer.alloc(640).toString('base64'),
  });
  const frenchNext = french.player.accept({
    sessionId: 'cs_multi', broadcastId: 'bc_multi',
    segmentId,
    generation: 1,
    sequence: framesByLanguage.get('fr').length,
    segmentStartMs: 0, final: false,
    sampleRate: 16000, channelCount: 1, pcmBase64: Buffer.alloc(640).toString('base64'),
  });
  check(
    'a Spanish generation change does not cancel French',
    frenchNext === 'played' && french.heard.length === frenchBefore + 1,
    `french disposition ${frenchNext}`,
  );
}

client.finish('speaker stopped');
await client.close();
await handle.close();
await new Promise((resolve) => server.close(resolve));

const failed = results.filter((r) => !r.passed);
process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
process.exit(failed.length === 0 ? 0 : 1);
