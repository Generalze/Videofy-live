/** @author masterzee001 */
/**
 * The account service's line to the translation engine.
 *
 * Media-ingest owns every provider; this client calls its internal
 * text-translation route with the same internal token the gateway uses for
 * the media API. The account service holds NO provider credentials -- that
 * boundary is what keeps vendor keys in exactly one service.
 *
 * FAILURE DELIVERS THE ORIGINAL. A message must never be lost or delayed
 * because a translation vendor is down (COMMUNICATION_ARCHITECTURE.md 4.1:
 * failed translation delivers the original with a notice), so every failure
 * here -- timeout, refusal, bad config -- resolves to null and the caller
 * sends the message untranslated.
 */

export interface TextTranslator {
  translate(input: {
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly sourceText: string;
  }): Promise<string | null>;
}

/*
 * Generous on purpose: the failure mode is delivering the original, so a
 * tight timeout only converts slow successes into silent originals -- the
 * matrix caught exactly that. The sender's request does wait this long in
 * the worst case; the post-freeze shape is async render-then-update.
 */
const TRANSLATE_TIMEOUT_MS = 15_000;

export function createTextTranslator(options: {
  readonly mediaIngestUrl: string | undefined;
  readonly internalToken: string | undefined;
  readonly fetchImpl?: typeof fetch;
}): TextTranslator {
  const base = options.mediaIngestUrl?.replace(/\/+$/, '') ?? null;
  const token = options.internalToken ?? null;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  return {
    async translate(input) {
      if (base === null || token === null) return null;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);
      try {
        const response = await fetchImpl(`${base}/internal/text-translation`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Videofy-Internal-Token': token,
          },
          body: JSON.stringify(input),
          signal: controller.signal,
        });
        if (!response.ok) return null;
        const body = (await response.json()) as { translatedText?: unknown };
        return typeof body.translatedText === 'string' && body.translatedText.length > 0
          ? body.translatedText
          : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
