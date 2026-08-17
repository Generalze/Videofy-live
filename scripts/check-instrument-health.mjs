// Videofy Live - is the INSTRUMENT sound? (P6.3 M1 corpus)
//
// This checks the measuring apparatus, not the measurement. It is the automated
// form of the M1 stop rule:
//
//   Instrumentation failure  ->  STOP the corpus and fix the instrument.
//   Lots of recapture, no recapture, high W5A correlation, surprising AEC
//   behaviour                ->  RESULTS. Not reasons to change code.
//
// So this script deliberately DOES NOT classify captions, count fabrications,
// decide whether a caption followed playback, or judge whether 'all' helped.
// W2 and W4 exist so that determination can be made later from actual timing
// rather than from human enthusiasm at the console, and a checker that offered a
// verdict here would be the first place that discipline broke.
//
// It reports counts and provenance, never caption text.
//
// Usage:
//   node scripts/check-instrument-health.mjs <call-log.jsonl>
//
// Exit 0  instrument sound (results may be anything at all)
// Exit 1  INSTRUMENT FAILURE - stop the corpus
// Exit 2  could not read the log
import { readFileSync } from 'node:fs';

const path = process.argv[2];
if (!path) {
  console.error('\nUsage: node scripts/check-instrument-health.mjs <call-log.jsonl>\n');
  process.exit(2);
}

let records;
try {
  records = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`line ${index + 1} is not valid JSON`);
      }
    });
} catch (error) {
  console.error(`\nCannot read ${path}: ${error.message}\n`);
  process.exit(2);
}

const of = (kind) => records.filter((record) => record.kind === kind);
const joins = of('join');
const captureSettings = of('capture-settings');
const inputFormats = of('input-format');
const playback = of('playback');
const generated = of('generated-audio');
const captions = of('caption');
const observations = of('acoustic-observation');
const [summary] = of('call-summary');

const participants = [...new Set(joins.map((record) => record.participantId))];
const results = [];
const notes = [];

/**
 * @param examined How many records this check actually looked at. Zero means
 * SKIP, never PASS: `[].every(...)` is true, and a check that examined nothing
 * reporting green is precisely how an absent instrument gets mistaken for a
 * healthy one.
 */
function check(id, description, ok, examined, detail = '') {
  results.push({
    id,
    description,
    detail,
    status: examined === 0 ? 'skip' : ok ? 'pass' : 'fail',
  });
}

// ---------------------------------------------------------------- I1 .. I8

check(
  'I1',
  'every joined participant reported capture settings',
  participants.every((id) => captureSettings.some((record) => record.participantId === id)),
  participants.length,
  `${captureSettings.length} record(s) for ${participants.length} participant(s)`,
);

check(
  'I2',
  'every capture-settings record carries the requested profile AND the granted values',
  captureSettings.every(
    (record) =>
      'requestedCaptureProfile' in record &&
      record.settings &&
      typeof record.settings === 'object' &&
      'echoCancellation' in record.settings,
  ),
  captureSettings.length,
  'asked-for and granted must travel together or the run cannot be attributed',
);

const speakers = participants.filter((id) =>
  captions.some((record) => record.speakerParticipantId === id),
);
check(
  'I3',
  'input sample rate stamped for every participant whose audio was processed',
  speakers.every((id) =>
    inputFormats.some(
      (record) => record.participantId === id && Number.isFinite(record.inputSampleRate),
    ),
  ),
  speakers.length,
  `${inputFormats.length} record(s) for ${speakers.length} speaking participant(s)`,
);

check(
  'I4',
  'the client reported playback at least once when clips were delivered',
  playback.some((record) => record.stream === 'generated'),
  generated.length,
  `${generated.length} clip(s) delivered, ${playback.filter((r) => r.stream === 'generated').length} playback record(s)`,
);

// I5 - impossible ordering. An 'end' must follow a 'start' for the same
// participant/stream/clip. Reported as an instrument failure because it means
// the transitions are not trustworthy, whatever the audio did.
const open = new Set();
const orphanEnds = [];
for (const record of playback) {
  const key = `${record.participantId}|${record.stream}|${record.clipId ?? '-'}`;
  if (record.phase === 'start') open.add(key);
  else if (open.has(key)) open.delete(key);
  else orphanEnds.push(key);
}
check(
  'I5',
  'no playback end arrived without a start',
  orphanEnds.length === 0,
  playback.length,
  `${orphanEnds.length} orphan end(s)`,
);

// I6 - the log is appended in order, so its own stamps must not go backwards.
let lastAt = -Infinity;
let outOfOrder = 0;
for (const record of records) {
  const at = Date.parse(record.at ?? '');
  if (Number.isFinite(at)) {
    if (at < lastAt) outOfOrder += 1;
    lastAt = Math.max(lastAt, at);
  }
}
check(
  'I6',
  'log wall clocks are non-decreasing',
  outOfOrder === 0,
  records.length,
  `${outOfOrder} out-of-order record(s)`,
);

