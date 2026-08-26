/**
 * One voice, several vendors behind it.
 *
 * The rule that makes a synthesis chain safe is not "retry until something
 * works" -- it is that a provider which has already SPOKEN is never replaced.
 * Most of these tests are about that boundary, because getting it wrong turns a
 * missing sentence into a stuttering one, which is worse.
 */
import { describe, expect, it, vi } from 'vitest';
import { createFallbackSpeechSynthesisProvider } from '../fallback-speech-synthesis-provider.js';
import type {
  StreamingSpeechSynthesisProvider,
  StreamingSynthesisOptions,
  StreamingSynthesisResult,
} from '../streaming-speech-synthesis-provider.js';

/** A provider that does exactly what a test tells it to. */
function provider(
  name: string,
  behaviour: (options: StreamingSynthesisOptions) => Promise<StreamingSynthesisResult>,
): StreamingSpeechSynthesisProvider {
  return { name, synthesize: behaviour };
}

const speaks = (name: string, samples = 480) =>
  provider(name, async (options) => {
    options.onChunk({ samples: new Int16Array(samples) });
    return { samples, timeToFirstChunkMs: 10, totalMs: 20, aborted: false };
  });

const throwsBeforeSpeaking = (name: string) =>
  provider(name, async () => {
    throw new Error(`${name} is down`);
  });

const reportsErrorBeforeSpeaking = (name: string) =>
  provider(name, async (options) => {
    options.onError(new Error(`${name} refused`));
    return { samples: 0, timeToFirstChunkMs: null, totalMs: 5, aborted: false };
  });

const silence = (name: string) =>
  provider(name, async () => ({
    samples: 0,
    timeToFirstChunkMs: null,
    totalMs: 5,
    aborted: false,
  }));

function request(overrides: Partial<StreamingSynthesisOptions> = {}): StreamingSynthesisOptions {
  return {
    text: 'good morning',
    targetLanguage: 'fr',
    voiceId: 'voice_1',
    onChunk: vi.fn(),
    onError: vi.fn(),
    ...overrides,
  };
}

