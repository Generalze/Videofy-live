/** @author masterzee001 */
/**
 * Hausa, Igbo, Yoruba and Nigerian Pidgin: the specialist, then Azure, then
 * NOTHING -- and every fall-through says so out loud.
 *
 * WHY THIS IS A MODULE AND NOT THREE LINES OF WIRING. The chain itself is
 * trivial: two providers in order. What is not trivial is the part everybody
 * skips, which is making the second one VISIBLE. A synthesis fallback is the
 * only degradation in this pipeline that produces no signal at all -- audio
 * plays, the status is 200, the latency is normal, the byte count is plausible
 * -- so a specialist that has quietly stopped answering looks exactly like a
 * specialist that is working. The 2026-08-26 listening test is the evidence:
 * both general vendors answer Yoruba, Hausa and Igbo with confident, wrong
 * audio. A reviewer who does not speak the language cannot hear the difference;
 * neither can a health check. Only a mark on the result can.
 *
 * THE CHAIN IS AZURE, NAMED, AND NOT "THE GENERAL CHAIN". Founder ruling of
 * 2026-08-30. The previous wiring put the whole ElevenLabs-then-Azure chain
 * behind the specialist, which reads as caution and is the opposite: it buys a
 * SECOND wrong rendering rather than a second chance, and it means a later
 * change to the general chain silently changes who speaks Yoruba. One named
 * fallback is enough to avoid silence, and the order comes from
 * `ai-registry`'s `NIGERIAN_TTS_ROUTE_ORDER` rather than from a copy here.
 *
 * IT DOES NOT RE-IMPLEMENT THE FALL-THROUGH. `createFallbackSpeechSynthesisProvider`
 * already owns the rule that matters -- a provider that has emitted audio is
 * never replaced, because half a sentence in one voice followed by the whole
 * sentence in another is worse than either. This wraps that; it does not
 * restate it.
 *
 * WHAT IT WILL NOT CLAIM. `rendering: 'specialist'` says 9jaLingo answered. It
 * does NOT say the Yoruba was good. Nothing in this repository is entitled to
 * infer language quality from a status code, and this module is the one most
 * tempted to, so it says so here.
 */
import {
  NIGERIAN_FALLBACK_PROVIDER_ID,
  NIGERIAN_SPECIALIST_LANGUAGES,
  NIGERIAN_SPECIALIST_PROVIDER_ID,
} from '@videofy-live/ai-registry';
import { createFallbackSpeechSynthesisProvider } from './fallback-speech-synthesis-provider.js';
import type { FallbackSynthesisObservation } from './fallback-speech-synthesis-provider.js';
import { baseLanguage } from './language-routed-synthesis-provider.js';
import type { NaijaLingoPreflight } from './providers/naijalingo/streaming-tts.js';
import type {
  StreamingSpeechSynthesisProvider,
  StreamingSynthesisOptions,
  StreamingSynthesisResult,
  SynthesisDegradation,
} from './streaming-speech-synthesis-provider.js';

/**
 * How a specialist language was actually rendered.
 *
 * `not-attempted` is a real and common state -- most deployments run for hours
 * without a Yoruba sentence -- and it must not be reported as either success or
 * failure. Reporting "no problems" for a language nobody asked for is how a
 * broken specialist survives a demo.
 */
export type NigerianRendering =
  | 'not-attempted'
  | 'specialist'
  | 'degraded-fallback'
  | 'failed';

export interface NigerianSynthesisState {
  /** False when NAIJALINGO_API_KEY is absent: every sentence is degraded. */
  readonly specialistConfigured: boolean;
  readonly specialistProviderId: string;
  readonly fallbackProviderId: string;
  readonly languages: readonly string[];
  readonly renderingByLanguage: Readonly<Record<string, NigerianRendering>>;
  readonly specialistSentences: number;
  readonly degradedSentences: number;
  /** Null until the preflight has run. Never contains a key or a value of one. */
  readonly preflight: NaijaLingoPreflight | null;
  /**
   * The one-word answer a console can colour.
   *
   * True when the specialist is not configured at all, or when any sentence in
   * these four languages has been served by the fallback. It never goes back to
   * false: a listener already heard it.
   */
  readonly degraded: boolean;
  /** Why, in words. Empty when nothing is known to be wrong. */
  readonly degradedReason: string | null;
}

