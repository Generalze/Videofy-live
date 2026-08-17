/** @owner masterzee001 */
/**
 * W4 — the ledger's job is to say when a loudspeaker was AUDIBLE, and to say
 * "I don't know" when it does not know.
 *
 * The failure this guards against is not a crash. It is a ledger that looks
 * complete because it quietly backfilled emit time for clips nobody confirmed
 * playing, and then every containment measurement built on it is confident and
 * wrong.
 */
import { describe, expect, it } from 'vitest';
import { CallPlaybackLedger, generatedClipId } from '../call-playback-ledger.js';

const CALL = 'call_demo';

function ledgerWithClock() {
  const clock = { at: 1_000_000 };
  const ledger = new CallPlaybackLedger({ nowMs: () => clock.at });
  return { ledger, clock };
}

describe('generated clips (Path A)', () => {
  it('records the interval a client actually reported, not the one that was emitted', () => {
    const { ledger, clock } = ledgerWithClock();
    ledger.registerGeneratedClip({
      callId: CALL,
      clipId: 'clip-1',
      recipientParticipantIds: ['participant_2'],
      durationMs: 2_000,
    });

    // The client starts it 900 ms late, and plays it for 2.4 s rather than 2.0.
    clock.at += 900;
    ledger.reportPlayback({
      callId: CALL,
      participantId: 'participant_2',
      stream: 'generated',
      clipId: 'clip-1',
      phase: 'start',
      clientAtMs: 55_000,
    });
    clock.at += 2_400;
    ledger.reportPlayback({
      callId: CALL,
      participantId: 'participant_2',
      stream: 'generated',
      clipId: 'clip-1',
      phase: 'end',
      clientAtMs: 57_400,
    });

    const [window] = ledger.audibleWindows(CALL, 'participant_2');
    expect(window).toMatchObject({ stream: 'generated', clipId: 'clip-1' });
    expect(window!.endAtMs! - window!.startAtMs).toBe(2_400);
    // Emit time would have started this 900 ms early and ended it 1.3 s early.
    expect(ledger.wasAudibleAt(CALL, 'participant_2', 1_000_500)).toBe(false);
    expect(ledger.wasAudibleAt(CALL, 'participant_2', 1_003_000)).toBe(true);
    expect(ledger.statsFor(CALL).startSkewSamples).toEqual([900]);
  });

  it('leaves an unreported clip visibly unreported', () => {
    // The whole point. A clip emitted and never confirmed is NOT evidence that
    // anything came out of a speaker, and substituting the emit time would turn
    // that absence into a measurement.
    const { ledger } = ledgerWithClock();
    ledger.registerGeneratedClip({
      callId: CALL,
      clipId: 'clip-silent',
      recipientParticipantIds: ['participant_2'],
      durationMs: 1_500,
    });

    expect(ledger.audibleWindows(CALL, 'participant_2')).toEqual([]);
    expect(ledger.wasAudibleAt(CALL, 'participant_2', 1_000_100)).toBe(false);
    expect(ledger.statsFor(CALL)).toMatchObject({
      registeredClipCount: 1,
      startedClipCount: 0,
      unreportedClipCount: 1,
    });
    expect(ledger.unreportedClips(CALL).map((interval) => interval.clipId)).toEqual(['clip-silent']);
  });

  it('registers one interval per recipient, because they play at different moments', () => {
    const { ledger, clock } = ledgerWithClock();
    ledger.registerGeneratedClip({
      callId: CALL,
      clipId: 'clip-2',
      recipientParticipantIds: ['participant_2', 'participant_3'],
      durationMs: 1_000,
    });

    clock.at += 200;
    ledger.reportPlayback({
      callId: CALL,
      participantId: 'participant_2',
      stream: 'generated',
      clipId: 'clip-2',
      phase: 'start',
      clientAtMs: null,
    });

    expect(ledger.audibleWindows(CALL, 'participant_2')).toHaveLength(1);
    expect(ledger.audibleWindows(CALL, 'participant_3')).toHaveLength(0);
    expect(ledger.statsFor(CALL).unreportedClipCount).toBe(1);
  });

  it('counts a report for a clip it never registered instead of inventing one', () => {
    const { ledger } = ledgerWithClock();
    ledger.reportPlayback({
      callId: CALL,
      participantId: 'participant_2',
      stream: 'generated',
      clipId: 'clip-nobody-sent',
      phase: 'start',
      clientAtMs: null,
    });

    // Still recorded as audible — it evidently played — but flagged, because a
    // clip id the gateway does not recognise means the two sides disagree.
    expect(ledger.wasAudibleAt(CALL, 'participant_2', 1_000_000)).toBe(true);
    expect(ledger.statsFor(CALL).unknownClipReportCount).toBe(1);
  });
});

