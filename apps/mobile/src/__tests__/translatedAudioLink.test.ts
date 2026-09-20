/** @author masterzee001 */
/**
 * The whole mobile translated-audio path, from socket event to platform bytes.
 *
 * WHY THIS TEST IS END TO END RATHER THAN A SET OF UNIT TESTS. The defect it
 * exists to prevent was never a wrong rule -- every rule was already correct
 * and already tested in @videofy-live/call-client-core. The defect was that the
 * phone never subscribed to `call:translated-audio-frame` at all, and no test
 * anywhere could have noticed, because nothing tested the join between the
 * socket and an output. So these drive the real controller with a real socket
 * shape and assert on the SAMPLES a platform would have been handed.
 *
 * Nothing below asserts that a particular function was called, or that the
 * wiring has a particular shape. Every expectation is audio: which samples
 * reached the output, in what order, and when none should have.
 */
import { describe, expect, it } from 'vitest';
import type { CallParticipantSummary, CallStateSnapshot } from '@videofy-live/call-client-core';
import {
  createMobileTranslatedAudio,
  remoteOriginalsSuppressed,
  translatedSpeechAudible,
  type MobileTranslatedAudioDeps,
} from '../call/translatedAudioLink';
import type { TranslatedPcmBackend } from '../native/translatedPcm';

const CALL_ID = 'call-abc';
const ME = 'participant_me';
const SPEAKER = 'participant_them';
const FRAME_EVENT = 'call:translated-audio-frame';

/** The wire payload, built WITHOUT the code under test. */
function wireBase64(samples: readonly number[]): string {
  const bytes = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => bytes.writeInt16LE(sample, index * 2));
  return bytes.toString('base64');
}

function participant(
  participantId: string,
  overrides: Partial<CallParticipantSummary> = {},
): CallParticipantSummary {
  return {
    participantId,
    displayName: participantId,
    speakLanguage: 'en',
    hearLanguage: 'fr',
    joined: true,
    ...overrides,
  };
}

/** A translated two-party call: I hear French, they speak English. */
function translatedCall(): CallStateSnapshot {
  return {
    callId: CALL_ID,
    callMode: 'translated',
    participants: [
      participant(ME, { speakLanguage: 'fr', hearLanguage: 'fr' }),
      participant(SPEAKER, { speakLanguage: 'en', hearLanguage: 'en' }),
    ],
  };
}

interface Frame {
  readonly samples: readonly number[];
  readonly sequence?: number;
  readonly segmentId?: string;
  readonly generation?: number;
  readonly final?: boolean;
  readonly callId?: string;
  readonly targetLanguage?: string;
  readonly speakerParticipantId?: string;
  readonly sampleRate?: number;
}

function payload(frame: Frame): Record<string, unknown> {
  return {
    callId: frame.callId ?? CALL_ID,
    speakerParticipantId: frame.speakerParticipantId ?? SPEAKER,
    targetLanguage: frame.targetLanguage ?? 'fr',
    mediaRevision: 1,
    languageRevision: 1,
    segmentId: frame.segmentId ?? 'segment-1',
    generation: frame.generation ?? 0,
    sequence: frame.sequence ?? 0,
    segmentStartMs: (frame.sequence ?? 0) * 20,
    final: frame.final ?? false,
    sampleRate: frame.sampleRate ?? 16000,
    channelCount: 1,
    pcmBase64: wireBase64(frame.samples),
  };
}

/** A socket with the two methods the subscription uses, and an emit for tests. */
function fakeSocket(): {
  on(event: string, handler: (value: unknown) => void): void;
  off(event: string, handler: (value: unknown) => void): void;
  emit(event: string, value: unknown): void;
  handlerCount(event: string): number;
} {
  const handlers = new Map<string, ((value: unknown) => void)[]>();
  return {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    off(event, handler) {
      handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler));
    },
    emit(event, value) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(value);
    },
    handlerCount(event) {
      return (handlers.get(event) ?? []).length;
    },
  };
}

