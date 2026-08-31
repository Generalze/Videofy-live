/** @author masterzee001 */
/**
 * The gate, as a provider. Every translation path gets it, because it wraps the
 * thing they all already call.
 *
 * WHY A WRAPPER AND NOT A CHECK AT EACH CALL SITE. There are two execution
 * paths today -- the live pipeline and the internal-text route -- and editing
 * both leaves the rule true only for as long as nobody adds a third. This
 * project's most expensive recurring defect is precisely a rule that exists
 * somewhere and is not reached from where it matters, six times and counting.
 * A wrapper makes bypassing the gate impossible rather than merely
 * discouraged: to translate at all you must hold a provider, and the provider
 * you hold is this one.
 *
 * THE INNER PROVIDER IS NEVER INVOKED FOR A REFUSED ROUTE. Not once, not
 * "harmlessly". That is asserted with a spy in the integration tests, because
 * "the engine ran but we discarded the result" is still a paid call, a latency
 * cost, and a translation sitting in somebody's provider logs.
 *
 * WHAT COMES BACK WHEN IT REFUSES: the original text. Never an empty string,
 * never a throw that a caller might turn into a dropped message. A message that
 * arrives untranslated is a translation problem; one that does not arrive is a
 * messaging problem, and the second is worse.
 */

import type {
  TimestampedTranslationProvider,
  TranslationProviderInput,
  TranslationProviderResult,
} from './translation-provider.js';
import type { createTranslationGate } from './translation-gate.js';

export type Gate = ReturnType<typeof createTranslationGate>;

/** Told what happened, so /health and billing see the same truth the caller does. */
export interface GateObserver {
  (outcome: {
    readonly action: 'translate' | 'bypass' | 'unavailable';
    readonly reason?: string;
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly billable: boolean;
    readonly billingKey?: string;
    /** Identifiers the engine failed to give back. Empty is the only good value. */
    readonly corruptedIdentifiers?: readonly string[];
  }): void;
}

export interface GatedTranslationOptions {
  readonly inner: TimestampedTranslationProvider;
  readonly gate: Gate;
  readonly onOutcome?: GateObserver;
}

export class GatedTranslationProvider implements TimestampedTranslationProvider {
  readonly name: string;

  constructor(private readonly options: GatedTranslationOptions) {
    this.name = `gated:${options.inner.name}`;
  }

  async translate(input: TranslationProviderInput): Promise<TranslationProviderResult> {
    const decision = this.options.gate.decide({
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      text: input.sourceText,
      identity: {
        sessionId: input.sessionId,
        segmentId: input.segmentId,
        // The REVISION, not an attempt counter. A retry of one final shares it;
        // a corrected final does not, and must not be collapsed into the old one.
        revision: input.sequence,
      },
    });

    if (decision.action !== 'translate') {
      this.options.onOutcome?.({
        action: decision.action,
        reason: decision.reason,
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
        billable: false,
      });
      // The inner provider is not called. Not for empty input, not for emoji,
      // not for an unapproved route, not for text past the certified limit.
      return { translatedText: decision.deliver, providerName: this.name };
    }

    let result: TranslationProviderResult;
    try {
      result = await this.options.inner.translate({
        ...input,
        // Identifiers masked. The engine never sees a phone number it can round.
        sourceText: decision.textForEngine,
      });
    } catch (error) {
      const why = error instanceof Error ? error.message : 'unknown provider failure';
      const failed = this.options.gate.failed(input.sourceText, 'provider-failed', why);
      this.options.onOutcome?.({
        action: 'unavailable',
        reason: 'provider-failed',
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
        billable: false,
      });
      return { translatedText: failed.deliver, providerName: this.name };
    }

    const restored = decision.restore(result.translatedText);

    /*
     * AN ENGINE THAT LOST AN IDENTIFIER HAS NOT TRANSLATED THIS MESSAGE.
     * OPUS-MT turned 08031234567 into 08031,32367 in the Phase-1 screen. A
     * translation missing or mangling a phone number, an OTP or an account
     * number is worse than no translation, because it looks complete. The
     * original goes out instead, and it is not charged for.
     */
    if (restored.corrupted.length > 0) {
      this.options.onOutcome?.({
        action: 'unavailable',
        reason: 'identifier-corrupted',
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
        billable: false,
        corruptedIdentifiers: restored.corrupted,
      });
      return { translatedText: input.sourceText, providerName: this.name };
    }

    this.options.onOutcome?.({
      action: 'translate',
      sourceLanguage: input.sourceLanguage,
      targetLanguage: input.targetLanguage,
      billable: true,
      billingKey: decision.billingKey,
      corruptedIdentifiers: [],
    });
    return {
      ...result,
      translatedText: restored.text,
      providerName: result.providerName ?? decision.provider ?? this.options.inner.name,
    };
  }

  async healthCheck() {
    return this.options.inner.healthCheck?.() ?? {
      provider: this.name,
      status: 'ready' as const,
      modelId: null,
      latencyMs: null,
      error: null,
    };
  }

  dispose(): void {
    this.options.inner.dispose?.();
  }
}
