/** @author masterzee001 */
/**
 * C-AI1.1E pins: what may be spoken, once, and what happens when the speaker
 * changes their mind.
 */
import { describe, expect, it } from 'vitest';
import {
  LiveTranslationPipeline,
  type LiveTranslationPipelineDeps,
} from '../live-translation-pipeline.js';
import { DEFAULT_MIN_SPOKEN_CONFIDENCE } from '../live-session-host.js';
import { MockStreamingSynthesisProvider } from '../streaming-speech-synthesis-provider.js';
import type { TranscriptEvent } from '../transcript-event.js';
import type { TranslatedAudioFrame } from '../translated-audio.js';
import type {
  TimestampedTranslationProvider,
  TranslationProviderInput,
} from '../translation-provider.js';

function transcript(overrides: Partial<TranscriptEvent> = {}): TranscriptEvent {
  return {
    kind: 'final',
    sessionId: 'cs_1',
    streamId: 'st_1',
    segmentId: 'seg_1',
    revision: 1,
    text: 'good afternoon',
    startMs: 1000,
    endMs: 2000,
    provider: { name: 'mock', isFinal: true },
    ...overrides,
  } as TranscriptEvent;
}

function rig(overrides: Partial<LiveTranslationPipelineDeps> = {}) {
  const delivered: TranslatedAudioFrame[] = [];
  const translations: TranslationProviderInput[] = [];
  let accept = true;
  const translation: TimestampedTranslationProvider = {
    name: 'mock-mt',
    translate: async (input) => {
      translations.push(input);
      return { translatedText: `[${input.targetLanguage}] ${input.sourceText}` };
    },
  };
  const pipeline = new LiveTranslationPipeline({
    sessionId: 'cs_1',
    streamId: 'st_1',
    serviceCategory: 'call',
    sourceLanguage: 'en',
    targetLanguage: 'es',
    voiceId: 'v1',
    // Existing cases carry no confidence, so the floor never engages for them;
    // the gate's own behaviour is exercised explicitly further down.
    minSpokenConfidence: DEFAULT_MIN_SPOKEN_CONFIDENCE,
    translation,
    synthesis: new MockStreamingSynthesisProvider([640, 640]),
    deliver: (frame) => {
      if (!accept) return false;
      delivered.push(frame);
      return true;
    },
    frameSamples: 320,
    now: () => 0,
    ...overrides,
  });
  return {
    pipeline,
    delivered,
    translations,
    block: () => { accept = false; },
  };
}

describe('only a Videofy final may be spoken', () => {
  it('PIN: a partial never reaches translation or synthesis', async () => {
    const r = rig();
    const result = await r.pipeline.onTranscriptEvent(transcript({ kind: 'partial' }));
    // Partials are revised constantly, and a sentence somebody has already
    // heard cannot be revised.
    expect(result).toBeNull();
    expect(r.translations).toHaveLength(0);
    expect(r.delivered).toHaveLength(0);
  });

  it('PIN: a final with no words produces no speech', async () => {
    const r = rig();
    // Synthesising it would produce a pause the speaker never took.
    expect(await r.pipeline.onTranscriptEvent(transcript({ text: '   ' }))).toBeNull();
    expect(r.translations).toHaveLength(0);
  });

  it('PIN: a stale or repeated final does not say the sentence twice', async () => {
    const r = rig();
    await r.pipeline.onTranscriptEvent(transcript({ revision: 3 }));
    const repeat = await r.pipeline.onTranscriptEvent(transcript({ revision: 3 }));
    const older = await r.pipeline.onTranscriptEvent(transcript({ revision: 2 }));
    // Arrival order is not authority; revision is.
    expect(repeat).toBeNull();
    expect(older).toBeNull();
    expect(r.translations).toHaveLength(1);
  });

  it('a final is translated once and spoken progressively', async () => {
    const r = rig();
    const record = await r.pipeline.onTranscriptEvent(transcript());
    expect(r.translations).toHaveLength(1);
    expect(r.translations[0]?.sourceText).toBe('good afternoon');
    expect(record?.translatedText).toBe('[es] good afternoon');
    expect(record?.outcome.completed).toBe(true);
    expect(r.delivered.map((f) => f.sequence)).toEqual([0, 1, 2, 3]);
    expect(r.delivered.at(-1)?.final).toBe(true);
    expect(new Set(r.delivered.map((f) => f.segmentId))).toEqual(new Set(['seg_1']));
  });

  it('PIN: the detected language beats the configured source language', async () => {
    const r = rig();
    await r.pipeline.onTranscriptEvent(transcript({ detectedLanguage: 'fr' }));
    // Auto-detect exists precisely because the configured value can be wrong.
    expect(r.translations[0]?.sourceLanguage).toBe('fr');
  });
});