describe('the raw remote fan-out (Path B)', () => {
  it('records an interval that has no clip, no duration and no emit time', () => {
    const { ledger, clock } = ledgerWithClock();
    ledger.reportPlayback({
      callId: CALL,
      participantId: 'participant_1',
      stream: 'remote-original',
      clipId: null,
      phase: 'start',
      clientAtMs: 10,
    });
    clock.at += 6_000;

    // Still open: the other person is still talking. Treating it as finished
    // would understate exactly the overlap this exists to measure.
    expect(ledger.wasAudibleAt(CALL, 'participant_1', 1_005_000)).toBe(true);
    const [window] = ledger.audibleWindows(CALL, 'participant_1');
    expect(window).toMatchObject({ stream: 'remote-original', clipId: null, endAtMs: null });

    ledger.reportPlayback({
      callId: CALL,
      participantId: 'participant_1',
      stream: 'remote-original',
      clipId: null,
      phase: 'end',
      clientAtMs: 6_010,
    });
    expect(ledger.wasAudibleAt(CALL, 'participant_1', 1_007_000)).toBe(false);
    expect(ledger.statsFor(CALL).remoteOriginalIntervalCount).toBe(1);
  });

  it('unions both paths in the room-level query', () => {
    // The query W8 would eventually need, and the one "measure both acoustic
    // paths" needs now: a clip and a live fan-out are the same loudspeaker.
    const { ledger, clock } = ledgerWithClock();
    ledger.registerGeneratedClip({
      callId: CALL,
      clipId: 'clip-3',
      recipientParticipantIds: ['participant_2'],
      durationMs: 1_000,
    });
    ledger.reportPlayback({
      callId: CALL,
      participantId: 'participant_2',
      stream: 'generated',
      clipId: 'clip-3',
      phase: 'start',
      clientAtMs: null,
    });
    ledger.reportPlayback({
      callId: CALL,
      participantId: 'participant_1',
      stream: 'remote-original',
      clipId: null,
      phase: 'start',
      clientAtMs: null,
    });
    clock.at += 500;

    expect(
      ledger
        .roomAudibleAt(CALL, clock.at)
        .map((window) => `${window.participantId}:${window.stream}`)
        .sort(),
    ).toEqual(['participant_1:remote-original', 'participant_2:generated']);

    // A participant's own loudspeaker can be excluded, because the question is
    // usually "was anything OTHER than my own output audible to my microphone".
    expect(ledger.roomAudibleAt(CALL, clock.at, 'participant_2')).toHaveLength(1);
  });
});

describe('clip identity', () => {
  it('is derived from the event fields, so both sides compute it independently', () => {
    // apps/call-web/src/callAudioQueue.ts derives the same string from the same
    // fields. A disagreement then shows up as an unknown-clip report rather
    // than as a ledger that is quietly always empty.
    expect(
      generatedClipId({
        speakerParticipantId: 'participant_1',
        targetLanguage: 'fr',
        mediaRevision: 2,
        languageRevision: 3,
        sequence: 7,
      }),
    ).toBe('participant_1:fr:2:3:7');
  });
});

describe('housekeeping', () => {
  it('forgets a call when it ends', () => {
    const { ledger } = ledgerWithClock();
    ledger.reportPlayback({
      callId: CALL,
      participantId: 'participant_1',
      stream: 'remote-original',
      clipId: null,
      phase: 'start',
      clientAtMs: null,
    });

    ledger.dropCall(CALL);
    expect(ledger.audibleWindows(CALL, 'participant_1')).toEqual([]);
    expect(ledger.statsFor(CALL).remoteOriginalIntervalCount).toBe(0);
  });
});
