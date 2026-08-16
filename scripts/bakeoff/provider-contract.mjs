// Videofy Live — C-AI1.0 bake-off provider contract.
//
// Every candidate implements this and nothing else. The runner and the scoring
// never learn which vendor they are talking to, so a difference in the report
// can only come from the provider — not from how it was driven.
//
// This is the bake-off's contract, deliberately NOT the runtime one. C-AI1.1
// designs `providerCapabilities` for the session engine once the bake-off has
// said which shapes are actually worth supporting; guessing that interface now,
// before any vendor has been measured, is how vendor assumptions leak into a
// core that is supposed to outlive any single vendor.

/**
 * @typedef {object} BakeoffCapabilities
 * @property {boolean} streamingAudioInput   Accepts continuous audio, not whole utterances.
 * @property {boolean} partialTranscript     Emits words before the speaker stops.
 * @property {boolean} streamingTranslation  Translates before the utterance ends.
 * @property {boolean} streamingAudioOutput  Emits audio before synthesis finishes.
 * @property {boolean} automaticLanguageDetection
 * @property {boolean} multipleTargetLanguages
 */

/**
 * @typedef {object} BakeoffUtteranceResult
 * @property {string}  transcript      What the provider heard.
 * @property {string|null} translation What it produced in the target language.
 * @property {number}  segmentCount    Pieces the utterance came back in; >1 is boundary damage.
 * @property {object}  timings         Milliseconds from the first audio byte sent.
 * @property {number} [timings.firstPartialTranscriptMs]
 * @property {number} [timings.stableTranscriptMs]
 * @property {number} [timings.firstTranslatedTextMs]
 * @property {number} [timings.firstTranslatedAudioMs]
 * @property {number} [timings.utteranceCompleteMs]
 * @property {object} [usage]          Whatever the provider reports it consumed.
 */

/**
 * @typedef {object} BakeoffProvider
 * @property {string} name
 * @property {BakeoffCapabilities} capabilities
 * @property {() => Promise<void>} [setUp]
 * @property {(utterance: object) => Promise<BakeoffUtteranceResult>} run
 * @property {() => Promise<void>} [tearDown]
 * @property {() => object} [usage]   Totals for the whole run, for costing.
 */

/** Every capability false; a provider declares only what it actually does. */
export const NO_CAPABILITIES = Object.freeze({
  streamingAudioInput: false,
  partialTranscript: false,
  streamingTranslation: false,
  streamingAudioOutput: false,
  automaticLanguageDetection: false,
  multipleTargetLanguages: false,
});

/**
 * Fails a provider that is shaped wrongly, at registration rather than halfway
 * through a run — a bake-off that dies after twenty minutes of audio because a
 * field was missing wastes the very thing it exists to measure.
 */
export function assertProvider(provider) {
  const problems = [];
  if (!provider || typeof provider !== 'object') problems.push('provider must be an object');
  if (!provider?.name) problems.push('provider.name is required, and appears in the report');
  if (typeof provider?.run !== 'function') problems.push('provider.run(utterance) is required');
  for (const key of Object.keys(NO_CAPABILITIES)) {
    if (typeof provider?.capabilities?.[key] !== 'boolean') {
      problems.push(`provider.capabilities.${key} must be declared true or false`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Invalid bake-off provider:\n  - ${problems.join('\n  - ')}`);
  }
  return provider;
}

/**
 * Which latency stages a provider can even be scored on.
 *
 * A batch provider has no first-partial time, and reporting one as zero — or as
 * missing without saying why — would make the comparison dishonest in the
 * direction that flatters batch. Unsupported stays visibly unsupported.
 */
export function measurableStages(capabilities) {
  return {
    firstPartialTranscriptMs: capabilities.partialTranscript,
    stableTranscriptMs: true,
    firstTranslatedTextMs: true,
    firstTranslatedAudioMs: capabilities.streamingAudioOutput || true,
    utteranceCompleteMs: true,
  };
}
