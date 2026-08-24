/**
 * Whether this deployment can actually translate speech.
 *
 * The mock providers are convincing from the outside: sessions open, health is
 * green, nothing errors. Staging ran that way while the call surface told
 * people they were "hearing translated voice" and produced silence. These
 * tests pin the one question that would have caught it.
 */
import { describe, expect, it } from 'vitest';
import {
  describeLiveEngine,
  parseVoiceIdMap,
  readLiveProviderEnv,
} from '../live-provider-wiring.js';

const REAL = {
  streamingTranscriptionProvider: 'deepgram-flux',
  streamingSynthesisProvider: 'elevenlabs',
  translationProvider: 'opus-mt',
} as const;

describe('describeLiveEngine', () => {
  it('calls a fully configured engine real', () => {
    const engine = describeLiveEngine(REAL);
    expect(engine.real).toBe(true);
    expect(engine.stubbed).toEqual([]);
  });

  it('PIN: a mock recogniser means the engine is NOT real', () => {
    // This exact configuration shipped to staging. Nothing in the running
    // system said so, and the product claimed to be translating.
    const engine = describeLiveEngine({ ...REAL, streamingTranscriptionProvider: 'mock' });
    expect(engine.real).toBe(false);
    expect(engine.stubbed.join(' ')).toContain('speech recognition');
  });

  it('PIN: a mock voice means the engine is NOT real', () => {
    // Text without a voice is captions, not translated audio.
    const engine = describeLiveEngine({ ...REAL, streamingSynthesisProvider: 'mock' });
    expect(engine.real).toBe(false);
    expect(engine.stubbed.join(' ')).toContain('speech synthesis');
  });

  it('PIN: mock translation means the engine is NOT real', () => {
    const engine = describeLiveEngine({ ...REAL, translationProvider: 'mock' });
    expect(engine.real).toBe(false);
    expect(engine.stubbed.join(' ')).toContain('translation');
  });

  it('treats a provider switched off exactly as harshly as a mocked one', () => {
    // "off" is honest configuration, but it produces the same silence, so it
    // must not read as a working engine either.
    expect(describeLiveEngine({ ...REAL, streamingTranscriptionProvider: 'off' }).real).toBe(false);
    expect(describeLiveEngine({ ...REAL, streamingSynthesisProvider: 'off' }).real).toBe(false);
  });

  it('names every stubbed part, not just the first', () => {
    // Fixing one and redeploying, only to find the next, wastes a whole cycle.
    const engine = describeLiveEngine({
      streamingTranscriptionProvider: 'mock',
      streamingSynthesisProvider: 'mock',
      translationProvider: 'mock',
    });
    expect(engine.stubbed).toHaveLength(3);
  });

  it('reports the provider names so an operator knows what is configured', () => {
    const engine = describeLiveEngine(REAL);
    expect(engine.transcription).toBe('deepgram-flux');
    expect(engine.synthesis).toBe('elevenlabs');
    expect(engine.translation).toBe('opus-mt');
  });
});

/**
 * Reading provider configuration from the environment.
 *
 * Deployment templates declare every supported variable and leave the values
 * blank, so an empty string is the normal state of an unconfigured box rather
 * than a deliberate choice.
 */
describe('readLiveProviderEnv', () => {
  it('PIN: an empty value is ABSENT, so defaults apply', () => {
    // DEEPGRAM_MODEL="" survived `?? 'flux-general-en'` — which only replaces
    // null and undefined — reached the provider as a model named "", and
    // crash-looped media-ingest 18 times with `" is not a Flux model"`.
    const env = readLiveProviderEnv({
      DEEPGRAM_MODEL: '',
      DEEPGRAM_API_KEY: '',
      ELEVENLABS_DEFAULT_VOICE_ID: '',
    } as NodeJS.ProcessEnv);
    expect(env.deepgramModel).toBeUndefined();
    expect(env.deepgramApiKey).toBeUndefined();
    expect(env.elevenLabsVoiceId).toBeUndefined();
  });

  it('PIN: whitespace is absent too', () => {
    // Invisible in a file that cannot be printed, identical in effect.
    const env = readLiveProviderEnv({ DEEPGRAM_MODEL: '   ' } as NodeJS.ProcessEnv);
    expect(env.deepgramModel).toBeUndefined();
  });

  it('keeps real values, trimmed', () => {
    const env = readLiveProviderEnv({
      DEEPGRAM_MODEL: ' flux-general-en ',
    } as NodeJS.ProcessEnv);
    expect(env.deepgramModel).toBe('flux-general-en');
  });
});

/**
 * Mapping the platform's voices onto the vendor's.
 *
 * With no map, every platform voice fell through to one default: a speaker who
 * chose a female translated voice was spoken by whichever single voice the
 * deployment had, and every participant in every language shared it. The
 * choice was computed correctly all the way to the vendor boundary and thrown
 * away there.
 */
describe('parseVoiceIdMap', () => {
  it('maps each platform voice to its vendor voice', () => {
    const map = parseVoiceIdMap('en_US-hfc_female-medium=abc123,fr_FR-siwis-medium=def456');
    expect(map).toEqual({
      'en_US-hfc_female-medium': 'abc123',
      'fr_FR-siwis-medium': 'def456',
    });
  });

  it('tolerates spacing around the pairs', () => {
    expect(parseVoiceIdMap(' a = 1 , b = 2 ')).toEqual({ a: '1', b: '2' });
  });

  it('PIN: a malformed pair is skipped, never fatal', () => {
    // The cost of a bad pair is one voice falling back to the default. The
    // cost of throwing is a deployment that cannot take calls at all.
    expect(parseVoiceIdMap('good=1,broken,=2,alsogood=3,x=')).toEqual({
      good: '1',
      alsogood: '3',
    });
  });

  it('answers empty for nothing configured, which keeps the old behaviour', () => {
    expect(parseVoiceIdMap(undefined)).toEqual({});
    expect(parseVoiceIdMap('')).toEqual({});
  });

  it('keeps a vendor id that contains no equals sign intact', () => {
    // Vendor ids are opaque; only the FIRST '=' separates the pair.
    expect(parseVoiceIdMap('plat=ven=dor')).toEqual({ plat: 'ven=dor' });
  });
});