function recordingBackend(): TranslatedPcmBackend & { samples(): number[]; flushes: number; closes: number } {
  const writes: string[] = [];
  const backend = {
    writes,
    flushes: 0,
    closes: 0,
    open: () => true,
    write(pcmBase64: string): number {
      writes.push(pcmBase64);
      return Buffer.from(pcmBase64, 'base64').length;
    },
    flush(): number {
      backend.flushes += 1;
      return 0;
    },
    queuedMs: () => 0,
    close(): void {
      backend.closes += 1;
    },
    samples(): number[] {
      const out: number[] = [];
      for (const write of writes) {
        const bytes = Buffer.from(write, 'base64');
        for (let index = 0; index + 1 < bytes.length; index += 2) out.push(bytes.readInt16LE(index));
      }
      return out;
    },
  };
  return backend;
}

function harness(state: CallStateSnapshot | null = translatedCall()) {
  const socket = fakeSocket();
  const backend = recordingBackend();
  let snapshot = state;
  let seat: string | null = ME;
  const refusals: string[] = [];
  const deps: MobileTranslatedAudioDeps = {
    socket,
    backend,
    callId: () => (seat === null ? null : CALL_ID),
    participantId: () => seat,
    callState: () => snapshot,
    callMode: () => snapshot?.callMode ?? null,
    hearLanguage: () => 'fr',
    onRefused: (reason) => refusals.push(reason),
  };
  const link = createMobileTranslatedAudio(deps);
  return {
    socket,
    backend,
    link,
    refusals,
    setState(next: CallStateSnapshot | null): void {
      snapshot = next;
    },
    leaveSeat(): void {
      seat = null;
    },
    send(frame: Frame): void {
      socket.emit(FRAME_EVENT, payload(frame));
    },
  };
}

