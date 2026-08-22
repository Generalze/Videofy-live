/**
 * C-AI1.1F pins: what a listener actually hears, and when.
 *
 * Driven through the real player with a recording sink, so these prove the
 * client engine rather than stopping at a gateway event. No browser, no
 * AudioContext, no speaker -- every property here is about our decisions.
 */
import { describe, expect, it } from 'vitest';
import {
  ProgressiveTranslatedAudioPlayer,
  TRANSLATED_AUDIO_SAMPLE_RATE,
  decodePcm16Base64,
  type ProgressiveTranslatedAudioFrame,
  type TranslatedAudioSink,
  type TranslatedFrameDisposition,
} from './progressiveTranslatedAudio';
import { resolveSpeakerAudioMix } from './callAudioMix';

const FRAME_SAMPLES = 320; // 20 ms

function pcm(value: number, samples = FRAME_SAMPLES): string {
  const bytes = new Uint8Array(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    bytes[i * 2] = value & 0xff;
    bytes[i * 2 + 1] = (value >> 8) & 0xff;
  }
  return Buffer.from(bytes).toString('base64');
}

function frame(
  overrides: Partial<ProgressiveTranslatedAudioFrame> = {},
): ProgressiveTranslatedAudioFrame {
  return {
    sessionId: 'call_1',
    targetLanguage: 'es',
    segmentId: 'seg_1',
    generation: 1,
    sequence: 0,
    segmentStartMs: 1000,
    final: false,
    sampleRate: TRANSLATED_AUDIO_SAMPLE_RATE,
    channelCount: 1,
    pcmBase64: pcm(1000),
    ...overrides,
  };
}

function recordingSink() {
  const played: { samples: Int16Array; gain: number }[] = [];
  let flushes = 0;
  let unheardMs = 0;
  const sink: TranslatedAudioSink = {
    play: (samples, gain) => {
      played.push({ samples, gain });
      unheardMs += (samples.length / TRANSLATED_AUDIO_SAMPLE_RATE) * 1000;
    },
    flush: () => {
      flushes += 1;
      const discarded = unheardMs;
      unheardMs = 0;
      return discarded;
    },
    get playedMs() {
      return played.reduce(
        (total, item) => total + (item.samples.length / TRANSLATED_AUDIO_SAMPLE_RATE) * 1000,
        0,
      );
    },
  };
  // A function, not a getter: spreading this object into a rig would freeze a
  // getter at its value on the day of the spread, and the test would then be
  // asserting a constant.
  return { sink, played, flushCount: () => flushes };
}

function rig(options: { audible?: boolean; volume?: number } = {}) {
  const recorder = recordingSink();
  const dispositions: TranslatedFrameDisposition[] = [];
  const player = new ProgressiveTranslatedAudioPlayer({
    sink: recorder.sink,
    isAudible: () => options.audible ?? true,
    volume: () => options.volume ?? 1,
    onDisposition: (disposition) => dispositions.push(disposition),
  });
  return { player, dispositions, sink: recorder.sink, played: recorder.played, flushCount: recorder.flushCount };
}

describe('a listener hears the sentence as it is made', () => {
  it('PIN: the first frame plays without waiting for the last', () => {
    const r = rig();
    // Three frames of one utterance, the last not yet synthesised.
    expect(r.player.accept(frame({ sequence: 0 }))).toBe('played');
    expect(r.played).toHaveLength(1);

    expect(r.player.accept(frame({ sequence: 1 }))).toBe('played');
    expect(r.player.accept(frame({ sequence: 2, final: true }))).toBe('played');
    expect(r.player.state.framesPlayed).toBe(3);
    // 60 ms audible for 60 ms produced: nothing waited for a complete file.
    expect(r.player.state.playedMs).toBe(60);
  });

  it('PIN: PCM16 is decoded little-endian, including the loudest negative sample', () => {
    const bytes = new Uint8Array([0x00, 0x80, 0xff, 0x7f, 0x01, 0x00]);
    const decoded = decodePcm16Base64(Buffer.from(bytes).toString('base64'));
    // -32768, 32767, 1. Big-endian would give 128, -256, 256 -- audible as
    // noise rather than speech, and blamed on synthesis.
    expect(Array.from(decoded)).toEqual([-32768, 32767, 1]);
  });

  it('PIN: half a sample is refused rather than played as noise', () => {
    const r = rig();
    const odd = Buffer.from(new Uint8Array([0x01, 0x02, 0x03])).toString('base64');
    expect(r.player.accept(frame({ pcmBase64: odd }))).toBe('dropped-malformed');
    expect(r.played).toHaveLength(0);
  });

  it('PIN: a frame in the wrong format is refused, not resampled', () => {
    const r = rig();
    expect(r.player.accept(frame({ sampleRate: 48000 }))).toBe('dropped-malformed');
    expect(r.player.accept(frame({ channelCount: 2 }))).toBe('dropped-malformed');
    // Guessing would make the wrong pitch sound like a synthesis bug, a long
    // way from where the problem actually is.
    expect(r.played).toHaveLength(0);
  });
});

