/** @author masterzee001 */
/**
 * Hausa, Igbo, Yoruba and Nigerian Pidgin: the APPROVED voice, then whatever
 * `NIGERIAN_TTS_ROUTE_ORDER` puts behind it -- and every fall-through says so
 * out loud.
 *
 * SINCE 2026-09-18 THAT ORDER HAS ONE ENTRY. ElevenLabs is the approved voice
 * by founder ruling, and nothing is behind it: silence is the honest outcome
 * when it cannot answer. This module keeps the fall-through machinery anyway,
 * because the thing it makes visible is a property of the SITUATION, not of a
 * vendor -- if a second entry ever appears, the mark it leaves has to already
 * work.
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
 * THE CHAIN IS NAMED, AND NOT "THE GENERAL CHAIN". Putting the whole general
 * chain behind the approved voice reads as caution and is the opposite: it buys
 * a SECOND wrong rendering rather than a second chance, and it means a later
 * change to the general chain silently changes who speaks Yoruba. The order
 * comes from `ai-registry`'s `NIGERIAN_TTS_ROUTE_ORDER` rather than from a copy
 * here -- which is exactly the seam that stayed unwired for three weeks after
 * the 2026-09-18 ruling: the LANGUAGES were imported and the VENDOR was
 * restated, so changing the constant moved nothing.
 *
 * IT DOES NOT RE-IMPLEMENT THE FALL-THROUGH. `createFallbackSpeechSynthesisProvider`
 * already owns the rule that matters -- a provider that has emitted audio is
 * never replaced, because half a sentence in one voice followed by the whole
 * sentence in another is worse than either. This wraps that; it does not
 * restate it.
 *
 * WHAT IT WILL NOT CLAIM. `rendering: 'specialist'` says the approved vendor
 * answered. It does NOT say the Yoruba was good. Nothing in this repository is
 * entitled to infer language quality from a status code, and this module is the
 * one most tempted to, so it says so here.
 */
import {
  NIGERIAN_FALLBACK_PROVIDER_ID,
  NIGERIAN_SPECIALIST_LANGUAGES,
  NIGERIAN_SPECIALIST_PROVIDER_ID,
} from '@videofy-live/ai-registry';
import { createFallbackSpeechSynthesisProvider } from './fallback-speech-synthesis-provider.js';
import type { FallbackSynthesisObservation } from './fallback-speech-synthesis-provider.js';
import { baseLanguage } from './language-routed-synthesis-provider.js';
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

/**
 * What a boot check found out about the APPROVED voice, whoever it currently is.
 *
 * VENDOR-NEUTRAL ON PURPOSE, and that is a correction. This used to be
 * `NaijaLingoPreflight`, so the type of the report named the vendor -- which
 * meant that changing which vendor is approved left every surface reporting on
 * one that is no longer routed. The report has to survive the ruling it
 * describes.
 *
 * `engineReady` stays because a vendor whose capacity scales to zero has a
 * readiness that is NOT its reachability, and that distinction cost a measured
 * demo on 2026-08-31. A vendor without one answers null rather than true:
 * "there is nothing to be asleep" and "it is awake" are different claims.
 */
