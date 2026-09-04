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
 *
 * THIS CLIENT IS NEVER CALLED SPECULATIVELY. The messaging policy decides
 * whether an APPROVED LOCAL route exists before anything reaches here, and
 * the approved provider and model travel in the body. Media-ingest does not
 * yet READ those two fields -- it serves this route from its configured live
 * translation provider -- so the binding is currently declared, not enforced
 * at the far end. That gap is named for the orchestrator rather than papered
 * over here; nothing in this service may enforce it alone.
 */

/**
 * The route the registry APPROVED for this direction, carried with the
 * request. It is not a preference: this path may only be served by the route
 * the messaging policy chose, and naming it means a later engine change
 * cannot quietly serve an approved pair from an unapproved model without the
 * mismatch being visible on both sides of the seam.
 */
export interface ApprovedRoute {
  readonly provider: string;
  readonly modelId: string;
}

export interface TextTranslator {
  translate(input: {
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
    readonly sourceText: string;
    readonly route: ApprovedRoute;
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
          body: JSON.stringify({
            sourceLanguage: input.sourceLanguage,
            targetLanguage: input.targetLanguage,
            sourceText: input.sourceText,
            // Advisory to the engine TODAY, contractual once media-ingest
            // honours it: see the note in this file's header.
            provider: input.route.provider,
            modelId: input.route.modelId,
          }),
          signal: controller.signal,
        });
        if (!response.ok) return null;
        const body = (await response.json()) as {
          translatedText?: unknown;
          sentenceCount?: unknown;
          translatedSentenceCount?: unknown;
        };
        if (typeof body.translatedText !== 'string' || body.translatedText.length === 0) {
          return null;
        }
        /*
         * A PARTLY TRANSLATED MESSAGE IS NOT A TRANSLATION.
         *
         * media-ingest splits a message into sentences and, when one fails,
         * keeps the ORIGINAL sentence in its place so no words are lost. That
         * is right for the text and wrong for the label: the reader would be
         * shown a mixture and told it was a translation, with nothing in the
         * response to say otherwise. Now the counts come back, and a message
         * that did not translate in full is reported unavailable and delivered
         * in the sender's own words -- the same honesty a total failure gets.
         *
         * An older media-ingest sends no counts. Absent is not a claim of
         * completeness, but refusing every translation from a build that has
         * not been updated yet would be worse than the defect; the whole-message
         * echo guard still stands behind it.
         */
        if (
          typeof body.sentenceCount === 'number' &&
          typeof body.translatedSentenceCount === 'number' &&
          body.translatedSentenceCount < body.sentenceCount
        ) {
          return null;
        }
        return body.translatedText;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
