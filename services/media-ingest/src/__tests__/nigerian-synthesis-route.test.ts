/** @author masterzee001 */
/**
 * The Nigerian chain, and the mark it leaves when the specialist did not answer.
 *
 * WHAT THESE TESTS ARE ACTUALLY GUARDING. Not "does the fallback work" -- the
 * generic chain already has tests for that. These guard the part that has no
 * other signal: when Azure speaks Yoruba instead of 9jaLingo, audio plays, the
 * status is 200, the sample count is plausible, the latency is normal, and the
 * only person who can hear that the wrong vendor answered is a speaker of the
 * language who is not reading logs. A silent fall-through here is not a
 * degraded feature, it is a product that reports success while being wrong.
 *
 * So each test below asserts a MARK, not a behaviour: the marker on the result,
 * the counter in the state, the outcome the log line is built from. Deleting
 * any one of them restores the exact failure this wave exists to prevent, and
 * every other test in this repository would still pass.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  NIGERIAN_FALLBACK_PROVIDER_ID,
  NIGERIAN_SPECIALIST_LANGUAGES,
  NIGERIAN_SPECIALIST_PROVIDER_ID,
} from '@videofy-live/ai-registry';
import {
  absentSpecialistState,
  createNigerianSynthesisRoute,
  type NigerianSynthesisOutcome,
} from '../nigerian-synthesis-route.js';
import type {
  StreamingSpeechSynthesisProvider,
  StreamingSynthesisOptions,
  StreamingSynthesisResult,
} from '../streaming-speech-synthesis-provider.js';

/** A provider that speaks, or one that does not. Nothing else varies. */
function speaker(name: string, samples: number): StreamingSpeechSynthesisProvider {
  return {
    name,
    async synthesize(options: StreamingSynthesisOptions): Promise<StreamingSynthesisResult> {
      if (samples === 0) {
        return { samples: 0, timeToFirstChunkMs: null, totalMs: 1, aborted: false };
      }
      options.onChunk({ samples: new Int16Array(samples) });
      return { samples, timeToFirstChunkMs: 1, totalMs: 1, aborted: false };
    },
  };
}

function thrower(name: string): StreamingSpeechSynthesisProvider {
  return {
    name,
    synthesize: async () => {
      throw new Error(`${name} is cold`);
    },
  };
}

function request(language: string): StreamingSynthesisOptions {
  return {
    text: 'e kaaro',
    targetLanguage: language,
    voiceId: 'voice_1',
    onChunk: vi.fn(),
    onError: vi.fn(),
  };
}

describe('the specialist answered', () => {
  it('leaves NO degraded marker, and counts the sentence as the specialist', async () => {
    const route = createNigerianSynthesisRoute({
      specialist: speaker('naijalingo:9jalingo-tts-1', 100),
      fallback: speaker('azure', 100),
    });
    const result = await route.provider.synthesize(request('yo'));

    expect(result.samples).toBe(100);
    // Absent, not `degraded: false`. A marker that is always present is a
    // marker nothing reads.
    expect(result.degraded).toBeUndefined();

    const state = route.state();
    expect(state.specialistSentences).toBe(1);
    expect(state.degradedSentences).toBe(0);
    expect(state.degraded).toBe(false);
    expect(state.renderingByLanguage['yo']).toBe('specialist');
  });

  it('does NOT claim the audio was good, only that the specialist produced it', () => {
    // The honesty rule, as a type-level fact: there is nowhere on this state to
    // record a quality judgement, because nothing here is entitled to make one.
    const route = createNigerianSynthesisRoute({
      specialist: speaker('naijalingo', 10),
      fallback: speaker('azure', 10),
    });
    expect(Object.keys(route.state())).not.toContain('quality');
    expect(Object.keys(route.state())).not.toContain('verified');
  });
});