describe('order and supersession are obeyed, never re-derived', () => {
  it('PIN: a frame that would jump a gap is dropped, not played early', () => {
    const r = rig();
    r.player.accept(frame({ sequence: 0 }));
    expect(r.player.accept(frame({ sequence: 2 }))).toBe('dropped-out-of-order');
    expect(r.played).toHaveLength(1);
  });

  it('PIN: a duplicate frame is never played twice', () => {
    const r = rig();
    r.player.accept(frame({ sequence: 0 }));
    expect(r.player.accept(frame({ sequence: 0 }))).toBe('dropped-duplicate');
    expect(r.played).toHaveLength(1);
  });

  it('PIN: a newer generation abandons what the old one had not yet said', () => {
    const r = rig();
    r.player.accept(frame({ generation: 1, sequence: 0 }));
    r.player.accept(frame({ generation: 1, sequence: 1 }));
    const before = r.flushCount();

    expect(r.player.accept(frame({ generation: 2, sequence: 0 }))).toBe('played');
    // "Tuesday" must not be finished after "Wednesday" started.
    expect(r.flushCount()).toBe(before + 1);
    expect(r.player.state.activeGeneration).toBe(2);
  });

  it('PIN: a late frame from a superseded generation is dropped', () => {
    const r = rig();
    r.player.accept(frame({ generation: 2, sequence: 0 }));
    expect(r.player.accept(frame({ generation: 1, sequence: 1 }))).toBe('dropped-superseded');
  });

  it('PIN: two LANGUAGES of one segment are separate streams', () => {
    const r = rig();
    // Same segmentId, same sequence, different language. Keyed on the segment
    // alone, the second would look like a duplicate of the first and a
    // listener would hear one language and silence in the other.
    expect(r.player.accept(frame({ targetLanguage: 'es', sequence: 0 }))).toBe('played');
    expect(r.player.accept(frame({ targetLanguage: 'fr', sequence: 0 }))).toBe('played');
    expect(r.player.accept(frame({ targetLanguage: 'es', sequence: 1 }))).toBe('played');
    expect(r.player.accept(frame({ targetLanguage: 'fr', sequence: 1 }))).toBe('played');
    expect(r.played).toHaveLength(4);
  });

  it('PIN: a generation change in one language leaves the other alone', () => {
    const r = rig();
    r.player.accept(frame({ targetLanguage: 'es', generation: 1, sequence: 0 }));
    r.player.accept(frame({ targetLanguage: 'fr', generation: 1, sequence: 0 }));
    // Spanish is retried. French is a different rendering of the same
    // sentence and must be untouched.
    expect(r.player.accept(frame({ targetLanguage: 'es', generation: 2, sequence: 0 }))).toBe('played');
    expect(r.player.accept(frame({ targetLanguage: 'fr', generation: 1, sequence: 1 }))).toBe('played');
  });

  it('PIN: two segments keep their own order', () => {
    const r = rig();
    r.player.accept(frame({ segmentId: 'seg_a', sequence: 0 }));
    r.player.accept(frame({ segmentId: 'seg_b', sequence: 0 }));
    expect(r.player.accept(frame({ segmentId: 'seg_a', sequence: 1 }))).toBe('played');
    expect(r.played).toHaveLength(3);
  });
});

