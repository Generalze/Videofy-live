/** @author masterzee001 */
/**
 * Ask ElevenLabs, before anybody needs an answer, whether this deployment can
 * actually speak.
 *
 * WHY THIS EXISTS AT ALL. Until the founder ruling of 2026-09-18 the Nigerian
 * languages were served by a specialist whose capacity scaled to zero, so the
 * boot check that mattered was "is the vendor awake". ElevenLabs does not scale
 * to zero, and the question that replaces it is narrower and just as quiet: a
 * key that is valid but whose account does NOT contain the voice id this
 * deployment is configured to use. That combination returns 200 on `/v1/voices`
 * and 400 on the first sentence of a broadcast, which is the worst possible
 * moment to discover it.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM. Nothing here is evidence that the Yoruba
 * is GOOD. Voice quality in ha/ig/yo/pcm was settled by a person listening --
 * see `NIGERIAN_SPECIALIST_PROVIDER_ID` in ai-registry -- and no endpoint can
 * re-decide it. This answers "can it speak at all", and says so in those words.
 *
 * NEVER THROWS, and never names a value. It reports; the caller decides. A
 * preflight that could fail a boot would turn a vendor's outage into ours.
 */
import type { NigerianVoicePreflight } from '../../nigerian-synthesis-route.js';

export interface ElevenLabsPreflightConfig {
  readonly apiKey?: string | undefined;
  readonly baseUrl?: string | undefined;
  /** The vendor voice every unmapped platform voice falls back to. */
  readonly defaultVoiceId?: string | undefined;
  /** Every other vendor voice this deployment can reach, from ELEVENLABS_VOICE_IDS. */
  readonly mappedVoiceIds?: readonly string[] | undefined;
  /** Which languages this preflight is reporting FOR. */
  readonly languages: readonly string[];
  readonly providerId: string;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly signal?: AbortSignal | undefined;
}

interface VoicesResponse {
  readonly voices?: readonly { readonly voice_id?: unknown }[];
}

/**
 * A report shaped for the Nigerian seam, because that is the surface that has
 * to be able to say who speaks these four languages and whether it can.
 */
export async function preflightElevenLabsVoices(
  config: ElevenLabsPreflightConfig,
): Promise<NigerianVoicePreflight> {
  const languages = [...config.languages];
  const apiKey = config.apiKey?.trim() ?? '';
  const defaultVoiceId = config.defaultVoiceId?.trim() ?? '';

  /*
   * AN ABSENT KEY IS REPORTED AS ABSENT, not as a failed request, and no
   * network call is made at all. The two need opposite actions -- paste a key
   * versus chase a vendor -- and a log line that confuses them costs an
   * afternoon.
   */
  if (apiKey.length === 0) {
    return {
      providerId: config.providerId,
      keyConfigured: false,
      reachable: false,
      engineReady: null,
      totalSpeakers: null,
      speakerIdsByLanguage: {},
      languagesWithoutSpeakers: languages,
      problem: null,
    };
  }

  const base = (config.baseUrl ?? 'https://api.elevenlabs.io').replace(/\/+$/u, '');
  const doFetch = config.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(`${base}/v1/voices`, {
      headers: { 'xi-api-key': apiKey, accept: 'application/json' },
      ...(config.signal === undefined ? {} : { signal: config.signal }),
    });
  } catch (error) {
    return {
      providerId: config.providerId,
      keyConfigured: true,
      reachable: false,
      engineReady: null,
      totalSpeakers: null,
      speakerIdsByLanguage: {},
      languagesWithoutSpeakers: languages,
      problem: `could not be reached: ${error instanceof Error ? error.message : 'unknown failure'}`,
    };
  }

  if (!response.ok) {
    return {
      providerId: config.providerId,
      keyConfigured: true,
      reachable: false,
      engineReady: null,
      totalSpeakers: null,
      speakerIdsByLanguage: {},
      languagesWithoutSpeakers: languages,
      // The STATUS, never the body: a rejected request can echo what it rejected.
      problem: `/v1/voices answered ${response.status}`,
    };
  }

  let body: VoicesResponse;
  try {
    body = (await response.json()) as VoicesResponse;
  } catch {
    return {
      providerId: config.providerId,
      keyConfigured: true,
      reachable: true,
      engineReady: null,
      totalSpeakers: null,
      speakerIdsByLanguage: {},
      languagesWithoutSpeakers: languages,
      problem: '/v1/voices answered 200 with something that is not JSON',
    };
  }

  const available = new Set(
    (body.voices ?? [])
      .map((voice) => (typeof voice.voice_id === 'string' ? voice.voice_id : null))
      .filter((id): id is string => id !== null),
  );

  /*
   * EVERY VOICE THIS DEPLOYMENT CAN REACH, not just the default. A mapped voice
   * that is missing from the account is invisible until the one participant who
   * chose it speaks -- which on a call is a single person hearing silence while
   * everyone else is fine, the hardest shape of bug to have reported to you.
   */
  const reachableVoices = [defaultVoiceId, ...(config.mappedVoiceIds ?? [])].filter(
    (id) => id.length > 0,
  );
  const missing = [...new Set(reachableVoices.filter((id) => !available.has(id)))];

  /*
   * The default voice is what these four languages actually use, so its absence
   * -- and only its absence -- means they cannot be spoken at all.
   */
  const defaultUsable = defaultVoiceId.length > 0 && available.has(defaultVoiceId);
  const speakerIdsByLanguage: Record<string, readonly string[]> = {};
  for (const language of languages) {
    speakerIdsByLanguage[language] = defaultUsable ? [defaultVoiceId] : [];
  }

  return {
    providerId: config.providerId,
    keyConfigured: true,
    reachable: true,
    // ElevenLabs has no readiness flag: it does not scale to zero, which is the
    // whole reason this replaced a vendor that did.
    engineReady: null,
    totalSpeakers: available.size,
    speakerIdsByLanguage,
    languagesWithoutSpeakers: defaultUsable ? [] : languages,
    problem:
      missing.length === 0
        ? null
        : `${missing.length} configured voice id(s) are not in this account, so any sentence ` +
          'that reaches them fails mid-session',
  };
}

/** One line, for a boot log. Contains no credential and no value of one. */
export function describeNigerianVoicePreflight(preflight: NigerianVoicePreflight): string {
  const who = preflight.providerId;
  if (!preflight.keyConfigured) {
    return `${who} preflight: key absent — ha/ig/yo/pcm CANNOT be spoken by the approved voice`;
  }
  if (!preflight.reachable) {
    return `${who} preflight: NOT reachable — ${preflight.problem ?? 'unknown'}`;
  }
  const counts = Object.entries(preflight.speakerIdsByLanguage)
    .map(([language, ids]) => `${language}=${ids.length}`)
    .join(' ');
  const voices = preflight.totalSpeakers ?? 0;
  const tail = preflight.problem === null ? '' : ` — ${preflight.problem}`;
  return `${who} preflight: reachable, ${voices} voice(s) in account, ${counts}${tail}`;
}