// I7 - frames reached the transcription bridge at all. This is the only signal
// in the LOG that the observer did not block the media path; the guard itself is
// asserted by the unit tests, not here.
check(
  'I7',
  'audio reached the recogniser (frames were not blocked)',
  captions.length > 0,
  records.length,
  `${captions.length} caption record(s)`,
);

// I8 - the summary's own accounting must be self-consistent.
if (summary) {
  const registered = summary.playbackClipsRegistered ?? 0;
  const started = summary.playbackClipsStarted ?? 0;
  const unreported = summary.playbackClipsUnreported ?? 0;
  check(
    'I8',
    'playback accounting adds up',
    started + unreported <= registered + (summary.playbackUnknownClipReports ?? 0),
    1,
    `registered ${registered}, started ${started}, unreported ${unreported}`,
  );
} else {
  check('I8', 'playback accounting adds up', true, 0, 'no call-summary record');
  notes.push('No call-summary record: the call did not end cleanly, so summary checks were skipped.');
}

// -------------------------------------------------------------- provenance

console.log('\nVIDEOFY INSTRUMENT HEALTH — P6.3 M1\n');
console.log(`  log            ${path}`);
console.log(`  call           ${records[0]?.callId ?? 'unknown'}`);
console.log(`  participants   ${participants.length}\n`);

console.log('  CAPTURE PROVENANCE (paste into the run sheet)\n');
for (const record of captureSettings) {
  const granted = record.settings ?? {};
  console.log(`    participant        ${record.participantId}  (${record.reason})`);
  console.log(`    requested profile  ${record.requestedCaptureProfile ?? '(absent)'}`);
  console.log(`    granted AEC        ${JSON.stringify(granted.echoCancellation)}`);
  console.log(`    granted NS / AGC   ${JSON.stringify(granted.noiseSuppression)} / ${JSON.stringify(granted.autoGainControl)}`);
  console.log(`    channels / rate    ${JSON.stringify(granted.channelCount)} / ${JSON.stringify(granted.sampleRate)}`);
  console.log(`    device label       ${JSON.stringify(granted.deviceLabel)}`);
  console.log(`    AEC capabilities   ${JSON.stringify(granted.echoCancellationCapabilities)}`);
  // The distinction the run sheet turns on. Asking is not complying, and a run
  // where 'all' was requested and `true` was granted is its own observed state,
  // not an explicit-all AEC condition.
  if (record.requestedCaptureProfile === 'explicit-all' && granted.echoCancellation !== 'all') {
    console.log(`    >> NOT an explicit-all AEC condition: requested 'all', granted ${JSON.stringify(granted.echoCancellation)}`);
  }
  console.log('');
}
for (const record of inputFormats) {
  console.log(`    input format       ${record.participantId}  ${record.inputSampleRate} Hz, ${record.inputChannelCount} ch`);
}

console.log('\n  COUNTS (facts, not verdicts)\n');
const starts = (stream) =>
  playback.filter((record) => record.stream === stream && record.phase === 'start').length;
console.log(`    captions                    ${captions.length}`);
console.log(`    generated clips delivered   ${generated.length}`);
// Intervals STARTED, not records: a start and its end are one interval, and
// counting records would report every finished clip twice.
console.log(`    playback intervals: Path A  ${starts('generated')}`);
console.log(`    playback intervals: Path B  ${starts('remote-original')}`);
console.log(`    W5A observations            ${observations.length}`);
if (summary) {
  console.log(`    clips never confirmed       ${summary.playbackClipsUnreported ?? 0}`);
  console.log(`    playback start skew         median ${summary.playbackStartSkewMedianMs ?? 'n/a'} ms, p90 ${summary.playbackStartSkewP90Ms ?? 'n/a'} ms`);
  console.log(`    W5A frame cost              p50 ${summary.acousticFrameCostP50Ms ?? 'n/a'} ms, p99 ${summary.acousticFrameCostP99Ms ?? 'n/a'} ms`);
}

console.log('\n  INSTRUMENT CHECKS\n');
for (const result of results.sort((a, b) => a.id.localeCompare(b.id))) {
  const label = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' }[result.status];
  console.log(
    `    ${result.id}  ${label}  ${result.description}${result.detail ? ` — ${result.detail}` : ''}`,
  );
}
for (const note of notes) console.log(`\n    note: ${note}`);

const failures = results.filter((result) => result.status === 'fail');
if (failures.length > 0) {
  console.error('\n  INSTRUMENT FAILURE — STOP THE CORPUS AND FIX THE INSTRUMENT.\n');
  console.error('  Do NOT continue collecting: every later recording would inherit the fault,');
  console.error('  and a corpus is not repairable after the fact.\n');
  process.exit(1);
}

console.log('\n  INSTRUMENT SOUND — the recording is trustworthy.\n');
console.log('  This says NOTHING about whether recapture occurred, whether the profile');
console.log('  helped, or what the correlation means. Those are results, and they are');
console.log('  read from the log by the M1 analysis, not decided here.\n');
