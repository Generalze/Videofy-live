// Videofy Live - does the gateway REFUSE audio nobody spoke into?
//
// scripts/verify-silence-invention.mjs answers a different question. It posts
// already-built chunks to media-ingest, so it can only prove that downstream
// rejects silence once the gateway has already decided to send it. It cannot
// see the defect that actually put invented sentences on a call, because that
// defect was in the decision to build the chunk at all.
//
// This runs the REAL chunker, with the REAL configuration the gateway loads,
// fed PCM frames at the same 10 ms cadence RTCAudioSink delivers them. Nothing
// is reimplemented: the VAD settings come from loadConfig(), the thresholds
// come from the chunker module, and the energy measurement reuses the
// chunker's own exported RMS.
//
// Usage:
//   node scripts/verify-vad-source-silence.mjs
//
// Exits non-zero on any failure.
import { existsSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const GATEWAY = join(ROOT, 'services', 'realtime-gateway');

/**
 * The harness imports the COMPILED gateway, so a green result always describes
 * code that could actually run. A stale dist would let this pass against the
 * previous build while the defect sat uncompiled in src — the one failure mode
 * a verification command must not have.
 */
function requireFreshBuild(name) {
  const source = join(GATEWAY, 'src', `${name}.ts`);
  const built = join(GATEWAY, 'dist', `${name}.js`);
  if (!existsSync(built)) {
    console.error(`\nservices/realtime-gateway/dist/${name}.js is missing.`);
    console.error('Run: npm run build -w services/realtime-gateway\n');
    process.exit(2);
  }
  if (statSync(source).mtimeMs > statSync(built).mtimeMs) {
    console.error(`\nservices/realtime-gateway/dist/${name}.js is OLDER than its source.`);
    console.error('This harness would be verifying the previous build.');
    console.error('Run: npm run build -w services/realtime-gateway\n');
    process.exit(2);
  }
  return pathToFileURL(built).href;
}

const chunkerModule = requireFreshBuild('webrtc-transcription-chunker');
const configModule = requireFreshBuild('config');

const {
  WebRtcTranscriptionChunker,
  WEBRTC_TRANSCRIPTION_SAMPLE_RATE,
  VAD_MIN_VOICED_FRACTION,
  VAD_POST_ROLL_SAMPLES,
  inspectPcm16Samples,
} = await import(chunkerModule);
const { loadConfig } = await import(configModule);

const config = loadConfig();
// Exactly the object services/realtime-gateway/src/index.ts hands the Gateway.
const VAD = {
  enabled: true,
  mode: config.webRtcVadMode,
  speechThreshold: config.webRtcVadSpeechThreshold,
  endSilenceMs: config.webRtcVadEndSilenceMs,
  minSpeechMs: config.webRtcVadMinSpeechMs,
  maxSegmentMs: config.webRtcVadMaxSegmentMs,
};
const PARTIAL_INTERVAL_MS = config.webRtcPartialCaptionIntervalMs;
const RATE = WEBRTC_TRANSCRIPTION_SAMPLE_RATE;
const FRAME_MS = 10;
const FRAME = (RATE / 1000) * FRAME_MS;
// A build that does not export these does not implement the rules they name.
// Treated as a failed case below rather than a crash, so running this against
// an older gateway reports WHY it fails instead of a stack trace.
const POST_ROLL_MS =
  typeof VAD_POST_ROLL_SAMPLES === 'number' ? Math.round((VAD_POST_ROLL_SAMPLES / RATE) * 1000) : null;

/**
 * Deterministic noise. Real microphone audio is noise, not a constant, and a
 * constant-amplitude block sits so far above the gate that every frame counts
 * as speech — which is exactly why the original defect survived a green test
 * suite. Seeded so a failure is always reproducible.
 */
let noise = 0;
function nextNoise() {
  noise = (noise + 0x6d2b79f5) | 0;
  let value = noise;
  value = Math.imul(value ^ (value >>> 15), value | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
}

/** A 10 ms frame of noise at the given peak amplitude. */
function frame(amplitude) {
  const samples = new Int16Array(FRAME);
  for (let index = 0; index < FRAME; index += 1) {
    samples[index] = Math.round((nextNoise() * 2 - 1) * amplitude);
  }
  return samples;
}

// Uniform noise at peak A has RMS A/√3. Against the configured gate:
const gateAmplitude = VAD.speechThreshold * 32768 * Math.sqrt(3);
const ROOM_TONE = Math.round(gateAmplitude * 0.3); // clearly below: a quiet room
const VOICE = Math.round(gateAmplitude * 8); // clearly above: ordinary speech

class Session {
  constructor() {
    noise = 0x5eed; // identical waveform for every case, run after run
    this.chunker = new WebRtcTranscriptionChunker({
      sessionId: 'vad_source_harness',
      broadcastId: 'broadcast_harness',
      broadcasterPeerId: 'peer_harness',
      revision: 1,
      vad: VAD,
      partialIntervalMs: PARTIAL_INTERVAL_MS,
    });
    this.finals = [];
    this.partials = 0;
  }

  /** Push `ms` of audio at `amplitude`, one 10 ms frame at a time. */
  push(amplitude, ms) {
    for (let index = 0; index < Math.round(ms / FRAME_MS); index += 1) {
      this.collect(
        this.chunker.pushFrame({
          samples: frame(amplitude),
          sampleRate: RATE,
          channelCount: 1,
          bitsPerSample: 16,
        }),
      );
    }
    return this;
  }

  /** One 10 ms impulse: a keyboard tap, a chair creak, a door. */
  blip() {
    return this.push(VOICE, FRAME_MS);
  }

  flush() {
    this.collect(this.chunker.flush(true));
    return this;
  }

  collect(chunks) {
    for (const chunk of chunks) {
      if (chunk.partial) this.partials += 1;
      else this.finals.push(chunk);
    }
  }
}

/**
 * Trailing silence retained on an emitted chunk, in ms.
 *
 * Measured with the chunker's own exported RMS against the configured gate, so
 * "silence" here means precisely what the VAD means by it.
 */
function trailingSilenceMs(chunk) {
  let silentFrames = 0;
  for (let end = chunk.samples.length; end - FRAME >= 0; end -= FRAME) {
    const { rms } = inspectPcm16Samples(chunk.samples.subarray(end - FRAME, end));
    if (rms >= VAD.speechThreshold) break;
    silentFrames += 1;
  }
  return silentFrames * FRAME_MS;
}

// A blip every `SPARSE_GAP_MS` never reaches the end-silence window, so the
// segment cannot close on silence — the shape that produced the observed
// eight-second fabrications.
const SPARSE_GAP_MS = Math.round(VAD.endSilenceMs * 0.45);
// Enough taps to clear minSpeechMs on DURATION alone, which is all the pre-fix
// flush path checked. The fraction is what must refuse them.
const SPARSE_BLIPS = Math.ceil(VAD.minSpeechMs / FRAME_MS) + 1;
// "Non." measured at 290 ms of voiced audio (scripts/measure-voiced-duration.mjs).
const SHORT_ANSWER_MS = 290;

const CASES = [
  {
    name: 'digital silence',
    run: () => new Session().push(0, 10_000),
    expect: 0,
  },
  {
    name: 'room tone',
    run: () => new Session().push(ROOM_TONE, 10_000),
    expect: 0,
  },
  {
    name: 'single impulse',
    run: () => new Session().blip().push(ROOM_TONE, 3_000),
    expect: 0,
  },
  {
    name: 'two-blip regression',
    // THE original defect: the 500 ms between the blips used to be promoted
    // into the counter that decides whether anybody spoke.
    run: () => new Session().blip().push(ROOM_TONE, 500).blip().push(ROOM_TONE, 2_000),
    expect: 0,
  },
  {
    name: `sparse blips >${Math.round(VAD.maxSegmentMs / 1000)}s`,
    run: () => {
      const session = new Session();
      const rounds = Math.ceil(VAD.maxSegmentMs / SPARSE_GAP_MS) + 4;
      for (let round = 0; round < rounds; round += 1) session.blip().push(ROOM_TONE, SPARSE_GAP_MS);
      return session;
    },
    expect: 0,
  },
  {
    name: 'sparse blips + flush',
    // Voiced duration ABOVE the minimum, voiced fraction far below it, ended by
    // a hang-up rather than by silence. 2546caf: flush obeys the same rule.
    run: () => {
      const session = new Session();
      for (let round = 0; round < SPARSE_BLIPS; round += 1) {
        session.blip().push(ROOM_TONE, SPARSE_GAP_MS);
      }
      return session.flush();
    },
    expect: 0,
  },
  {
    name: 'short speech',
    run: () => new Session().push(VOICE, SHORT_ANSWER_MS).push(ROOM_TONE, VAD.endSilenceMs + 100),
    expect: 1,
  },
  {
    name: 'short speech + flush',
    // "Oui." and then the caller hangs up, before the end-silence would close it.
    run: () => new Session().push(VOICE, SHORT_ANSWER_MS).flush(),
    expect: 1,
  },
  {
    name: 'speech + trailing silence',
    run: () => new Session().push(VOICE, 2_000).push(ROOM_TONE, VAD.endSilenceMs + 300),
    expect: 1,
    // A chunk ending in room tone is an invitation to fill it.
    checkTail: true,
  },
];

console.log('\nVIDEOFY VAD SOURCE VERIFICATION\n');
console.log(
  `  gate ${VAD.speechThreshold}  minSpeech ${VAD.minSpeechMs}ms  ` +
    `voicedFraction ${VAD_MIN_VOICED_FRACTION ?? 'ABSENT'}  endSilence ${VAD.endSilenceMs}ms  ` +
    `maxSegment ${VAD.maxSegmentMs}ms  ${RATE}Hz`,
);
console.log(
  `  waveforms: room tone ~${(ROOM_TONE / Math.sqrt(3) / 32768).toFixed(4)} RMS, ` +
    `voice ~${(VOICE / Math.sqrt(3) / 32768).toFixed(3)} RMS (seeded)\n`,
);

let passed = 0;
const failures = [];

for (const testCase of CASES) {
  let session;
  let detail;
  let ok;
  try {
    session = testCase.run();
    ok = session.finals.length === testCase.expect;
    detail = `${session.finals.length} chunk${session.finals.length === 1 ? '' : 's'}`;
    if (ok && testCase.checkTail) {
      const tail = trailingSilenceMs(session.finals[0]);
      ok = POST_ROLL_MS !== null && tail <= POST_ROLL_MS;
      detail =
        POST_ROLL_MS === null
          ? `${tail}ms tail (build has no post-roll trim)`
          : `${tail}ms tail (<=${POST_ROLL_MS}ms)`;
    }
    if (!ok && !testCase.checkTail) detail += ` (expected ${testCase.expect})`;
  } catch (error) {
    ok = false;
    detail = `threw ${error?.code ?? ''} ${error?.message ?? error}`.trim();
  }
  if (ok) passed += 1;
  else failures.push(`${testCase.name}: ${detail}`);
  const counters = session?.chunker.snapshot();
  console.log(
    `  ${testCase.name.padEnd(34)}${ok ? 'PASS' : 'FAIL'}  ${detail.padEnd(24)}` +
      (counters ? `refused ${counters.vadInsufficientVoicedCount}, partials ${session.partials}` : ''),
  );
}

console.log(`\n  RESULT${' '.repeat(30)}${passed}/${CASES.length} ${failures.length ? 'FAIL' : 'PASS'}\n`);

if (failures.length > 0) {
  console.error('The gateway is building chunks out of audio nobody spoke into:');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    '\nThis is the defect that put invented sentences on a live call, spoken in\n' +
      "the caller's own cloned voice. Do not run human acceptance until it passes.\n",
  );
  process.exit(1);
}

console.log(
  '  Source-side only. This proves the gateway does not CREATE these chunks;\n' +
    '  it says nothing about a real microphone, which is quieter and noisier\n' +
    '  than any generated waveform. Human acceptance is still required.\n',
);
