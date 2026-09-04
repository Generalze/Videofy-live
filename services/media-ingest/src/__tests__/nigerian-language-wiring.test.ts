/** @author masterzee001 */
/**
 * Wiring the founder ruling of 2026-08-30: ha/ig/yo/pcm go to 9jaLingo, then
 * AZURE, then nothing -- and the boot log says which.
 *
 * WHY A WIRING SUITE AND NOT JUST UNIT TESTS. The memory calls this the
 * unwired-seam pattern, and it has cost this repository four seams in one
 * session: both halves built, both halves tested, the join belonging to nobody
 * and always looking green. The specialist here is the textbook case -- an
 * adapter with thirty passing tests that the live path never reached, because
 * the wiring demanded a base URL nobody could supply.
 *
 * So these tests assert the JOIN. They construct the provider the live path
 * actually gets, from the environment an operator actually edits.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildLiveSynthesis,
  preflightNigerianSpecialist,
  readLiveProviderEnv,
} from '../live-provider-wiring.js';

/** Never reached: nothing in this suite synthesises. Egress would be a bug. */
const noFetch = (async () => {
  throw new Error('no test may reach a vendor');
}) as unknown as typeof fetch;

const CONFIG = { streamingSynthesisProvider: 'chain' } as const;

const GENERAL_ENV = {
  ELEVENLABS_API_KEY: 'el-key',
  ELEVENLABS_DEFAULT_VOICE_ID: 'el-voice',
  AZURE_SPEECH_KEY: 'az-key',
  AZURE_SPEECH_REGION: 'northeurope',
  AZURE_DEFAULT_VOICE_ID: 'en-US-JennyNeural',
};

function envFrom(extra: Record<string, string> = {}) {
  return readLiveProviderEnv({ ...GENERAL_ENV, ...extra } as NodeJS.ProcessEnv);
}

describe('activation is exactly "paste the key"', () => {
  it('activates on NAIJALINGO_API_KEY ALONE, with no base URL configured', () => {
    /*
     * THE DEFECT THIS REPLACES. The previous wiring required NAIJALINGO_BASE_URL
     * as well and silently skipped the specialist without it -- so a deployment
     * that had pasted the key still heard the mispronouncing general vendor,
     * and nothing said why. The host is now published by the vendor's own SDK,
     * and refusing to default a published value turns a solved problem into an
     * operator's problem on the night of a demo.
     */
    const built = buildLiveSynthesis(CONFIG, envFrom({ NAIJALINGO_API_KEY: 'k' }), noFetch);
    expect(built.nigerian?.state().specialistConfigured).toBe(true);
    expect(built.provider?.name).toMatch(/naijalingo/u);
  });

  it('survives the blank lines a template ships with', () => {
    // `NAIJALINGO_BASE_URL=` is the NORMAL state of an unconfigured box, not a
    // deliberate choice of the empty-string host.
    const built = buildLiveSynthesis(
      CONFIG,
      envFrom({
        NAIJALINGO_API_KEY: 'k',
        NAIJALINGO_BASE_URL: '   ',
        NAIJALINGO_VOICE_IDS: '',
        NAIJALINGO_SAMPLE_RATE: '',
        NAIJALINGO_RESPONSE_FORMAT: '',
      }),
      noFetch,
    );
    expect(built.nigerian?.state().specialistConfigured).toBe(true);
  });

  it('refuses a response format it does not understand, by name', () => {
    // Loud, at boot. The alternative is a vendor 4xx during a session.
    expect(() =>
      buildLiveSynthesis(
        CONFIG,
        envFrom({ NAIJALINGO_API_KEY: 'k', NAIJALINGO_RESPONSE_FORMAT: 'mp3' }),
        noFetch,
      ),
    ).toThrow(/NAIJALINGO_RESPONSE_FORMAT/u);
  });

  it('still refuses raw PCM without a measured rate', () => {
    // The one vendor mistake that produces no error anywhere: a wrong PCM rate
    // plays at the wrong pitch in a language the reviewer may not speak.
    expect(() =>
      buildLiveSynthesis(
        CONFIG,
        envFrom({ NAIJALINGO_API_KEY: 'k', NAIJALINGO_RESPONSE_FORMAT: 'pcm' }),
        noFetch,
      ),
    ).toThrow(/NAIJALINGO_SAMPLE_RATE/u);
  });
});