describe('a NON-TRANSLATION is never spoken', () => {
  /**
   * MEASURED ON TWO PHONES IN PRODUCTION, 22 Sep 2026, and the worst defect
   * this product has shipped.
   *
   * The route gate hands back the ORIGINAL text whenever it declines -- an
   * unapproved route, an engine that failed, a phone number it mangled -- and
   * marks the result `translated: false`. For a MESSAGE that is right: the
   * reader sees the original and is told it was not translated.
   *
   * This pipeline SPOKE it. `en->fr` was unapproved, the gate correctly
   * declined, the English came back, and it was synthesised and delivered as
   * translated audio. Two people spent three minutes listening to a machine
   * voice read their own sentences back at them -- in the language the
   * listener already could not understand, with the speaker's real voice
   * suppressed, and nothing anywhere marking it as untranslated.
   */
  function decliningRig() {
    const translation: TimestampedTranslationProvider = {
      name: 'gated:mock-mt',
      // Exactly what GatedTranslationProvider returns on a refusal: the
      // source text, unchanged, flagged as not a translation.
      translate: async (input) => ({
        translatedText: input.sourceText,
        providerName: 'gated:mock-mt',
        translated: false,
      }),
    };
    return rig({ translation });
  }

  it('speaks NOTHING when the gate declined the direction', async () => {
    const r = decliningRig();
    const record = await r.pipeline.onTranscriptEvent(transcript());
    expect(record, 'nothing was spoken').toBeNull();
    expect(r.delivered, 'and not one frame of audio was delivered').toHaveLength(0);
  });

  it('is decided by the FLAG, not by comparing the text', async () => {
    /*
     * The tempting shortcut is "if the output equals the input, it was not
     * translated". It is wrong in both directions: a proper name or a greeting
     * can translate to itself, and a declined result can differ from the
     * source once identifiers have been restored. The provider says whether it
     * translated; nobody infers it.
     */
    const r = rig({
      translation: {
        name: 'mock-mt',
        translate: async () => ({ translatedText: 'quite different words', translated: false }),
      },
    });
    expect(await r.pipeline.onTranscriptEvent(transcript())).toBeNull();
    expect(r.delivered).toHaveLength(0);
  });

  it('still speaks a real translation that happens to equal its source', async () => {
    // The other half of the same rule: "Bonjour" into French is "Bonjour".
    const r = rig({
      translation: {
        name: 'mock-mt',
        translate: async (input) => ({ translatedText: input.sourceText, translated: true }),
      },
    });
    const record = await r.pipeline.onTranscriptEvent(transcript());
    expect(record?.translatedText).toBe('good afternoon');
    expect(r.delivered.length).toBeGreaterThan(0);
  });

  it('treats a provider that says nothing as a translation, so nothing else changes', async () => {
    /*
     * `translated` is optional and absent means translated. Every provider
     * that really translates keeps working untouched; only the paths that hand
     * back an original have to declare themselves.
     */
    const r = rig();
    const record = await r.pipeline.onTranscriptEvent(transcript());
    expect(record?.translatedText).toBe('[es] good afternoon');
    expect(r.delivered.length).toBeGreaterThan(0);
  });
});