export interface NigerianSynthesisOutcome {
  readonly language: string;
  /** Null when every provider in the chain failed. */
  readonly servedBy: string | null;
  readonly rendering: NigerianRendering;
  readonly fellThrough: readonly string[];
  /** Set only for `degraded-fallback`. */
  readonly degradation: SynthesisDegradation | null;
}

export interface NigerianRouteOptions {
  readonly specialist: StreamingSpeechSynthesisProvider;
  /**
   * AZURE, by name and by ruling. Not "whatever the general chain resolves to".
   *
   * NULL IS A REAL AND HONEST STATE: a deployment with no Azure credential has
   * nothing behind the specialist, and the chain is the specialist alone. It
   * must NOT be filled in with the specialist itself -- that would call a cold
   * vendor twice for one sentence, doubling the wait at the exact moment the
   * listener is already waiting, and it would report a fall-through onto the
   * provider that had just failed.
   */
  readonly fallback: StreamingSpeechSynthesisProvider | null;
  /**
   * Told about EVERY sentence, not only the bad ones.
   *
   * A callback that only fires on degradation cannot distinguish "the
   * specialist is healthy" from "nobody has spoken Yoruba today", and those
   * need different actions.
   */
  readonly onOutcome?: (outcome: NigerianSynthesisOutcome) => void;
}

export interface NigerianSynthesisRoute {
  /** The chain to install for ha/ig/yo/pcm. */
  readonly provider: StreamingSpeechSynthesisProvider;
  /** A snapshot for /health and the operator console. Safe to serialise. */
  state(): NigerianSynthesisState;
  /** Record the boot preflight so the same state answers both questions. */
  recordPreflight(preflight: NaijaLingoPreflight): void;
}

function blankRenderings(): Record<string, NigerianRendering> {
  const map: Record<string, NigerianRendering> = {};
  for (const language of NIGERIAN_SPECIALIST_LANGUAGES) map[language] = 'not-attempted';
  return map;
}

/**
 * The state to report when there is no specialist to route to.
 *
 * NOT AN OMISSION -- a deployment without a key still has to say what happens
 * to these four languages, and the answer is that every sentence in them is a
 * degraded rendering. Reporting nothing here would make "no key" look like
 * "nothing to report", which is the exact confusion this wave exists to end.
 */
export function absentSpecialistState(
  preflight: NaijaLingoPreflight | null = null,
): NigerianSynthesisState {
  return {
    specialistConfigured: false,
    specialistProviderId: NIGERIAN_SPECIALIST_PROVIDER_ID,
    fallbackProviderId: NIGERIAN_FALLBACK_PROVIDER_ID,
    languages: NIGERIAN_SPECIALIST_LANGUAGES,
    renderingByLanguage: blankRenderings(),
    specialistSentences: 0,
    degradedSentences: 0,
    preflight,
    degraded: true,
    degradedReason:
      `no ${NIGERIAN_SPECIALIST_PROVIDER_ID} credential is configured, so every ` +
      `${NIGERIAN_SPECIALIST_LANGUAGES.join('/')} sentence is spoken by ` +
      `${NIGERIAN_FALLBACK_PROVIDER_ID}, which mispronounces them while returning 200.`,
  };
}

