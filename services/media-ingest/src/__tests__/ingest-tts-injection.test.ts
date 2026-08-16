/** @owner masterzee001 */
import { describe, expect, it, vi } from 'vitest';
import {
  createPersonalVoiceRoutingProvider,
  personalVoiceId,
  profileIdFromPersonalVoiceId,
} from '../openvoice-personal-voice.js';
import type {
  TextToSpeechProvider,
  TextToSpeechProviderInput,
} from '../text-to-speech-provider.js';

/** Mirrors IngestService.buildTextToSpeechProvider exactly. */
function build(
  standard: TextToSpeechProvider,
  deps: { wrapTextToSpeechProvider?: (s: TextToSpeechProvider) => TextToSpeechProvider } = {},
): TextToSpeechProvider {
  return deps.wrapTextToSpeechProvider?.(standard) ?? standard;
}

function standardProvider(): TextToSpeechProvider {
  return {
    name: 'piper',
    generate: vi.fn(async (input) => ({ audioPath: input.outputPath, providerLatencyMs: 3 })),
  };
}

function input(overrides: Partial<TextToSpeechProviderInput> = {}): TextToSpeechProviderInput {
  return {
    sessionId: 's1', streamId: 'st1', segmentId: 'seg1', sequence: 1,
    targetLanguage: 'es', translatedText: 'Buenos días.',
    startMs: 0, endMs: 1000,
    voiceId: 'es_ES-standard', outputPath: 'C:/tmp/o.wav',
    ...overrides,
  } as TextToSpeechProviderInput;
}

describe('the seam preserves the existing path', () => {
  it('returns the standard provider untouched when no wrapper is supplied', () => {
    // Not "equivalent behaviour" — the identical object, so the Piper/MMS path
    // cannot drift because personal voice was added elsewhere.
    const standard = standardProvider();

    expect(build(standard)).toBe(standard);
  });

  it('routes a standard voiceId straight through even when wrapped', async () => {
    const standard = standardProvider();
    const wrapped = build(standard, {
      wrapTextToSpeechProvider: (s) =>
        createPersonalVoiceRoutingProvider({
          standard: s,
          personal: { synthesize: vi.fn() },
          assetRefFor: () => null,
          fallbackVoiceId: () => 'es_ES-standard',
          writeAudio: vi.fn(),
        }),
    });

    await wrapped.generate(input());

    expect(standard.generate).toHaveBeenCalledTimes(1);
  });
});

describe('asset lookup is fresh every utterance', () => {
  it('follows a revoked profile on the very next utterance', async () => {
    // Caching personal:<id> -> assetRef is exactly how revoke, delete and
    // re-record would stop taking effect until a restart.
    const standard = standardProvider();
    let assetRef: string | null = 'ov2_live';
    const personal = { synthesize: vi.fn(async () => ({ ok: true as const, audio: new Uint8Array([1]) })) };
    const wrapped = createPersonalVoiceRoutingProvider({
      standard,
      personal,
      assetRefFor: () => assetRef,
      fallbackVoiceId: () => 'es_ES-standard',
      writeAudio: vi.fn(),
    });

    await wrapped.generate(input({ voiceId: personalVoiceId('vp1') }));
    expect(personal.synthesize).toHaveBeenCalledTimes(1);
    expect(standard.generate).not.toHaveBeenCalled();

    // Revocation clears the asset. No restart, no rebinding.
    assetRef = null;
    await wrapped.generate(input({ voiceId: personalVoiceId('vp1') }));

    expect(personal.synthesize).toHaveBeenCalledTimes(1);
    expect(standard.generate).toHaveBeenCalledTimes(1);
  });
});

describe('owner isolation through the identity', () => {
  it('cannot resolve another owner asset from a personal id', () => {
    // The lookup is keyed by the profile in the id, so owner B's id can only
    // ever reach owner B's profile.
    const assets: Record<string, string> = { vp_a: 'ov2_a', vp_b: 'ov2_b' };
    const lookup = (voiceId: string) => {
      const profileId = profileIdFromPersonalVoiceId(voiceId);
      return profileId ? (assets[profileId] ?? null) : null;
    };

    expect(lookup(personalVoiceId('vp_a'))).toBe('ov2_a');
    expect(lookup(personalVoiceId('vp_b'))).toBe('ov2_b');
    expect(lookup(personalVoiceId('vp_unknown'))).toBeNull();
    expect(lookup('es_ES-standard')).toBeNull();
  });
});

describe('profileIdFromPersonalVoiceId', () => {
  it('extracts the profile and refuses anything else', () => {
    expect(profileIdFromPersonalVoiceId('personal:vp1')).toBe('vp1');
    expect(profileIdFromPersonalVoiceId('personal:')).toBeNull();
    expect(profileIdFromPersonalVoiceId('es_ES-standard')).toBeNull();
  });
});