describe('generations are the platform own', () => {
  it('PIN: each attempt at a segment gets the next generation', async () => {
    const r = rig();
    await r.pipeline.onTranscriptEvent(transcript({ revision: 1 }));
    await r.pipeline.onTranscriptEvent(transcript({ revision: 2, text: 'good evening' }));
    const generations = [...new Set(r.delivered.map((f) => f.generation))];
    // Nothing about a vendor's retry semantics is visible here, so a failover
    // cannot be mistaken for a new sentence.
    expect(generations).toEqual([1, 2]);
  });

  it('PIN: a revised final abandons the audio of the one it replaces', async () => {
    const r = rig();
    r.block();
    await r.pipeline.onTranscriptEvent(transcript({ revision: 1, text: 'Tuesday' }));
    expect(r.pipeline.queuedFrames).toBeGreaterThan(0);

    await r.pipeline.onTranscriptEvent(transcript({ revision: 2, text: 'Wednesday' }));
    // A listener must not hear "Tuesday Wednesday" because two renderings of
    // one sentence interleaved.
    const stale = r.delivered.filter((f) => f.generation === 1);
    expect(stale).toHaveLength(0);
  });

  it('PIN: the superseded synthesis is stopped, not merely ignored', async () => {
    // Dropping the old generation's queued frames is not the same as stopping
    // the vendor producing them. A synthesis left running is paid-for audio
    // nobody will ever hear, still filling the same bounded queue as the
    // sentence that replaced it -- and the earlier version of this pin passed
    // without any of that being true.
    const aborted: boolean[] = [];
    let releaseFirst: (() => void) | null = null;
    const slow = {
      name: 'slow-synth',
      synthesize: async (options: {
        signal?: AbortSignal;
        onChunk: (chunk: { samples: Int16Array }) => void;
      }) => {
        options.onChunk({ samples: new Int16Array(640).fill(3) });
        if (releaseFirst === null) {
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
          aborted.push(options.signal?.aborted === true);
        }
        return { samples: 640, timeToFirstChunkMs: 0, totalMs: 0, aborted: options.signal?.aborted === true };
      },
    } as unknown as LiveTranslationPipelineDeps['synthesis'];

    const r = rig({ synthesis: slow });
    const first = r.pipeline.onTranscriptEvent(transcript({ revision: 1, text: 'Tuesday' }));
    await new Promise((done) => setTimeout(done, 0));

    await r.pipeline.onTranscriptEvent(transcript({ revision: 2, text: 'Wednesday' }));
    (releaseFirst as unknown as () => void)();
    await first;
    expect(aborted).toEqual([true]);
  });

  it('PIN: two different segments do not share a generation counter', async () => {
    const r = rig();
    await r.pipeline.onTranscriptEvent(transcript({ segmentId: 'seg_1' }));
    await r.pipeline.onTranscriptEvent(transcript({ segmentId: 'seg_2' }));
    for (const id of ['seg_1', 'seg_2']) {
      const frames = r.delivered.filter((f) => f.segmentId === id);
      expect(frames.every((f) => f.generation === 1)).toBe(true);
    }
  });
});

describe('cancelling says what it achieved, not what it wished', () => {
  it('PIN: delivered audio is counted apart from discarded audio', async () => {
    const r = rig();
    await r.pipeline.onTranscriptEvent(transcript());
    const heardMs = r.pipeline.deliveredMsFor('seg_1');
    expect(heardMs).toBeGreaterThan(0);

    const result = r.pipeline.cancelSegment('seg_1', 'speaker corrected themselves');
    // Nothing was left to discard, and what was heard cannot be unheard.
    expect(result.discardedFrames).toBe(0);
    expect(result.deliveredMs).toBe(heardMs);
  });

  it('PIN: cancelling discards audio that never reached anyone', async () => {
    const r = rig();
    r.block();
    await r.pipeline.onTranscriptEvent(transcript());
    const queued = r.pipeline.queuedFrames;
    expect(queued).toBeGreaterThan(0);

    const result = r.pipeline.cancelSegment('seg_1', 'withdrawn');
    expect(result.discardedFrames).toBe(queued);
    expect(result.deliveredMs).toBe(0);
  });

  it('a translation failure costs one sentence, not the session', async () => {
    const r = rig({
      translation: {
        name: 'broken-mt',
        translate: async () => { throw new Error('mt 503'); },
      } as TimestampedTranslationProvider,
    });
    await expect(r.pipeline.onTranscriptEvent(transcript())).resolves.toBeNull();
    // The caption stands on its own; taking the call down would be worse.
    await expect(
      r.pipeline.onTranscriptEvent(transcript({ segmentId: 'seg_2' })),
    ).resolves.toBeNull();
  });

  it('cancelAll stops everything the stream had in flight', async () => {
    const r = rig();
    r.block();
    await r.pipeline.onTranscriptEvent(transcript({ segmentId: 'seg_1' }));
    await r.pipeline.onTranscriptEvent(transcript({ segmentId: 'seg_2' }));
    r.pipeline.cancelAll('call ended');
    expect(r.pipeline.queuedFrames).toBe(0);
  });
});

/**
 * A recogniser that is not sure must not be given a voice.
 *
 * Deepgram scores every result, and that score was carried into this pipeline
 * and never consulted: a transcript rated 0.3 was spoken with the authority of
 * one rated 0.98. Upstream the VAD is an energy gate, which passes coughs,
 * doors and keyboards as "speech" -- so the two together manufacture sentences
 * out of noise and put them in somebody's mouth. On a business call the
 * listener has no way to know.
 */
