/** @author masterzee001 */
/**
 * The account service's line to the voice-note translation engine.
 *
 * Same boundary as translation-client.ts, same token, same rule: media-ingest
 * owns every provider and this service holds no vendor credentials. It sends
 * the original recording and a language pair, and gets back a rendering --
 * translated text plus spoken audio -- or nothing.
 *
 * FAILURE DELIVERS THE ORIGINAL. A voice note is stored and playable before
 * this is ever called, so every failure here -- timeout, refusal, a stage the
 * engine could not complete -- resolves to null and the note goes out as
 * recorded. The stage name is surfaced for the event log; never any content.
 */

import type { ApprovedRoute } from './translation-client.js';

export interface VoiceNoteRendering {
  readonly translatedText: string;
  readonly audio: Buffer;
  readonly mime: string;
  readonly durationMs: number;
}

export type VoiceNoteTranslationOutcome =
  | { readonly ok: true; readonly rendering: VoiceNoteRendering }
  | { readonly ok: false; readonly stage: string };

export interface VoiceNoteTranslator {
  translate(input: {
    readonly audio: Buffer;
    readonly mime: string;
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly durationMs: number;
    /**
     * The route the registry approved for the TRANSLATION STAGE of this
     * note. Recognition and speech are separately certified stages owned by
     * media-ingest; this names only the middle one, which is what the
     * messaging ruling governs.
     */
    readonly route: ApprovedRoute;
  }): Promise<VoiceNoteTranslationOutcome>;
}

/*
 * Three vendor stages in a row for up to two minutes of speech. Tight here
 * would only turn slow successes into silent originals, as the text client's
 * matrix showed at a quarter of this.
 */
const TRANSLATE_TIMEOUT_MS = 60_000;

export function createVoiceNoteTranslator(options: {
  readonly mediaIngestUrl: string | undefined;
  readonly internalToken: string | undefined;
  readonly fetchImpl?: typeof fetch;
}): VoiceNoteTranslator {
  const base = options.mediaIngestUrl?.replace(/\/+$/, '') ?? null;
  const token = options.internalToken ?? null;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return {
    async translate(input) {
      if (base === null || token === null) return { ok: false, stage: 'unconfigured' };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);
      try {
        const response = await fetchImpl(`${base}/internal/voice-translation`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Videofy-Internal-Token': token,
          },
          body: JSON.stringify({
            audioBase64: input.audio.toString('base64'),
            mime: input.mime,
            sourceLanguage: input.sourceLanguage,
            targetLanguage: input.targetLanguage,
            durationMs: input.durationMs,
            // Same declared-not-yet-enforced binding as the text client.
            provider: input.route.provider,
            modelId: input.route.modelId,
          }),
          signal: controller.signal,
        });
        if (!response.ok) return { ok: false, stage: 'transport' };
        const body = (await response.json()) as {
          ok?: unknown;
          stage?: unknown;
          translatedText?: unknown;
          audioBase64?: unknown;
          mime?: unknown;
          durationMs?: unknown;
        };
        if (body.ok !== true) {
          return { ok: false, stage: typeof body.stage === 'string' ? body.stage : 'unknown' };
        }
        if (
          typeof body.translatedText !== 'string' ||
          body.translatedText.length === 0 ||
          typeof body.audioBase64 !== 'string' ||
          body.audioBase64.length === 0 ||
          typeof body.mime !== 'string' ||
          typeof body.durationMs !== 'number'
        ) {
          return { ok: false, stage: 'malformed' };
        }
        const audio = Buffer.from(body.audioBase64, 'base64');
        if (audio.length === 0) return { ok: false, stage: 'malformed' };
        return {
          ok: true,
          rendering: {
            translatedText: body.translatedText,
            audio,
            mime: body.mime,
            durationMs: Math.round(body.durationMs),
          },
        };
      } catch {
        return { ok: false, stage: 'transport' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
