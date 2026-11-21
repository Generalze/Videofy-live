/** @author masterzee001 */
/**
 * A CALL ASKS ABOUT CALLS.
 *
 * MEASURED IN PRODUCTION, 28 SEP 2026. A French translated call ran 55 seconds
 * in each direction and delivered `translatedFramesIn: 0` both ways. No error,
 * no warning, no declined-translation log, an empty
 * `skippedSynthesisByLanguage`, and a media plan that said
 * `targetLanguages:["fr"], willTranslate:true`. Two people sat in silence
 * while every instrument reported a healthy call.
 *
 * `grep -rn "'call-live'" services/media-ingest/src` returned ONE line: the
 * type definition. The scope existed in the vocabulary of this service and
 * nowhere in its behaviour. Every gate was built `programme-live` at boot, so
 * the question actually asked of the registry was "is en->fr approved for
 * BROADCAST" -- and on the deployed document the honest answer is no, because
 * nobody has reviewed French for broadcast. It is approved for `call-live` and
 * `messaging`, which is what the reviewer signed.
 *
 * So the gate was right, the document was right, the reviewer was right, and
 * the pipeline was right to refuse to speak an untranslated sentence. The join
 * asked the wrong question. That is this project's signature defect for the
 * seventh time: both halves built, the seam owned by nobody.
 *
 * These tests fail if the seam is ever unpicked again. They assert the SCOPE
 * THAT REACHES THE REGISTRY, not the shape of any call site, because the last
 * version of this area was rewritten and a source-text test would have broken
 * for the one reason a test must never break.
 */
import { describe, expect, it } from 'vitest';
import type { IngressAudio, IngressTranslatedAudio } from '@videofy-live/media-ingress-wire';
import { LiveSessionHost } from '../live-session-host.js';
import {
  MockStreamingTranscriptionProvider,
  type MockStreamingSession,
} from '../streaming-transcription-provider.js';
import { MockStreamingSynthesisProvider } from '../streaming-speech-synthesis-provider.js';
import { GatedTranslationProvider } from '../gated-translation-provider.js';
import { buildTranslationGate, type RegistryLoad } from '../translation-gate-wiring.js';
import {
  scopeForServiceCategory,
  type TranslationScope,
} from '../translation-gate.js';

const FRAME = 320;

function voiced(): Int16Array {
  const samples = new Int16Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) samples[i] = i % 2 === 0 ? 6000 : -6000;
  return samples;
}

function frame(sequence: number, samples: Int16Array): IngressAudio {
  return { sequence, platformTimestampMs: 100_000 + sequence * 20, discontinuity: false, samples };
}

/**
 * THE DEPLOYED DOCUMENT, as it stood on 28 Sep 2026.
 *
 * `en->fr` approved for calls and messages, deliberately unapproved for
 * broadcast. Every scope asked of it is recorded, so a test can say which
 * question was put rather than which line of code ran.
 */
function productionShapedRegistry(asked: TranslationScope[]): () => RegistryLoad {
  const approved = new Set(['en->fr:call-live', 'en->fr:messaging']);
  return () => ({
    ok: true,
    registry: {
      mayTranslate(source: string, target: string, scope: string) {
        asked.push(scope as TranslationScope);
        return approved.has(`${source}->${target}:${scope}`)
          ? { allowed: true as const, route: { provider: 'opus-mt' } }
          : {
              allowed: false as const,
              explanation: `No approved ${scope} route for ${source} to ${target}.`,
            };
      },
      directions: () => [{ sourceLanguage: 'en', targetLanguage: 'fr' }],
    },
  });
}

/** One utterance through a real host, with the gate the wiring actually builds. */
async function speakOneSentence(serviceCategory: 'call' | 'programme') {
  const askedScopes: TranslationScope[] = [];
  const wiring = buildTranslationGate({ loadRegistry: productionShapedRegistry(askedScopes) });
  const engineSaw: string[] = [];

  const transcription = new MockStreamingTranscriptionProvider();
  const synthesis = new MockStreamingSynthesisProvider([640]);
  const spoken: string[] = [];
  const originalSynthesize = synthesis.synthesize.bind(synthesis);
  synthesis.synthesize = async (options) => {
    spoken.push(options.text);
    return originalSynthesize(options);
  };

  const sent: IngressTranslatedAudio[] = [];
  const host = await LiveSessionHost.open(
    {
      version: 2,
      sessionId: 'cs_scope',
      streamId: 'st_scope',
      context:
        serviceCategory === 'call'
          ? { serviceCategory: 'call', mediaMode: 'live' }
          : {
              serviceCategory: 'programme',
              mediaMode: 'live',
              programme: { channelId: 'chan_1', programmeId: 'prog_1', runId: 'run_1' },
            },
      sourceLanguage: 'en',
    },
    { sendTranslatedAudio: (audio) => { sent.push(audio); return true; } },
    {
      transcription,
      /*
       * THE JOIN UNDER TEST. Exactly what index.ts wires: the host names its
       * own service category and gets the gate for the matching scope. If the
       * mapping is ever inverted or defaulted, `askedScopes` says so.
       */
      translationFor: (category) =>
        new GatedTranslationProvider({
          inner: {
            name: 'engine',
            translate: async (input) => {
              engineSaw.push(input.sourceText);
              return { translatedText: `FR:${input.sourceText}` };
            },
          },
          gate: wiring.gateFor(scopeForServiceCategory(category)),
        }),
      synthesis,
      mintSegmentId: () => 'seg_1',
      speechPlansFor: () => [{ targetLanguage: 'fr', voiceId: 'voice_fr' }],
      speech: { endSilenceMs: 60, minSpeechMs: 40 },
      frameSamples: FRAME,
    },
  );

  for (let i = 0; i < 3; i += 1) await host.onAudio(frame(i, voiced()));
  const session = transcription.sessions[0] as MockStreamingSession;
  session.emit({ kind: 'final', text: 'Good morning everyone.' });
  await new Promise((resolve) => setTimeout(resolve, 20));

  return { askedScopes, engineSaw, spoken, sent };
}