describe('the fallback answered, and everything says so', () => {
  it('marks the RESULT degraded, naming the language, the expected vendor and the actual one', async () => {
    const route = createNigerianSynthesisRoute({
      specialist: thrower('naijalingo:9jalingo-tts-1'),
      fallback: speaker('azure', 80),
    });
    const result = await route.provider.synthesize(request('yo'));

    // Audio still reached the listener -- that is the point of a fallback.
    expect(result.samples).toBe(80);
    // And the fact that it was the WRONG voice travels with it.
    expect(result.degraded).toBeDefined();
    expect(result.degraded?.language).toBe('yo');
    expect(result.degraded?.expectedProvider).toBe('naijalingo:9jalingo-tts-1');
    expect(result.degraded?.servedBy).toBe('azure');
    expect(result.degraded?.reason).toMatch(/mispronounce/u);
  });

  it('reports it through the outcome the WARN log is built from', async () => {
    const outcomes: NigerianSynthesisOutcome[] = [];
    const route = createNigerianSynthesisRoute({
      specialist: thrower('naijalingo'),
      fallback: speaker('azure', 80),
      onOutcome: (outcome) => outcomes.push(outcome),
    });
    await route.provider.synthesize(request('ha'));

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.rendering).toBe('degraded-fallback');
    expect(outcomes[0]?.language).toBe('ha');
    expect(outcomes[0]?.servedBy).toBe('azure');
    // The reason names WHY, not merely that it happened: an operator has to be
    // able to tell a cold specialist from a missing key.
    expect(outcomes[0]?.fellThrough).toEqual(['naijalingo']);
    expect(outcomes[0]?.degradation?.reason).toMatch(/fell through: naijalingo/u);
  });

  it('treats ZERO SAMPLES as a fall-through, not as a quiet success', async () => {
    // The specialist returning silence is the failure most likely to be read as
    // success, because nothing threw.
    const route = createNigerianSynthesisRoute({
      specialist: speaker('naijalingo', 0),
      fallback: speaker('azure', 40),
    });
    const result = await route.provider.synthesize(request('ig'));
    expect(result.degraded?.servedBy).toBe('azure');
    expect(route.state().degradedSentences).toBe(1);
  });

  it('STAYS degraded once it has happened, because a listener already heard it', async () => {
    const route = createNigerianSynthesisRoute({
      specialist: {
        name: 'naijalingo',
        // Fails once, then recovers. The state must not quietly go green.
        synthesize: (() => {
          let call = 0;
          return async (options: StreamingSynthesisOptions) => {
            call += 1;
            if (call === 1) throw new Error('cold');
            options.onChunk({ samples: new Int16Array(50) });
            return { samples: 50, timeToFirstChunkMs: 1, totalMs: 1, aborted: false };
          };
        })(),
      },
      fallback: speaker('azure', 40),
    });

    await route.provider.synthesize(request('yo'));
    const second = await route.provider.synthesize(request('yo'));

    expect(second.degraded).toBeUndefined();
    const state = route.state();
    expect(state.specialistSentences).toBe(1);
    expect(state.degradedSentences).toBe(1);
    expect(state.degraded).toBe(true);
    expect(state.degradedReason).toMatch(/naijalingo/u);
  });

  it('never replaces a specialist that has already spoken, even when it then fails', async () => {
    // Reused from the generic chain's rule, asserted here because a wrapper is
    // exactly where somebody would re-implement it slightly differently: half a
    // sentence in one voice followed by the whole sentence in another is worse
    // than either outcome alone.
    const chunks: number[] = [];
    const route = createNigerianSynthesisRoute({
      specialist: {
        name: 'naijalingo',
        synthesize: async (options) => {
          options.onChunk({ samples: new Int16Array(30) });
          throw new Error('died mid-sentence');
        },
      },
      fallback: speaker('azure', 40),
    });
    await route.provider.synthesize({
      ...request('yo'),
      onChunk: (chunk) => chunks.push(chunk.samples.length),
    });
    expect(chunks).toEqual([30]);
  });
});

describe('states that are not degradation', () => {
  it('with NO fallback at all, the specialist is never called twice', async () => {
    // A doubled request to a vendor that scales to zero doubles the wait at the
    // exact moment a listener is already waiting -- and reports a fall-through
    // onto the provider that had just failed.
    let calls = 0;
    const route = createNigerianSynthesisRoute({
      specialist: {
        name: 'naijalingo',
        synthesize: async () => {
          calls += 1;
          throw new Error('cold');
        },
      },
      fallback: null,
    });
    const result = await route.provider.synthesize(request('yo'));
    expect(calls).toBe(1);
    expect(result.degraded).toBeUndefined();
    expect(route.state().renderingByLanguage['yo']).toBe('failed');
    // The name says what is behind it, because nothing is.
    expect(route.provider.name).toMatch(/NOTHING/u);
  });

  it('an ABORT is not degraded: nobody heard it', async () => {
    const controller = new AbortController();
    controller.abort();
    const route = createNigerianSynthesisRoute({
      specialist: {
        name: 'naijalingo',
        synthesize: async () => ({
          samples: 0,
          timeToFirstChunkMs: null,
          totalMs: 0,
          aborted: true,
        }),
      },
      fallback: speaker('azure', 40),
    });
    const result = await route.provider.synthesize({
      ...request('yo'),
      signal: controller.signal,
    });
    expect(result.aborted).toBe(true);
    expect(result.degraded).toBeUndefined();
    expect(route.state().degradedSentences).toBe(0);
  });

  it('EVERYTHING failing is reported as failed, not as degraded', async () => {
    // Degraded means "the wrong voice spoke". Silence is a different problem
    // with a different fix, and collapsing them hides both.
    const route = createNigerianSynthesisRoute({
      specialist: thrower('naijalingo'),
      fallback: thrower('azure'),
    });
    const result = await route.provider.synthesize(request('pcm'));
    expect(result.degraded).toBeUndefined();
    expect(route.state().renderingByLanguage['pcm']).toBe('failed');
    expect(route.state().degraded).toBe(false);
  });

  it('a language nobody has asked for is not-attempted, not healthy', async () => {
    // Reporting "no problems" for a language nobody used is how a broken
    // specialist survives a demo.
    const route = createNigerianSynthesisRoute({
      specialist: speaker('naijalingo', 10),
      fallback: speaker('azure', 10),
    });
    await route.provider.synthesize(request('yo'));
    const state = route.state();
    expect(state.renderingByLanguage['yo']).toBe('specialist');
    for (const language of ['ha', 'ig', 'pcm']) {
      expect(state.renderingByLanguage[language], language).toBe('not-attempted');
    }
  });
});