export function createNigerianSynthesisRoute(
  options: NigerianRouteOptions,
): NigerianSynthesisRoute {
  const specialistName = options.specialist.name;
  const fallbackName = options.fallback?.name ?? null;
  const providers =
    options.fallback === null ? [options.specialist] : [options.specialist, options.fallback];
  const renderings = blankRenderings();

  let specialistSentences = 0;
  let degradedSentences = 0;
  let degradedReason: string | null = null;
  let preflight: NaijaLingoPreflight | null = null;

  /*
   * Built PER CALL, and that is the only reason this is not two lines.
   * `createFallbackSpeechSynthesisProvider` takes its observer once, at
   * construction, so a single shared chain would hand concurrent sentences the
   * same observation slot and attribute one language's fall-through to
   * another's. A closure allocation is free next to a synthesis request; a
   * wrong degraded label is not, because it is the one signal nobody can check
   * by listening to the wrong language.
   */
  const chainFor = (
    seen: { observation: FallbackSynthesisObservation | null },
  ): StreamingSpeechSynthesisProvider =>
    createFallbackSpeechSynthesisProvider({
      providers,
      onObservation: (observation) => {
        seen.observation = observation;
      },
    });

  const provider: StreamingSpeechSynthesisProvider = {
    name: `nigerian(${specialistName}${fallbackName === null ? ' -> NOTHING' : ` -> ${fallbackName}`})`,

    async synthesize(request: StreamingSynthesisOptions): Promise<StreamingSynthesisResult> {
      const language = baseLanguage(request.targetLanguage);
      const seen: { observation: FallbackSynthesisObservation | null } = { observation: null };
      const result = await chainFor(seen).synthesize(request);
      const observation = seen.observation;
      const servedBy = observation?.servedBy ?? null;

      /*
       * ABORT IS NOT DEGRADATION. A superseded sentence was cancelled on
       * purpose, nobody heard it, and marking it degraded would fill the
       * console with alarms about audio that was never played.
       */
      if (result.aborted) {
        options.onOutcome?.({
          language,
          servedBy,
          rendering: renderings[language] ?? 'not-attempted',
          fellThrough: observation?.fellThrough ?? [],
          degradation: null,
        });
        return result;
      }

      if (servedBy === null) {
        renderings[language] = 'failed';
        options.onOutcome?.({
          language,
          servedBy: null,
          rendering: 'failed',
          fellThrough: observation?.fellThrough ?? [],
          degradation: null,
        });
        return result;
      }

      if (servedBy === specialistName) {
        specialistSentences += 1;
        renderings[language] = 'specialist';
        options.onOutcome?.({
          language,
          servedBy,
          rendering: 'specialist',
          fellThrough: observation?.fellThrough ?? [],
          degradation: null,
        });
        return result;
      }

      // The case this module exists for.
      degradedSentences += 1;
      renderings[language] = 'degraded-fallback';
      const fellThrough = observation?.fellThrough ?? [];
      const degradation: SynthesisDegradation = {
        language,
        expectedProvider: specialistName,
        servedBy,
        reason:
          `${specialistName} produced nothing` +
          (fellThrough.length > 0 ? ` (fell through: ${fellThrough.join(', ')})` : '') +
          `; ${servedBy} spoke instead and is known to mispronounce ${language}.`,
      };
      degradedReason = degradation.reason;
      options.onOutcome?.({
        language,
        servedBy,
        rendering: 'degraded-fallback',
        fellThrough,
        degradation,
      });
      return { ...result, degraded: degradation };
    },
  };

  return {
    provider,
    state(): NigerianSynthesisState {
      return {
        specialistConfigured: true,
        specialistProviderId: NIGERIAN_SPECIALIST_PROVIDER_ID,
        fallbackProviderId: NIGERIAN_FALLBACK_PROVIDER_ID,
        languages: NIGERIAN_SPECIALIST_LANGUAGES,
        renderingByLanguage: { ...renderings },
        specialistSentences,
        degradedSentences,
        preflight,
        degraded: degradedSentences > 0,
        degradedReason,
      };
    },
    recordPreflight(next: NaijaLingoPreflight): void {
      preflight = next;
    },
  };
}