describe('falling through', () => {
  it('uses the first provider when it works', async () => {
    const chain = createFallbackSpeechSynthesisProvider({
      providers: [speaks('primary'), speaks('backup')],
    });
    const observations: unknown[] = [];

    const result = await chain.synthesize(request());
    expect(result.samples).toBe(480);
    void observations;
  });

  it('falls through when the first throws before speaking', async () => {
    const onChunk = vi.fn();
    const chain = createFallbackSpeechSynthesisProvider({
      providers: [throwsBeforeSpeaking('primary'), speaks('backup')],
    });

    const result = await chain.synthesize(request({ onChunk }));

    expect(result.samples).toBe(480);
    expect(onChunk).toHaveBeenCalledTimes(1);
  });

  it('falls through when the first reports an error before speaking', async () => {
    const chain = createFallbackSpeechSynthesisProvider({
      providers: [reportsErrorBeforeSpeaking('primary'), speaks('backup')],
    });

    expect((await chain.synthesize(request())).samples).toBe(480);
  });

  /* Zero samples is a failure, not a quiet success. */
  it('falls through when the first produces silence', async () => {
    const chain = createFallbackSpeechSynthesisProvider({
      providers: [silence('primary'), speaks('backup')],
    });

    expect((await chain.synthesize(request())).samples).toBe(480);
  });

  /*
   * A failure the platform recovers from is not a failure the caller should be
   * told about -- an error surfaced here would have a listener told something
   * went wrong while they are hearing the sentence perfectly well.
   */
  it('does not report an error the chain recovered from', async () => {
    const onError = vi.fn();
    const chain = createFallbackSpeechSynthesisProvider({
      providers: [throwsBeforeSpeaking('primary'), speaks('backup')],
    });

    await chain.synthesize(request({ onError }));
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('the rule that makes it safe', () => {
  /*
   * THE ONE THAT MATTERS. A provider that already spoke owns the sentence. If
   * the chain restarted, the listener would hear the first half twice, in two
   * different voices -- and a stuttering sentence is worse than a missing one.
   */
  it('never replaces a provider that has already spoken', async () => {
    const chunks: number[] = [];
    const failsAfterSpeaking = provider('primary', async (options) => {
      options.onChunk({ samples: new Int16Array(240) });
      options.onError(new Error('died mid-sentence'));
      return { samples: 240, timeToFirstChunkMs: 8, totalMs: 12, aborted: false };
    });

    const chain = createFallbackSpeechSynthesisProvider({
      providers: [failsAfterSpeaking, speaks('backup')],
    });

    await chain.synthesize(
      request({ onChunk: (chunk) => chunks.push(chunk.samples.length) }),
    );

    // Only the primary's audio. The backup was never asked.
    expect(chunks).toEqual([240]);
  });

  it('reports the failure when a committed provider dies part-way', async () => {
    const onError = vi.fn();
    const failsAfterSpeaking = provider('primary', async (options) => {
      options.onChunk({ samples: new Int16Array(240) });
      options.onError(new Error('died mid-sentence'));
      return { samples: 240, timeToFirstChunkMs: 8, totalMs: 12, aborted: false };
    });

    const chain = createFallbackSpeechSynthesisProvider({
      providers: [failsAfterSpeaking, speaks('backup')],
    });
    await chain.synthesize(request({ onError }));

    // Nothing recovered it, so this one IS the caller's business.
    expect(onError).toHaveBeenCalledTimes(1);
  });

  /*
   * A superseded sentence is cancelled on purpose. Falling through would pay a
   * second vendor to synthesise something already known to be unwanted.
   */
  it('does not fall through on an abort', async () => {
    const backup = vi.fn();
    const aborted = provider('primary', async () => ({
      samples: 0,
      timeToFirstChunkMs: null,
      totalMs: 3,
      aborted: true,
    }));

    const chain = createFallbackSpeechSynthesisProvider({
      providers: [aborted, provider('backup', backup)],
    });

    const result = await chain.synthesize(request());
    expect(result.aborted).toBe(true);
    expect(backup).not.toHaveBeenCalled();
  });
});

describe('when everything fails', () => {
  it('reports one error, at the point the platform has run out of answers', async () => {
    const onError = vi.fn();
    const chain = createFallbackSpeechSynthesisProvider({
      providers: [throwsBeforeSpeaking('a'), silence('b'), reportsErrorBeforeSpeaking('c')],
    });

    const result = await chain.synthesize(request({ onError }));

    expect(result.samples).toBe(0);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('refuses to be built with no providers at all', () => {
    expect(() => createFallbackSpeechSynthesisProvider({ providers: [] })).toThrow();
  });
});

describe('what it tells the deployment', () => {
  /*
   * A chain that works perfectly HIDES an outage: the listener hears audio
   * either way, so nobody finds out the primary is down until the bill or the
   * latency changes. This is the signal that says so.
   */
  it('names which provider served and which fell through', async () => {
    const observations: { servedBy: string | null; fellThrough: readonly string[] }[] = [];
    const chain = createFallbackSpeechSynthesisProvider({
      providers: [throwsBeforeSpeaking('primary'), silence('second'), speaks('third')],
      onObservation: (observation) => observations.push(observation),
    });

    await chain.synthesize(request());

    expect(observations).toHaveLength(1);
    expect(observations[0]?.servedBy).toBe('third');
    expect(observations[0]?.fellThrough).toEqual(['primary', 'second']);
  });

  it('says nobody served when the whole chain failed', async () => {
    const observations: { servedBy: string | null }[] = [];
    const chain = createFallbackSpeechSynthesisProvider({
      providers: [throwsBeforeSpeaking('a'), throwsBeforeSpeaking('b')],
      onObservation: (observation) => observations.push(observation),
    });

    await chain.synthesize(request());
    expect(observations[0]?.servedBy).toBeNull();
  });

  it('names itself by the chain it is', () => {
    const chain = createFallbackSpeechSynthesisProvider({
      providers: [speaks('elevenlabs'), speaks('azure')],
    });
    expect(chain.name).toContain('elevenlabs');
    expect(chain.name).toContain('azure');
  });
});