export interface NigerianVoicePreflight {
  /** Who was asked. Never inferred by a reader from the shape of the answer. */
  readonly providerId: string;
  /** False when no credential is configured. No request is attempted then. */
  readonly keyConfigured: boolean;
  readonly reachable: boolean;
  /**
   * Whether the voice catalogue was actually READ, as opposed to assumed good.
   *
   * FALSE IS A THIRD STATE, not a failure, and conflating it with either
   * neighbour is a mistake this file made on its first day. Production's
   * ElevenLabs key is scoped to synthesis alone: `GET /v1/voices` answers 401
   * `missing_permissions`, the key is perfectly valid, and synthesis works.
   * Reported as unreachable it marked a healthy vendor unhealthy and blocked
   * the live Nigerian routes; reported as verified it would claim a check that
   * never happened. So it says which, and the surfaces that read it say
   * "not checked" in those words.
   */
  readonly voiceCatalogueChecked: boolean;
  /**
   * Whether this deployment can actually SPEAK A WORD, asked by speaking one.
   *
   * THE ONLY QUESTION THAT MATTERED, AND THE ONE NOBODY ASKED. Measured in
   * production on 2 Oct 2026: `GET /v1/voices` answered 200 with 29 voices,
   * the boot line read "elevenlabs preflight: reachable, 29 voice(s) in
   * account", and every sentence of every translated call came back 401
   * `payment_issue` -- the subscription had a failed payment. Captions
   * worked, audio did not, and the health surface said the vendor was fine
   * for as long as nobody placed a call.
   *
   * Listing a catalogue and synthesising are different permissions and, as
   * this showed, different billing states. A check that only reads cannot
   * fail in the way that takes the product down, which is the definition of
   * a check that cannot fail.
   *
   * Null means the probe was not attempted or could not be judged. False is
   * a deployment that will produce captions and silence.
   */
  readonly canSynthesise: boolean | null;
  /** Why synthesis is refused, in the vendor's own words. Never the key. */
  readonly synthesisProblem: string | null;
  /** Null when the vendor has no readiness concept, or did not answer. */
  readonly engineReady: boolean | null;
  readonly totalSpeakers: number | null;
  readonly speakerIdsByLanguage: Readonly<Record<string, readonly string[]>>;
  /** Routed languages this credential can produce NO voice for. */
  readonly languagesWithoutSpeakers: readonly string[];
  /** Null when everything answered. Never contains a key or any value of one. */
  readonly problem: string | null;
}

export interface NigerianSynthesisState {
  /**
   * False when the APPROVED vendor has no credential configured.
   *
   * Since 2026-09-18 that also means these four languages are not spoken AT
   * ALL, rather than spoken badly: the ruling forbids routing them to the
   * vendor that mispronounces them, so the honest outcome is silence.
   */
  readonly specialistConfigured: boolean;
  readonly specialistProviderId: string;
  readonly fallbackProviderId: string;
  readonly languages: readonly string[];
  readonly renderingByLanguage: Readonly<Record<string, NigerianRendering>>;
  readonly specialistSentences: number;
  readonly degradedSentences: number;
  /** Null until the preflight has run. Never contains a key or a value of one. */
  readonly preflight: NigerianVoicePreflight | null;
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
   * WHATEVER `NIGERIAN_TTS_ROUTE_ORDER` NAMES AFTER THE FIRST ENTRY -- and
   * since 2026-09-18 that is nothing, so this is null in production.
   *
   * NULL IS A REAL AND HONEST STATE, not an omission: the chain is the approved
   * voice alone. It must NOT be filled in with the approved voice itself --
   * that would call the same vendor twice for one sentence, doubling the wait
   * at the exact moment the listener is already waiting, and it would report a
   * fall-through onto the provider that had just failed.
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
  recordPreflight(preflight: NigerianVoicePreflight): void;
}

function blankRenderings(): Record<string, NigerianRendering> {
  const map: Record<string, NigerianRendering> = {};
  for (const language of NIGERIAN_SPECIALIST_LANGUAGES) map[language] = 'not-attempted';
  return map;
}

/**
 * The state to report when there is no specialist to route to.
 *
 * NOT AN OMISSION -- a deployment without a credential still has to say what
 * happens to these four languages. Reporting nothing here would make "no key"
 * look like "nothing to report", which is the exact confusion this wave exists
 * to end.
 *
 * AND THE ANSWER CHANGED ON 2026-09-18. It used to be "every sentence is spoken
 * badly by Azure"; it is now "no sentence is spoken at all", because the ruling
 * refuses the vendor that mispronounces them. Both are bad states. They need
 * completely different actions -- one is a quality complaint, the other is
 * silence in a live broadcast -- so the text says which.
 */
export function absentSpecialistState(
  preflight: NigerianVoicePreflight | null = null,
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
      `no ${NIGERIAN_SPECIALIST_PROVIDER_ID} credential is configured, so ` +
      `${NIGERIAN_SPECIALIST_LANGUAGES.join('/')} CANNOT BE SPOKEN. They are not routed to ` +
      `${NIGERIAN_FALLBACK_PROVIDER_ID}, which returns 200 and mispronounces them; the founder ` +
      'ruling of 2026-09-18 is that silence is the honest outcome and wrong pronunciation is not.',
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
  let preflight: NigerianVoicePreflight | null = null;

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
    recordPreflight(next: NigerianVoicePreflight): void {
      preflight = next;
    },
  };
}