describe('the scope a live stream is judged under', () => {
  it('maps a call to call-live and a programme to programme-live', () => {
    expect(scopeForServiceCategory('call')).toBe('call-live');
    expect(scopeForServiceCategory('programme')).toBe('programme-live');
  });

  /*
   * A MUTANT THAT MUST DIE. Returning `'programme-live'` for both is precisely
   * the deployed defect, and the assertion above is the one that kills it.
   * Asserting only the programme case would pass against the bug.
   */
  it('never answers with the same scope for both', () => {
    expect(scopeForServiceCategory('call')).not.toBe(scopeForServiceCategory('programme'));
  });
});

describe('a translated call reaches the engine', () => {
  it('asks the registry about CALLS, and nothing else', async () => {
    const run = await speakOneSentence('call');
    expect(run.askedScopes.length).toBeGreaterThan(0);
    expect(new Set(run.askedScopes)).toEqual(new Set(['call-live']));
  });

  it('translates and SPEAKS, which is what produced silence in production', async () => {
    const run = await speakOneSentence('call');
    // The engine was reached: on 28 Sep it never was, because the gate
    // refused before it.
    expect(run.engineSaw).toEqual(['Good morning everyone.']);
    // And the translated words were synthesised, not the original. An
    // untranslated sentence read aloud is the defect this call path already
    // has a guard against, and it must not be what makes this test green.
    expect(run.spoken).toEqual(['FR:Good morning everyone.']);
    expect(run.sent.length).toBeGreaterThan(0);
  });
});

describe('a programme is still judged as a programme', () => {
  /*
   * ASSERTED HERE AND NOT THROUGH THE HOST, deliberately.
   *
   * A programme commits segments under the `stabilized` policy while a call
   * uses `aggressive`, so one final utterance and a short wait do not commit
   * a programme segment -- correctly, that is what stabilisation is. Driving
   * a programme to synthesis would mean a test whose subject was the commit
   * policy's timing rather than the scope, and a slow machine would decide
   * whether it passed. The refusal lives in the wiring, so it is measured in
   * the wiring.
   *
   * THE OTHER HALF OF THE FIX, and the more important half. Making calls work
   * must not quietly widen broadcast: French has been reviewed for calls and
   * NOT for broadcast, and a programme must still be refused. Approving one
   * scope with another's evidence is the exact thing the directional registry
   * exists to prevent, and it was the one-minute shortcut available when this
   * defect was found.
   */
  it('is refused by a document that approves only calls and messages', () => {
    const asked: TranslationScope[] = [];
    const wiring = buildTranslationGate({ loadRegistry: productionShapedRegistry(asked) });
    const decision = wiring
      .gateFor(scopeForServiceCategory('programme'))
      .decide({
        sourceLanguage: 'en',
        targetLanguage: 'fr',
        text: 'Good morning everyone.',
        identity: { sessionId: 'ps_1', segmentId: 'seg_1', revision: 1 },
      });
    expect(asked).toEqual(['programme-live']);
    expect(decision.action).toBe('unavailable');
    if (decision.action === 'unavailable') {
      expect(decision.reason).toBe('route-not-approved');
      expect(decision.deliver).toBe('Good morning everyone.');
    }
  });

  it('hands the host a translator chosen by the stream it opened', async () => {
    /*
     * The passthrough itself, with no synthesis in it. What must never
     * regress is that the category reaching `translationFor` is the one on
     * the OPEN frame; whether that stream then commits a segment is the
     * commit policy's business.
     */
    for (const serviceCategory of ['call', 'programme'] as const) {
      const seen: ('call' | 'programme')[] = [];
      await LiveSessionHost.open(
        {
          version: 2,
          sessionId: 'cs_pass',
          streamId: 'st_pass',
          context:
            serviceCategory === 'call'
              ? { serviceCategory: 'call', mediaMode: 'live' }
              : {
                  serviceCategory: 'programme',
                  mediaMode: 'live',
                  programme: { channelId: 'chan_1', programmeId: 'prog_1', runId: 'run_1' },
                },
          sourceLanguage: 'en',
        },
        { sendTranslatedAudio: () => true },
        {
          transcription: new MockStreamingTranscriptionProvider(),
          translationFor: (category) => {
            seen.push(category);
            return { name: 'noop', translate: async () => ({ translatedText: '' }) };
          },
          synthesis: new MockStreamingSynthesisProvider([640]),
          mintSegmentId: () => 'seg_1',
          speechPlansFor: () => [{ targetLanguage: 'fr', voiceId: 'voice_fr' }],
          speech: { endSilenceMs: 60, minSpeechMs: 40 },
          frameSamples: FRAME,
        },
      );
      expect(seen, serviceCategory).toEqual([serviceCategory]);
    }
  });
});
