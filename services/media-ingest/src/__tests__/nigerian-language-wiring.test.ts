/** @author masterzee001 */
/**
 * Wiring the founder ruling of 2026-09-18: ha/ig/yo/pcm go to the APPROVED
 * voice, nothing stands behind it, and the boot log says so.
 *
 * WHY A WIRING SUITE AND NOT JUST UNIT TESTS. The memory calls this the
 * unwired-seam pattern: both halves built, both halves tested, the join
 * belonging to nobody and always looking green. This seam is its worst
 * recorded case. On 2026-09-18 the ruling was implemented in `ai-registry`,
 * thirteen tests were rewritten to assert it, the change was reviewed and
 * DEPLOYED -- and production went on speaking Yoruba with the rejected vendor,
 * because this file restated the vendor instead of importing it. The suite that
 * was here passed throughout. It was asserting the old ruling.
 *
 * SO THESE TESTS DERIVE THEIR EXPECTATIONS FROM `ai-registry` RATHER THAN
 * NAMING A VENDOR. That is the only shape that fails when the constant and the
 * wiring disagree; a test that hardcodes "elevenlabs" would pass just as
 * happily on the day somebody changes the ruling and forgets this file, which
 * is precisely what happened.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  NIGERIAN_FALLBACK_PROVIDER_ID,
  NIGERIAN_SPECIALIST_LANGUAGES,
  NIGERIAN_SPECIALIST_PROVIDER_ID,
  NIGERIAN_TTS_ROUTE_ORDER,
} from '@videofy-live/ai-registry';
import {
  NIGERIAN_VOICE_VENDORS,
  buildLiveSynthesis,
  preflightNigerianSpecialist,
  readLiveProviderEnv,
  selectNigerianVoice,
} from '../live-provider-wiring.js';

/** Never reached by the wiring tests: constructing must not call a vendor. */
const noFetch = (async () => {
  throw new Error('no test may reach a vendor');
}) as unknown as typeof fetch;

const CONFIG = { streamingSynthesisProvider: 'chain' } as const;

/** Everything a general deployment has, including the REJECTED vendor's key. */
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

/** The Nigerian branch of the composed provider name, which reads as the route. */
function nigerianBranch(name: string): string {
  return /nigerian\(([^)]*)\)/u.exec(name)?.[1] ?? '';
}