describe('mobile translated audio, socket to output', () => {
  it('plays the translated speech the gateway sends', () => {
    // The 19 Sep 2026 defect in one assertion: the server emitted frames and
    // the phone produced no sound at all.
    const call = harness();
    call.link.attach();
    call.send({ samples: [10, 20, 30], sequence: 0 });
    call.send({ samples: [40, 50], sequence: 1 });
    call.send({ samples: [60], sequence: 2, final: true });
    expect(call.backend.samples()).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it('keeps consecutive frames contiguous and in order', () => {
    const call = harness();
    call.link.attach();
    // A sawtooth across four frames: any reordering, duplication or dropped
    // frame shows up as a discontinuity rather than as a count that happens to
    // match.
    const expected: number[] = [];
    for (let sequence = 0; sequence < 4; sequence += 1) {
      const samples = [sequence * 4, sequence * 4 + 1, sequence * 4 + 2, sequence * 4 + 3];
      expected.push(...samples);
      call.send({ samples, sequence });
    }
    expect(call.backend.samples()).toEqual(expected);
  });

  it('never plays a frame that arrived out of order, even later', () => {
    const call = harness();
    call.link.attach();
    call.send({ samples: [1, 1], sequence: 0 });
    // Sequence 2 jumps a gap. Queueing it would mean holding audio for a frame
    // that may never arrive, which costs more than the syllable it recovers.
    call.send({ samples: [3, 3], sequence: 2 });
    call.send({ samples: [2, 2], sequence: 1 });
    // And the late arrival of 2 must not now play it after 1 -- it was already
    // refused, and replaying it here would put the sentence out of order.
    call.send({ samples: [3, 3], sequence: 2 });
    expect(call.backend.samples()).toEqual([1, 1, 2, 2]);
  });

  it('does not play a sentence the platform withdrew', () => {
    const call = harness();
    call.link.attach();
    call.send({ samples: [7, 7], sequence: 0, generation: 1 });
    // An older generation of the same segment: the speaker corrected
    // themselves and this is the retracted attempt.
    call.send({ samples: [9, 9], sequence: 1, generation: 0 });
    expect(call.backend.samples()).toEqual([7, 7]);
  });

  it('plays a later generation and abandons what the earlier one had queued', () => {
    const call = harness();
    call.link.attach();
    call.send({ samples: [1, 1], sequence: 0, generation: 0 });
    const flushesBefore = call.backend.flushes;
    call.send({ samples: [2, 2], sequence: 0, generation: 1 });
    expect(call.backend.samples()).toEqual([1, 1, 2, 2]);
    // The unheard tail of the withdrawn attempt is dropped rather than left to
    // interleave with its replacement.
    expect(call.backend.flushes).toBeGreaterThan(flushesBefore);
  });

  it('plays nothing when the call is in normal mode', () => {
    const call = harness({ ...translatedCall(), callMode: 'normal' });
    call.link.attach();
    call.send({ samples: [1, 2, 3] });
    expect(call.backend.samples()).toEqual([]);
  });

  it('plays nothing in a language this listener did not ask for', () => {
    const call = harness();
    call.link.attach();
    // Routed on the language I had when the server sent it; I have changed it.
    call.send({ samples: [1, 2, 3], targetLanguage: 'es' });
    expect(call.backend.samples()).toEqual([]);
  });

  it('plays nothing for a speaker who has left', () => {
    const call = harness({
      ...translatedCall(),
      participants: [
        participant(ME, { speakLanguage: 'fr', hearLanguage: 'fr' }),
        participant(SPEAKER, { joined: false }),
      ],
    });
    call.link.attach();
    call.send({ samples: [1, 2, 3] });
    expect(call.backend.samples()).toEqual([]);
  });

  it('plays nothing for another call', () => {
    const call = harness();
    call.link.attach();
    call.send({ samples: [1, 2, 3], callId: 'call-somebody-else' });
    expect(call.backend.samples()).toEqual([]);
  });

  it('plays nothing once this phone has no seat', () => {
    const call = harness();
    call.link.attach();
    call.leaveSeat();
    call.send({ samples: [1, 2, 3] });
    expect(call.backend.samples()).toEqual([]);
  });

  it('refuses a frame in a format it cannot render rather than guessing', () => {
    const call = harness();
    call.link.attach();
    // Resampling silently would make wrong pitch look like a synthesis fault.
    call.send({ samples: [1, 2, 3], sampleRate: 24000 });
    expect(call.backend.samples()).toEqual([]);
  });

  it('stops applying a mode change mid-sentence without unbinding', () => {
    const call = harness();
    call.link.attach();
    call.send({ samples: [1, 1], sequence: 0 });
    call.link.reset('call mode is not translated');
    expect(call.backend.flushes).toBeGreaterThan(0);
    // The subscription survives: the next sentence still arrives.
    call.send({ samples: [2, 2], sequence: 0, segmentId: 'segment-2' });
    expect(call.backend.samples()).toEqual([1, 1, 2, 2]);
  });

  it('plays each frame once when a reconnect re-attaches', () => {
    // A handler leaked across a reconnect is invisible in review and
    // unmistakable in somebody's ears.
    const call = harness();
    call.link.attach();
    call.link.attach();
    expect(call.socket.handlerCount(FRAME_EVENT)).toBe(1);
    call.send({ samples: [5, 6] });
    expect(call.backend.samples()).toEqual([5, 6]);
  });

  it('goes quiet and releases the output when the call ends', () => {
    const call = harness();
    call.link.attach();
    call.send({ samples: [1, 2], sequence: 0 });
    call.link.detach();
    expect(call.backend.closes).toBe(1);
    call.send({ samples: [3, 4], sequence: 1 });
    expect(call.backend.samples()).toEqual([1, 2]);
    expect(call.socket.handlerCount(FRAME_EVENT)).toBe(0);
  });

  it('follows a language change on the next frame, not at the end of the sentence', () => {
    const call = harness();
    call.link.attach();
    call.send({ samples: [1, 1], sequence: 0 });
    call.setState({
      ...translatedCall(),
      participants: [
        participant(ME, { speakLanguage: 'fr', hearLanguage: 'es' }),
        participant(SPEAKER, { speakLanguage: 'en', hearLanguage: 'en' }),
      ],
    });
    call.send({ samples: [2, 2], sequence: 1 });
    expect(call.backend.samples()).toEqual([1, 1]);
  });
});

describe('translatedSpeechAudible', () => {
  const base = {
    participants: translatedCall().participants ?? [],
    selfParticipantId: ME,
    hearLanguage: 'fr',
  };

  it('plays when the call is translated and somebody needs translating', () => {
    expect(translatedSpeechAudible({ ...base, callMode: 'translated' })).toBe(true);
  });

  it('is silent when the call mode is normal', () => {
    expect(translatedSpeechAudible({ ...base, callMode: 'normal' })).toBe(false);
  });

  it('plays when the mode is not known yet', () => {
    // Fails OPEN on missing state. The server is the eligibility authority and
    // had already decided before it sent the frame; refusing here is exactly
    // the 19 Sep defect, with the refusal counted somewhere nobody reads.
    expect(translatedSpeechAudible({ ...base, callMode: null })).toBe(true);
  });

  it('is silent when every remote speaks the language I am listening in', () => {
    expect(
      translatedSpeechAudible({
        participants: [
          participant(ME, { speakLanguage: 'fr', hearLanguage: 'fr' }),
          participant(SPEAKER, { speakLanguage: 'fr', hearLanguage: 'fr' }),
        ],
        selfParticipantId: ME,
        hearLanguage: 'fr',
        callMode: 'translated',
      }),
    ).toBe(false);
  });
});

describe('remoteOriginalsSuppressed', () => {
  it('silences a cross-language original in a translated call', () => {
    expect(
      remoteOriginalsSuppressed({
        participants: translatedCall().participants ?? [],
        selfParticipantId: ME,
        hearLanguage: 'fr',
        callMode: 'translated',
      }),
    ).toBe(true);
  });

  it('leaves originals alone before the mode is known', () => {
    // Fails CLOSED in the opposite direction from audibility: silencing a real
    // voice on missing data loses a person, and the listener cannot undo it.
    expect(
      remoteOriginalsSuppressed({
        participants: translatedCall().participants ?? [],
        selfParticipantId: ME,
        hearLanguage: 'fr',
        callMode: null,
      }),
    ).toBe(false);
  });

  it('leaves originals alone in a normal call', () => {
    expect(
      remoteOriginalsSuppressed({
        participants: translatedCall().participants ?? [],
        selfParticipantId: ME,
        hearLanguage: 'fr',
        callMode: 'normal',
      }),
    ).toBe(false);
  });

  it('leaves a same-language speaker audible: their original IS the delivery', () => {
    expect(
      remoteOriginalsSuppressed({
        participants: [
          participant(ME, { speakLanguage: 'fr', hearLanguage: 'fr' }),
          participant(SPEAKER, { speakLanguage: 'fr', hearLanguage: 'fr' }),
        ],
        selfParticipantId: ME,
        hearLanguage: 'fr',
        callMode: 'translated',
      }),
    ).toBe(false);
  });

  it('keeps a mixed room audible rather than silencing the wrong person', () => {
    // This app cannot yet attribute a remote audio track to a speaker, so with
    // one speaker to suppress and one to keep it keeps both. Untidy, and
    // recoverable by the listener; the alternative is not.
    expect(
      remoteOriginalsSuppressed({
        participants: [
          participant(ME, { speakLanguage: 'fr', hearLanguage: 'fr' }),
          participant('participant_en', { speakLanguage: 'en', hearLanguage: 'en' }),
          participant('participant_fr', { speakLanguage: 'fr', hearLanguage: 'fr' }),
        ],
        selfParticipantId: ME,
        hearLanguage: 'fr',
        callMode: 'translated',
      }),
    ).toBe(false);
  });

  it('ignores a seat that exists but has not been taken', () => {
    expect(
      remoteOriginalsSuppressed({
        participants: [
          participant(ME, { speakLanguage: 'fr', hearLanguage: 'fr' }),
          participant(SPEAKER, { speakLanguage: 'en', hearLanguage: 'en' }),
          participant('participant_invited', { speakLanguage: 'fr', joined: false }),
        ],
        selfParticipantId: ME,
        hearLanguage: 'fr',
        callMode: 'translated',
      }),
    ).toBe(true);
  });

  it('silences nobody when nobody else has joined', () => {
    expect(
      remoteOriginalsSuppressed({
        participants: [participant(ME, { speakLanguage: 'fr', hearLanguage: 'fr' })],
        selfParticipantId: ME,
        hearLanguage: 'fr',
        callMode: 'translated',
      }),
    ).toBe(false);
  });
});