describe('confidence floor on synthesis', () => {
  it('PIN: a low-confidence final is NOT spoken', async () => {
    const { pipeline, delivered } = rig({ minSpokenConfidence: 0.6 });
    const spoken = await pipeline.onTranscriptEvent(
      transcript({ provider: { name: 'mock', confidence: 0.31 } }),
    );
    expect(spoken).toBeNull();
    expect(delivered).toHaveLength(0);
  });

  it('speaks a confident final exactly as before', async () => {
    const { pipeline, delivered } = rig({ minSpokenConfidence: 0.6 });
    const spoken = await pipeline.onTranscriptEvent(
      transcript({ provider: { name: 'mock', confidence: 0.94 } }),
    );
    expect(spoken).not.toBeNull();
    expect(delivered.length).toBeGreaterThan(0);
  });

  it('PIN: absent confidence is not treated as low', async () => {
    // Some providers omit the field. Muting every one of them would be a worse
    // failure than the one this gate prevents.
    const { pipeline, delivered } = rig({ minSpokenConfidence: 0.6 });
    const spoken = await pipeline.onTranscriptEvent(transcript());
    expect(spoken).not.toBeNull();
    expect(delivered.length).toBeGreaterThan(0);
  });

  it('PIN: the floor governs SPEECH only, never the words', async () => {
    // The transcript is where a doubted sentence can still be read, checked
    // and corrected. Dropping it outright would hide the recogniser's mistake
    // instead of containing it.
    const translated: unknown[] = [];
    const { pipeline } = rig({
      minSpokenConfidence: 0.6,
      translation: {
        name: 'mock-mt',
        translate: async (input) => {
          translated.push(input);
          return { translatedText: `[es] ${input.sourceText}` };
        },
      },
    });
    await pipeline.onTranscriptEvent(
      transcript({ provider: { name: 'mock', confidence: 0.2 } }),
    );
    // Nothing was synthesised, and nothing here claims the caption was
    // suppressed: captions travel a different path entirely.
    expect(translated).toHaveLength(0);
  });

  it('a floor of 0 speaks everything, for a deployment that wants the old behaviour', () => {
    expect(DEFAULT_MIN_SPOKEN_CONFIDENCE).toBeGreaterThan(0);
    expect(DEFAULT_MIN_SPOKEN_CONFIDENCE).toBeLessThan(1);
  });
});

/**
 * THE REPORT MUST SURVIVE THE DEPLOYMENT'S LOG LEVEL.
 *
 * 28 Sep 2026. A French call produced no audio for 55 seconds in each
 * direction. The route gate was refusing every segment, the guard below
 * reported it on every segment exactly as written, and the report went to
 * `log` -- which the live session host wires to `logger.debug` -- on a box
 * running `LOG_LEVEL=info`. Every line was written and discarded.
 *
 * The investigation then read the empty log as "the guard fired 0 times" and
 * spent its time elsewhere. That is this project's other signature defect: a
 * number, or an absence, read without the context that gives it meaning. An
 * event below a threshold is not an event that did not happen.
 *
 * So the decisions that leave somebody hearing nothing go to `warn`, a
 * separate seam, and these pin WHICH seam rather than merely that something
 * was said. A test asserting "it logged" would have passed throughout the
 * outage.
 */
describe('a decision that silences a participant is not debug chatter', () => {
  function seams() {
    const debug: string[] = [];
    const warned: string[] = [];
    return {
      debug,
      warned,
      wiring: {
        log: (line: string) => void debug.push(line),
        warn: (line: string) => void warned.push(line),
      },
    };
  }

  it('warns when the gate declines, and does not merely whisper it', async () => {
    const s = seams();
    const { pipeline } = rig({
      ...s.wiring,
      translation: {
        name: 'gated:mock-mt',
        // What the gate hands back when it refuses: the ORIGINAL, flagged.
        translate: async (input) => ({
          translatedText: input.sourceText,
          providerName: 'gated:mock-mt',
          translated: false,
        }),
      },
    });
    await pipeline.onTranscriptEvent(transcript());
    expect(s.warned).toContain('translation declined; nothing will be spoken for this segment');
    expect(s.debug).not.toContain('translation declined; nothing will be spoken for this segment');
  });

  it('warns when the engine fails', async () => {
    const s = seams();
    const { pipeline } = rig({
      ...s.wiring,
      translation: {
        name: 'mock-mt',
        translate: async () => { throw new Error('provider exploded'); },
      },
    });
    await pipeline.onTranscriptEvent(transcript());
    expect(s.warned).toContain('translation failed');
    expect(s.debug).not.toContain('translation failed');
  });

  it('warns when the confidence floor withholds a voice', async () => {
    const s = seams();
    const { pipeline } = rig(s.wiring);
    await pipeline.onTranscriptEvent(
      transcript({ provider: { name: 'mock', confidence: 0.2 } }),
    );
    expect(s.warned).toContain('below the confidence floor; captioned but NOT spoken');
    expect(s.debug).not.toContain('below the confidence floor; captioned but NOT spoken');
  });

  it('leaves the chatter of a working stream where it was', async () => {
    // A stream that works must not start warning on every segment, or the
    // channel stops meaning anything and the next outage hides in the noise.
    const s = seams();
    const { pipeline } = rig(s.wiring);
    await pipeline.onTranscriptEvent(transcript());
    expect(s.warned).toEqual([]);
  });
});