describe('the approved voice is READ from ai-registry, not restated here', () => {
  it('routes the four languages to whichever vendor the ruling currently names', () => {
    const built = buildLiveSynthesis(CONFIG, envFrom(), noFetch);
    const branch = nigerianBranch(built.provider?.name ?? '');

    /*
     * THE TEST THE OLD SUITE DID NOT HAVE. It asserted a vendor by name, so it
     * agreed with the wiring and with itself while both disagreed with the
     * ruling. This reads the constant, so the two cannot drift apart silently.
     */
    expect(branch).toContain(NIGERIAN_SPECIALIST_PROVIDER_ID);
    expect(built.nigerian?.state().specialistProviderId).toBe(NIGERIAN_SPECIALIST_PROVIDER_ID);
    expect(built.nigerian?.state().specialistConfigured).toBe(true);
  });

  it('routes exactly the four languages ai-registry lists, and nothing else', () => {
    const built = buildLiveSynthesis(CONFIG, envFrom(), noFetch);
    const name = built.provider?.name ?? '';
    const routed = /routed\(([^ ]*) -> /u.exec(name)?.[1]?.split(',') ?? [];
    expect([...routed].sort()).toEqual([...NIGERIAN_SPECIALIST_LANGUAGES].sort());
  });

  it('puts behind it exactly what NIGERIAN_TTS_ROUTE_ORDER puts behind it', () => {
    const built = buildLiveSynthesis(CONFIG, envFrom(), noFetch);
    const branch = nigerianBranch(built.provider?.name ?? '');
    const behind = NIGERIAN_TTS_ROUTE_ORDER.slice(1);

    if (behind.length === 0) {
      // Today's ruling: one entry, so a failure is SILENCE. That is the
      // founder's preference over audio that mispronounces the language, and
      // the name has to say it out loud rather than imply it by omission.
      expect(branch).toContain('NOTHING');
    } else {
      for (const providerId of behind) expect(branch).toContain(providerId);
    }
  });

  it('never lets the REJECTED vendor reach these languages, even fully configured', () => {
    /*
     * THE DEFECT THIS REPLACES, EXACTLY. Azure is configured here, as it is in
     * production, and the general chain uses it. Before this fix the four
     * languages resolved to `azure-speech:tts-northeurope` on the live box
     * while every test was green.
     */
    const built = buildLiveSynthesis(CONFIG, envFrom(), noFetch);
    const branch = nigerianBranch(built.provider?.name ?? '');
    expect(branch).not.toContain(NIGERIAN_FALLBACK_PROVIDER_ID);

    // And the general chain is untouched for the other ninety languages: this
    // is a per-language route, not a whole-deployment choice.
    expect(built.provider?.name).toContain(NIGERIAN_FALLBACK_PROVIDER_ID);
  });

  it('warmth is TRUE for a vendor that cannot go cold', () => {
    /*
     * NOT COSMETIC. `liveRouteEligibility` refuses a live Nigerian route unless
     * warmth is guaranteed, so reporting false here -- for a vendor that does
     * not scale to zero -- would block every Nigerian programme forever against
     * a risk that cannot occur.
     */
    const built = buildLiveSynthesis(CONFIG, envFrom(), noFetch);
    expect(built.nigerian?.warm).toBe(true);
  });
});

describe('with no approved voice, these languages FAIL rather than being faked', () => {
  const NO_APPROVED = {
    AZURE_SPEECH_KEY: 'az-key',
    AZURE_SPEECH_REGION: 'northeurope',
    AZURE_DEFAULT_VOICE_ID: 'en-US-JennyNeural',
  };

  it('WARNS at boot, names the missing variables and the four languages', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const built = buildLiveSynthesis(
        { streamingSynthesisProvider: 'azure' },
        readLiveProviderEnv(NO_APPROVED as NodeJS.ProcessEnv),
        noFetch,
      );
      const logged = warn.mock.calls.join(' ');
      expect(logged).toContain(NIGERIAN_SPECIALIST_PROVIDER_ID);
      expect(logged).toMatch(/NOT configured/u);
      for (const language of NIGERIAN_SPECIALIST_LANGUAGES) {
        expect(logged, language).toContain(language);
      }
      expect(built.nigerian?.state().specialistConfigured).toBe(false);
      expect(built.nigerian?.state().degraded).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('produces NO audio and an error, instead of letting the rejected vendor speak', async () => {
    /*
     * THE WHOLE RULING, IN ONE ASSERTION. Azure is configured and would answer
     * 200 with fluent, wrongly-pronounced Yoruba. Silence that reports itself
     * beats a success nobody in the room can check.
     */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const built = buildLiveSynthesis(
        { streamingSynthesisProvider: 'azure' },
        readLiveProviderEnv(NO_APPROVED as NodeJS.ProcessEnv),
        noFetch,
      );
      const errors: Error[] = [];
      const result = await built.provider?.synthesize({
        text: 'Bawo ni',
        targetLanguage: 'yo',
        voiceId: 'female-1',
        onChunk: () => {
          throw new Error('nothing may be spoken without an approved voice');
        },
        onError: (error) => errors.push(error),
      });

      expect(result?.samples).toBe(0);
      expect(errors[0]?.message).toContain('NOT spoken');
      // It names what to set, so the reader can act rather than investigate.
      expect(errors[0]?.message).toContain('ELEVENLABS_API_KEY');
    } finally {
      warn.mockRestore();
    }
  });

  it('says these languages cannot be spoken, not that they are spoken badly', () => {
    // Two different emergencies. One is a quality complaint; the other is
    // silence in a live broadcast, and the text has to distinguish them.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const built = buildLiveSynthesis(
        { streamingSynthesisProvider: 'azure' },
        readLiveProviderEnv(NO_APPROVED as NodeJS.ProcessEnv),
        noFetch,
      );
      expect(built.nigerian?.state().degradedReason).toMatch(/CANNOT BE SPOKEN/u);
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

describe('selecting a vendor is a lookup, which is what makes the ruling reach here', () => {
  it('builds NO warm keeper for a vendor that cannot go cold', () => {
    /*
     * A KEEPER IS NOT A GENERAL NICETY. Against a vendor that is always up it
     * is an unread request every four minutes on somebody's bill, forever, and
     * it would report warmth as something this deployment achieved rather than
     * something the vendor never lacked. `warm-keeper-join` proves the opposite
     * case for a vendor that does sleep.
     */
    const selection = selectNigerianVoice(NIGERIAN_SPECIALIST_PROVIDER_ID, envFrom(), noFetch);
    expect(selection.kind).toBe('built');
    if (selection.kind === 'built') expect(selection.build.warmKeeper).toBeNull();
  });

  it('refuses a vendor it has no builder for, by name, at startup', () => {
    // A constant changed without a builder added is a programming error. The
    // failure mode of tolerating it is these four languages quietly rejoining
    // the general chain, which is the defect this seam exists to close.
    expect(() => selectNigerianVoice('a-vendor-nobody-wrote', envFrom(), noFetch)).toThrow(
      /no builder/u,
    );
  });

  it('reports an unconfigured vendor as unconfigured, naming its variables', () => {
    const selection = selectNigerianVoice(
      NIGERIAN_SPECIALIST_PROVIDER_ID,
      readLiveProviderEnv({} as NodeJS.ProcessEnv),
      noFetch,
    );
    expect(selection.kind).toBe('unconfigured');
    if (selection.kind === 'unconfigured') {
      expect(selection.missing.length).toBeGreaterThan(0);
      // NAMES, never values: this text reaches logs.
      for (const name of selection.missing) expect(name).toMatch(/^[A-Z0-9_]+$/u);
    }
  });

  it('keeps the previous specialist BUILDABLE though nothing routes to it', () => {
    /*
     * A DELIBERATE DECISION, recorded as a test so it is not mistaken for
     * dead code and deleted. 9jaLingo is the only working implementation this
     * repository has of a vendor whose capacity SCALES TO ZERO -- a shape that
     * cost a measured staging programme on 2026-08-31 -- and its warm keeper is
     * the lesson from that day.
     */
    expect(Object.keys(NIGERIAN_VOICE_VENDORS)).toContain('naijalingo');
    const selection = selectNigerianVoice(
      'naijalingo',
      envFrom({ NAIJALINGO_API_KEY: 'k' }),
      noFetch,
    );
    expect(selection.kind).toBe('built');
    if (selection.kind === 'built') {
      // The keeper exists ONLY for a vendor that can go cold, so its presence
      // here and its absence for the approved voice are both the point.
      expect(selection.build.warmKeeper).not.toBeNull();
    }
  });

  it('still refuses a 9jaLingo response format it does not understand', () => {
    // Loud, at boot. The alternative is a vendor 4xx during a session.
    expect(() =>
      selectNigerianVoice(
        'naijalingo',
        envFrom({ NAIJALINGO_API_KEY: 'k', NAIJALINGO_RESPONSE_FORMAT: 'mp3' }),
        noFetch,
      ),
    ).toThrow(/NAIJALINGO_RESPONSE_FORMAT/u);
  });

  it('survives the blank lines a template ships with', () => {
    // `ELEVENLABS_VOICE_IDS=` is the NORMAL state of an unconfigured box, not a
    // deliberate choice of the empty mapping.
    const built = buildLiveSynthesis(
      CONFIG,
      envFrom({ ELEVENLABS_VOICE_IDS: '   ', ELEVENLABS_MODEL: '' }),
      noFetch,
    );
    expect(built.nigerian?.state().specialistConfigured).toBe(true);
  });
});

describe('the boot preflight asks the vendor that is actually routed', () => {
  it('reports an ABSENT credential as absent, without attempting a request', async () => {
    let attempted = false;
    const fetchImpl = (async () => {
      attempted = true;
      return new Response('{}');
    }) as unknown as typeof fetch;

    const preflight = await preflightNigerianSpecialist(
      readLiveProviderEnv({} as NodeJS.ProcessEnv),
      fetchImpl,
    );
    expect(preflight.providerId).toBe(NIGERIAN_SPECIALIST_PROVIDER_ID);
    expect(preflight.keyConfigured).toBe(false);
    // Absent and rejected need opposite actions; no request is made at all, so
    // nothing in a log can be mistaken for a rejection.
    expect(attempted).toBe(false);
    // Reported as unserved rather than as "no problems found".
    expect([...preflight.languagesWithoutSpeakers].sort()).toEqual(
      [...NIGERIAN_SPECIALIST_LANGUAGES].sort(),
    );
  });

  it('is satisfied when the configured voice is really in the account', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ voices: [{ voice_id: 'el-voice' }] }), {
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const preflight = await preflightNigerianSpecialist(envFrom(), fetchImpl);
    expect(preflight.reachable).toBe(true);
    expect(preflight.problem).toBeNull();
    expect(preflight.languagesWithoutSpeakers).toEqual([]);
  });

  it('catches the quiet failure: a valid key whose account lacks the voice', async () => {
    /*
     * THE ONE THIS EXISTS FOR. It answers 200 to every check a deployment
     * normally runs and 400 to the first sentence of a broadcast, which is the
     * worst possible moment to find out.
     */
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ voices: [{ voice_id: 'somebody-elses-voice' }] }), {
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const preflight = await preflightNigerianSpecialist(envFrom(), fetchImpl);
    expect(preflight.reachable).toBe(true);
    expect(preflight.problem).toMatch(/not in this account/u);
    expect([...preflight.languagesWithoutSpeakers].sort()).toEqual(
      [...NIGERIAN_SPECIALIST_LANGUAGES].sort(),
    );
  });

  it('a SCOPED key is reported as working, with the catalogue marked unchecked', async () => {
    /*
     * MEASURED IN PRODUCTION, 18 Sep 2026, and this preflight's own first
     * defect. The key there is scoped to synthesis alone, so `/v1/voices`
     * answers 401 `missing_permissions` while a real Yoruba sentence answers
     * 200 with a second of audio. Reported as unreachable it marked a working
     * vendor unhealthy on /health and blocked the live Nigerian routes -- a
     * check that invented its own outage. A narrow key is good practice.
     */
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          detail: { status: 'missing_permissions', message: 'missing the permission voices_read' },
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof fetch;

    const preflight = await preflightNigerianSpecialist(envFrom(), fetchImpl);
    expect(preflight.keyConfigured).toBe(true);
    expect(preflight.reachable).toBe(true);
    expect(preflight.problem).toBeNull();
    // Nothing was learned, so nothing is claimed in either direction.
    expect(preflight.voiceCatalogueChecked).toBe(false);
    expect(preflight.languagesWithoutSpeakers).toEqual([]);
  });

  it('a genuinely rejected credential is still a failure, not a scope note', async () => {
    // The distinction is the point: one is a narrow key, the other is nothing
    // being spoken at all, and they must not read the same.
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ detail: { status: 'invalid_api_key' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const preflight = await preflightNigerianSpecialist(envFrom(), fetchImpl);
    expect(preflight.reachable).toBe(false);
    expect(preflight.problem).toMatch(/REJECTED/u);
  });

  it('never carries a credential into its report', async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = (async (url: unknown, init: unknown) => {
      seen.push({
        url: String(url),
        headers: (init as RequestInit).headers as Record<string, string>,
      });
      return new Response(JSON.stringify({ voices: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const preflight = await preflightNigerianSpecialist(
      envFrom({ ELEVENLABS_API_KEY: 'super-secret-value' }),
      fetchImpl,
    );
    expect(seen[0]?.url).toMatch(/\/v1\/voices$/u);
    expect(seen[0]?.headers['xi-api-key']).toBe('super-secret-value');
    // A preflight that leaked its key into a boot log would be a worse failure
    // than the one it exists to catch.
    expect(JSON.stringify(preflight)).not.toContain('super-secret-value');
  });

  it('reports a vendor that cannot be reached as unreachable, not as absent', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const preflight = await preflightNigerianSpecialist(envFrom(), fetchImpl);
    expect(preflight.keyConfigured).toBe(true);
    expect(preflight.reachable).toBe(false);
    expect(preflight.problem).toMatch(/could not be reached/u);
  });
});