describe('the chain behind the specialist is AZURE, and only Azure', () => {
  it('names the specialist then azure, with no elevenlabs between or behind them', () => {
    const built = buildLiveSynthesis(CONFIG, envFrom({ NAIJALINGO_API_KEY: 'k' }), noFetch);
    const name = built.provider?.name ?? '';

    // The provider name is a composition, so it is readable as the route: the
    // Nigerian branch must contain the specialist and Azure and nothing else.
    const nigerianBranch = /nigerian\(([^)]*)\)/u.exec(name)?.[1] ?? '';
    expect(nigerianBranch).toMatch(/naijalingo/u);
    expect(nigerianBranch).toMatch(/azure/u);
    // The defect this replaces: the WHOLE general chain sat behind the
    // specialist, leaving ElevenLabs to answer Yoruba with confident, wrong
    // audio whenever the first two did not.
    expect(nigerianBranch).not.toMatch(/eleven/iu);

    // The general chain is untouched for the other ninety languages.
    expect(name).toMatch(/eleven/iu);
  });

  it('routes ha/ig/yo/pcm to that chain and nothing else to it', () => {
    const built = buildLiveSynthesis(CONFIG, envFrom({ NAIJALINGO_API_KEY: 'k' }), noFetch);
    expect(built.provider?.name).toMatch(/routed\(ha,ig,pcm,yo -> /u);
  });

  it('with NO Azure key, the chain is the specialist alone and says so', () => {
    // Honest about there being nothing behind it. Silence is worse than a
    // degraded voice, but a THIRD vendor nobody chose is worse than either,
    // because nobody would know.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const built = buildLiveSynthesis(
        { streamingSynthesisProvider: 'elevenlabs' },
        readLiveProviderEnv({
          ELEVENLABS_API_KEY: 'el-key',
          ELEVENLABS_DEFAULT_VOICE_ID: 'el-voice',
          NAIJALINGO_API_KEY: 'k',
        } as NodeJS.ProcessEnv),
        noFetch,
      );
      const nigerianBranch = /nigerian\(([^)]*)\)/u.exec(built.provider?.name ?? '')?.[1] ?? '';
      expect(nigerianBranch).not.toMatch(/eleven/iu);
      expect(warn.mock.calls.join(' ')).toMatch(/AZURE_SPEECH_KEY is not set/u);
      expect(warn.mock.calls.join(' ')).toMatch(/SILENCE/u);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('no specialist is a reported state, not a quiet one', () => {
  it('WARNS at boot, names the four languages, and says what it costs', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const built = buildLiveSynthesis(CONFIG, envFrom(), noFetch);
      const logged = warn.mock.calls.join(' ');
      // At warn, not info. The founder ruling of 2026-08-30 makes the
      // specialist the intended configuration, so its absence is a deviation.
      expect(logged).toMatch(/NAIJALINGO_API_KEY is not set/u);
      expect(logged).toMatch(/DEGRADED/u);
      for (const language of ['ha', 'ig', 'yo', 'pcm']) {
        expect(logged, language).toContain(language);
      }
      expect(built.nigerian?.state().specialistConfigured).toBe(false);
      expect(built.nigerian?.state().degraded).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('sends those four to AZURE rather than to the general chain', () => {
    // So that switching the key on later changes WHO answers and nothing else
    // about the path -- and so ElevenLabs never inherits them by accident.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const built = buildLiveSynthesis(CONFIG, envFrom(), noFetch);
      expect(built.provider?.name).toMatch(/routed\(ha,ig,pcm,yo -> /u);
      expect(built.provider?.name).toMatch(/azure/u);
    } finally {
      warn.mockRestore();
    }
  });

  it('synthesis switched off reports no Nigerian state at all', () => {
    // Nothing to be degraded about: this deployment produces no audio.
    const built = buildLiveSynthesis({ streamingSynthesisProvider: 'off' }, envFrom(), noFetch);
    expect(built.provider).toBeNull();
    expect(built.nigerian).toBeNull();
  });
});

describe('the preflight the boot log is built from', () => {
  it('reports an ABSENT key as absent, without attempting a request', async () => {
    let attempted = false;
    const fetchImpl = (async () => {
      attempted = true;
      return new Response('{}');
    }) as unknown as typeof fetch;

    const preflight = await preflightNigerianSpecialist(envFrom(), fetchImpl);
    expect(preflight.keyConfigured).toBe(false);
    expect(attempted).toBe(false);
    // Reported as unserved rather than as "no problems found".
    expect(preflight.languagesWithoutSpeakers).toEqual(['ha', 'ig', 'yo', 'pcm']);
  });

  it('uses the configured header and host, and never carries a key into its report', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: unknown, init: unknown) => {
      seen.push({
        url: String(url),
        headers: (init as RequestInit).headers as Record<string, string>,
      });
      return new Response(JSON.stringify({ status: 'ok', speakers: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const preflight = await preflightNigerianSpecialist(
      envFrom({ NAIJALINGO_API_KEY: 'super-secret-value', NAIJALINGO_BASE_URL: 'https://h.invalid' }),
      fetchImpl,
    );
    expect(seen[0]?.url).toBe('https://h.invalid/v1/health');
    expect(seen[0]?.headers['x-api-key']).toBe('super-secret-value');
    // NAMES ONLY. A preflight that leaked its key into a boot log would be a
    // worse failure than the one it exists to catch.
    expect(JSON.stringify(preflight)).not.toContain('super-secret-value');
  });
});