describe('cancellation stops what nobody has heard, and says only that', () => {
  it('PIN: cancelling discards the unheard remainder', () => {
    const r = rig();
    r.player.accept(frame({ sequence: 0 }));
    r.player.accept(frame({ sequence: 1 }));
    const discarded = r.player.cancel('seg_1');
    expect(discarded).toBe(40);
    expect(r.player.state.activeSegmentId).toBeNull();
  });

  it('PIN: frames arriving after a cancel are refused', () => {
    const r = rig();
    r.player.accept(frame({ sequence: 0 }));
    r.player.cancel('seg_1');
    expect(r.player.accept(frame({ sequence: 1 }))).toBe('dropped-cancelled');
  });

  it('cancelling a segment that is not playing discards nothing', () => {
    const r = rig();
    r.player.accept(frame({ segmentId: 'seg_1', sequence: 0 }));
    expect(r.player.cancel('seg_other')).toBe(0);
  });

  it('cancelAll stops everything, for a call that ended', () => {
    const r = rig();
    r.player.accept(frame({ segmentId: 'seg_a' }));
    expect(r.player.cancelAll()).toBeGreaterThan(0);
    expect(r.player.accept(frame({ segmentId: 'seg_a', sequence: 1 }))).toBe('dropped-cancelled');
  });
});

describe('mute, volume and the interpretation modes', () => {
  it('PIN: inaudible frames are DISCARDED, not queued for later', () => {
    const r = rig({ audible: false });
    expect(r.player.accept(frame({ sequence: 0 }))).toBe('dropped-inaudible');
    expect(r.played).toHaveLength(0);
    // Queueing would mean unmuting replays a sentence from the past, which is
    // worse than the silence the listener chose.
    expect(r.player.state.framesPlayed).toBe(0);
  });

  it('PIN: order still advances while inaudible, so unmuting resumes cleanly', () => {
    const audible = { value: false };
    const recorder = recordingSink();
    const player = new ProgressiveTranslatedAudioPlayer({
      sink: recorder.sink,
      isAudible: () => audible.value,
    });
    player.accept(frame({ sequence: 0 }));
    player.accept(frame({ sequence: 1 }));
    audible.value = true;
    // If muted frames had not advanced the sequence, this would look like a gap
    // and the listener would hear nothing after unmuting.
    expect(player.accept(frame({ sequence: 2 }))).toBe('played');
  });

  it('PIN: zero volume is silence, not quiet audio', () => {
    const r = rig({ volume: 0 });
    expect(r.player.accept(frame())).toBe('dropped-inaudible');
    expect(r.played).toHaveLength(0);
  });

  it('volume multiplies into the sink gain and is clamped', () => {
    const loud = rig({ volume: 5 });
    loud.player.accept(frame());
    expect(loud.played[0]?.gain).toBe(1);

    const half = rig({ volume: 0.5 });
    half.player.accept(frame());
    expect(half.played[0]?.gain).toBe(0.5);
  });

  it('PIN: the mode decides audibility, and this player obeys it', () => {
    // The locked W4 semantics, driven through the real resolver rather than
    // restated here -- a second copy of the rule is a second thing to drift.
    const cases = [
      { audioMode: 'translated' as const, translationRequired: true, audible: true },
      { audioMode: 'interpretation' as const, translationRequired: true, audible: true },
      { audioMode: 'original' as const, translationRequired: true, audible: false },
      { audioMode: 'translated' as const, translationRequired: false, audible: false },
    ];
    for (const testCase of cases) {
      const mix = resolveSpeakerAudioMix({
        audioMode: testCase.audioMode,
        translationRequired: testCase.translationRequired,
      });
      expect(mix.translatedAudible).toBe(testCase.audible);

      const recorder = recordingSink();
      const player = new ProgressiveTranslatedAudioPlayer({
        sink: recorder.sink,
        isAudible: () => mix.translatedAudible,
      });
      player.accept(frame());
      expect(recorder.played.length, `${testCase.audioMode}/${testCase.translationRequired}`).toBe(
        testCase.audible ? 1 : 0,
      );
    }
  });
});