describe('the state a console and /health read', () => {
  it('names the specialist and the ONE fallback from the registry, not from a copy', () => {
    const route = createNigerianSynthesisRoute({
      specialist: speaker('naijalingo', 10),
      fallback: speaker('azure', 10),
    });
    const state = route.state();
    expect(state.specialistProviderId).toBe(NIGERIAN_SPECIALIST_PROVIDER_ID);
    expect(state.fallbackProviderId).toBe(NIGERIAN_FALLBACK_PROVIDER_ID);
    expect(state.languages).toEqual(NIGERIAN_SPECIALIST_LANGUAGES);
  });

  it('NO KEY is a reported state, and it is degraded from the start', () => {
    // "No specialist configured" must not read as "nothing to report". Every
    // sentence in these four languages is already a degraded rendering.
    const state = absentSpecialistState();
    expect(state.specialistConfigured).toBe(false);
    expect(state.degraded).toBe(true);
    expect(state.degradedReason).toMatch(/no naijalingo credential/u);
    expect(state.degradedReason).toMatch(/mispronounces/u);
  });

  it('carries the boot preflight so one state answers both questions', async () => {
    const route = createNigerianSynthesisRoute({
      specialist: speaker('naijalingo', 10),
      fallback: speaker('azure', 10),
    });
    expect(route.state().preflight).toBeNull();
    route.recordPreflight({
      keyConfigured: true,
      reachable: true,
      engineReady: true,
      totalSpeakers: 240,
      speakerIdsByLanguage: { yo: ['adeola_yo'] },
      languagesWithoutSpeakers: [],
      problem: null,
    });
    expect(route.state().preflight?.totalSpeakers).toBe(240);
  });

  it('is a SNAPSHOT: a later sentence does not mutate a state already handed out', async () => {
    const route = createNigerianSynthesisRoute({
      specialist: thrower('naijalingo'),
      fallback: speaker('azure', 10),
    });
    const before = route.state();
    await route.provider.synthesize(request('yo'));
    // A /health response serialised a moment ago must not change under the
    // reader; a mutable map handed out is a report that rewrites itself.
    expect(before.renderingByLanguage['yo']).toBe('not-attempted');
    expect(route.state().renderingByLanguage['yo']).toBe('degraded-fallback');
  });

  it('attributes concurrent sentences to the right language', async () => {
    // Concurrency is why the chain is built per call. A shared observation slot
    // would attribute one language's fall-through to another's -- a wrong
    // degraded label, which is worse than none because it is checkable-looking.
    const route = createNigerianSynthesisRoute({
      specialist: {
        name: 'naijalingo',
        synthesize: async (options) => {
          if (options.targetLanguage === 'yo') throw new Error('cold');
          await new Promise((resolve) => setTimeout(resolve, 5));
          options.onChunk({ samples: new Int16Array(20) });
          return { samples: 20, timeToFirstChunkMs: 1, totalMs: 1, aborted: false };
        },
      },
      fallback: speaker('azure', 10),
    });

    const [yoruba, igbo] = await Promise.all([
      route.provider.synthesize(request('yo')),
      route.provider.synthesize(request('ig')),
    ]);

    expect(yoruba?.degraded?.language).toBe('yo');
    expect(igbo?.degraded).toBeUndefined();
    expect(route.state().renderingByLanguage['yo']).toBe('degraded-fallback');
    expect(route.state().renderingByLanguage['ig']).toBe('specialist');
  });

  it('folds a regional tag onto the language it is', async () => {
    const route = createNigerianSynthesisRoute({
      specialist: thrower('naijalingo'),
      fallback: speaker('azure', 10),
    });
    const result = await route.provider.synthesize(request('yo-NG'));
    expect(result.degraded?.language).toBe('yo');
    expect(route.state().renderingByLanguage['yo']).toBe('degraded-fallback');
  });
});
