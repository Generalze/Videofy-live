/** @author masterzee001 */
/**
 * One voice, several vendors behind it.
 *
 * WHY A CHAIN AND NOT A CHOICE. A single synthesis vendor is a single point of
 * failure on the one part of the pipeline a listener experiences directly: when
 * it is down, the call does not degrade, it goes silent. Every other stage has
 * something to fall back to -- transcription failing loses captions, translation
 * failing loses the translation -- but synthesis failing loses the ANSWER.
 *
 * THE RULE THAT MAKES THIS SAFE, and the reason this is not a simple retry
 * loop: a provider that has already emitted audio is NEVER replaced. Once a
 * listener has heard the first half of a sentence, starting a second provider
 * on the same text would speak that half again, in a different voice. A partial
 * sentence is a worse outcome than a missing one only until you make it a
 * stuttering one.
 *
 * So the chain falls through on exactly two conditions, both of which mean
 * nothing reached anybody:
 *
 *   - the provider threw, or reported an error, before any chunk
 *   - the provider finished having produced zero samples
 *
 * ABORT IS NOT FAILURE. A superseded sentence is cancelled on purpose, and
 * falling through to another vendor would pay a second time to synthesise
 * something already known to be unwanted.
 */
import type {
  StreamingSpeechSynthesisProvider,
  StreamingSynthesisOptions,
  StreamingSynthesisResult,
} from './streaming-speech-synthesis-provider.js';

export interface FallbackSynthesisObservation {
  /** The provider that actually spoke, or null when every one of them failed. */
  readonly servedBy: string | null;
  /** Providers that failed before producing anything, in the order tried. */
  readonly fellThrough: readonly string[];
  /**
   * First audio, measured from the SERVING provider's start.
   *
   * Useful for judging that vendor and misleading about the product: during a
   * measured fall-through it read 62 ms while the listener had actually waited
   * 527 ms, because the whole cost of the failed first attempt sits outside
   * this clock. Kept under its own name because it answers a real question --
   * just a narrower one than it looks like.
   */
  readonly timeToFirstChunkMs: number | null;
  /**
   * First audio, measured from when the SENTENCE entered the chain.
   *
   * This is what somebody actually waited. It differs from the field above by
   * exactly the time spent on providers that failed before speaking, which is
   * the number a fall-through is expensive in and the one that was invisible.
   */
  readonly listenerWaitedMs: number | null;
  readonly totalMs: number;
  readonly samples: number;
}

export interface FallbackSynthesisOptions {
  readonly providers: readonly StreamingSpeechSynthesisProvider[];
  /**
   * Told which vendor served each sentence and which fell through.
   *
   * Separate from logging on purpose: this is the signal that says a primary is
   * failing quietly. Without it a chain that works perfectly hides an outage,
   * because the listener hears audio either way and nobody finds out until the
   * bill or the latency changes.
   */
  readonly onObservation?: (observation: FallbackSynthesisObservation) => void;
}

export function createFallbackSpeechSynthesisProvider(
  options: FallbackSynthesisOptions,
): StreamingSpeechSynthesisProvider {
  const providers = options.providers;
  if (providers.length === 0) {
    throw new Error('a synthesis fallback chain needs at least one provider');
  }

  return {
    name: `fallback(${providers.map((provider) => provider.name).join(' -> ')})`,

    async synthesize(request: StreamingSynthesisOptions): Promise<StreamingSynthesisResult> {
      const startedAt = Date.now();
      const fellThrough: string[] = [];
      let lastResult: StreamingSynthesisResult | null = null;
      /*
       * CHAIN-WIDE, and set once. The first chunk any provider emits is the
       * moment the listener stopped waiting, whichever attempt produced it, so
       * this clock must not restart when a provider falls through -- restarting
       * it is precisely how the cost of a failed attempt disappeared.
       */
      let firstChunkAt: number | null = null;

      for (const provider of providers) {
        /*
         * Tracked PER ATTEMPT. A chunk from the previous provider must not make
         * this one look like it has already committed -- and a chunk from THIS
         * one must make it uninterruptible.
         */
        let emitted = false;
        let failed: Error | null = null;

        const attempt = await provider
          .synthesize({
            ...request,
            onChunk: (chunk) => {
              emitted = true;
              firstChunkAt ??= Date.now();
              request.onChunk(chunk);
            },
            /*
             * Captured rather than forwarded. If this provider still has a
             * successor, the caller must not be told about a failure that is
             * about to be handled -- an error the platform recovers from is not
             * an error the platform should report.
             */
            onError: (error) => {
              failed = error;
            },
          })
          .catch((error: unknown) => {
            failed = error instanceof Error ? error : new Error(String(error));
            return null;
          });

        if (attempt) lastResult = attempt;

        // Cancelled on purpose. Falling through would pay to synthesise a
        // sentence already known to be unwanted.
        if (attempt?.aborted === true) {
          options.onObservation?.({
            servedBy: provider.name,
            fellThrough,
            timeToFirstChunkMs: attempt.timeToFirstChunkMs,
            listenerWaitedMs: firstChunkAt === null ? null : firstChunkAt - startedAt,
            totalMs: Date.now() - startedAt,
            samples: attempt.samples,
          });
          return attempt;
        }

        /*
         * COMMITTED. Anything this provider already spoke is out there, so it
         * owns this sentence whatever happens next -- including a failure
         * part-way through, which is reported rather than papered over with a
         * second voice repeating the first half.
         */
        if (emitted) {
          if (failed) request.onError(failed);
          const result = attempt ?? {
            samples: 0,
            timeToFirstChunkMs: null,
            totalMs: Date.now() - startedAt,
            aborted: false,
          };
          options.onObservation?.({
            servedBy: provider.name,
            fellThrough,
            timeToFirstChunkMs: result.timeToFirstChunkMs,
            listenerWaitedMs: firstChunkAt === null ? null : firstChunkAt - startedAt,
            totalMs: Date.now() - startedAt,
            samples: result.samples,
          });
          return result;
        }

        // Nothing reached anybody: either it threw before speaking, or it
        // finished having produced silence. Zero samples is a failure, not a
        // quiet success.
        if (failed || attempt === null || attempt.samples === 0) {
          fellThrough.push(provider.name);
          continue;
        }

        options.onObservation?.({
          servedBy: provider.name,
          fellThrough,
          timeToFirstChunkMs: attempt.timeToFirstChunkMs,
          listenerWaitedMs: firstChunkAt === null ? null : firstChunkAt - startedAt,
          totalMs: Date.now() - startedAt,
          samples: attempt.samples,
        });
        return attempt;
      }

      /*
       * Every provider failed. The caller is told once, now -- this is the
       * point at which the platform has genuinely run out of answers, and it is
       * the only failure worth surfacing to a listener.
       */
      request.onError(new Error('every speech synthesis provider failed'));
      options.onObservation?.({
        servedBy: null,
        fellThrough,
        timeToFirstChunkMs: null,
        listenerWaitedMs: null,
        totalMs: Date.now() - startedAt,
        samples: 0,
      });

      return (
        lastResult ?? {
          samples: 0,
          timeToFirstChunkMs: null,
          totalMs: Date.now() - startedAt,
          aborted: false,
        }
      );
    },
  };
}
