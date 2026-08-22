/** @author masterzee001 */
/**
 * C-AI1.1F pins: one utterance, several languages.
 *
 * The defect these exist for was not a crash. `liveSpeechPlanFor` returned the
 * FIRST non-text-only target, so a conference with Spanish and French listeners
 * progressively spoke Spanish and silently never spoke French -- and every
 * component reported success, because from each component's point of view
 * nothing was wrong. A contract that cannot express the product looks exactly
 * like one that works.
 */
import { describe, expect, it } from 'vitest';
import type { IngressAudio, IngressTranslatedAudio } from '@videofy-live/media-ingress-wire';
import { LiveSessionHost, planSpeechTargets, type LiveSpeechPlan } from '../live-session-host.js';
import {
  MockStreamingTranscriptionProvider,
  type MockStreamingSession,
} from '../streaming-transcription-provider.js';
import { MockStreamingSynthesisProvider } from '../streaming-speech-synthesis-provider.js';
import type { TimestampedTranslationProvider } from '../translation-provider.js';

const FRAME = 320;

function voiced(): Int16Array {
  const samples = new Int16Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) samples[i] = i % 2 === 0 ? 6000 : -6000;
  return samples;
}
const quiet = (): Int16Array => new Int16Array(FRAME);

function frame(sequence: number, samples: Int16Array): IngressAudio {
  return { sequence, platformTimestampMs: 100_000 + sequence * 20, discontinuity: false, samples };
}

async function rig(plans: LiveSpeechPlan[]) {
  const sent: IngressTranslatedAudio[] = [];
  const translations: string[] = [];
  const syntheses: string[] = [];
  const provider = new MockStreamingTranscriptionProvider();

  const translation: TimestampedTranslationProvider = {
    name: 'mock-mt',
    translate: async (input) => {
      translations.push(input.targetLanguage);
      return { translatedText: `[${input.targetLanguage}] ${input.sourceText}` };
    },
  };
  const synthesis = new MockStreamingSynthesisProvider([640]);
  const originalSynthesize = synthesis.synthesize.bind(synthesis);
  synthesis.synthesize = async (options) => {
    syntheses.push(options.targetLanguage);
    return originalSynthesize(options);
  };

  const host = await LiveSessionHost.open(
    {
      version: 2,
      sessionId: 'cs_1',
      streamId: 'st_1',
      context: { serviceCategory: 'call', mediaMode: 'live' },
      sourceLanguage: 'en',
    },
    { sendTranslatedAudio: (audio) => { sent.push(audio); return true; } },
    {
      transcription: provider,
      translation,
      synthesis,
      mintSegmentId: () => 'seg_1',
      speechPlansFor: () => plans,
      speech: { endSilenceMs: 60, minSpeechMs: 40 },
      frameSamples: FRAME,
    },
  );
  const session = provider.sessions[0] as MockStreamingSession;
  return { host, session, sent, translations, syntheses };
}

async function utterance(r: Awaited<ReturnType<typeof rig>>): Promise<void> {
  for (let i = 0; i < 3; i += 1) await r.host.onAudio(frame(i, voiced()));
  r.session.emit({ kind: 'final', text: 'good afternoon' });
  for (let i = 3; i < 9; i += 1) await r.host.onAudio(frame(i, quiet()));
  // The pipelines run detached so transcription is not held up by a vendor.
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe('which languages get a voice', () => {
  it('PIN: a text-only target is translated for captions and NEVER spoken', () => {
    const plans = planSpeechTargets({
      targetLanguages: ['es', 'de', 'fr'],
      textOnlyLanguages: ['de'],
      voiceIdsByLanguage: { es: 'v-es', de: 'v-de', fr: 'v-fr' },
    });
    // `de` has a voice configured and is still excluded: its audience asked
    // for text, and a voice would be the one thing they said they did not want.
    expect(plans.map((p) => p.targetLanguage)).toEqual(['es', 'fr']);
  });

  it('PIN: a language with no voice is left out, not given a default one', () => {
    const plans = planSpeechTargets({
      targetLanguages: ['es', 'fr'],
      voiceIdsByLanguage: { es: 'v-es' },
    });
    // A default voice for French would be an English voice speaking French
    // words, which is worse than the silence it replaced.
    expect(plans).toEqual([{ targetLanguage: 'es', voiceId: 'v-es' }]);
  });

  it('PIN: duplicate targets collapse to one plan', () => {
    const plans = planSpeechTargets({
      targetLanguages: ['es', 'es', 'fr', 'es'],
      voiceIdsByLanguage: { es: 'v-es', fr: 'v-fr' },
    });
    expect(plans.map((p) => p.targetLanguage)).toEqual(['es', 'fr']);
  });

  it('no configured targets means captions only', () => {
    expect(planSpeechTargets({})).toEqual([]);
    expect(planSpeechTargets({ targetLanguages: [] })).toEqual([]);
  });
});

describe('one utterance produces every language, not the first one', () => {
  it('PIN: two target languages both get translated and spoken', async () => {
    const r = await rig([
      { targetLanguage: 'es', voiceId: 'v-es' },
      { targetLanguage: 'fr', voiceId: 'v-fr' },
    ]);
    await utterance(r);

    expect(r.translations.sort()).toEqual(['es', 'fr']);
    expect(r.syntheses.sort()).toEqual(['es', 'fr']);
    expect(r.host.spokenLanguages.sort()).toEqual(['es', 'fr']);
  });

  it('PIN: the speaker is transcribed ONCE however many languages listen', async () => {
    const r = await rig([
      { targetLanguage: 'es', voiceId: 'v-es' },
      { targetLanguage: 'fr', voiceId: 'v-fr' },
      { targetLanguage: 'de', voiceId: 'v-de' },
    ]);
    await utterance(r);
    // Three languages, one recogniser stream and one set of frames. Anything
    // else would multiply the STT bill by the size of the audience.
    expect(r.session.frames).toHaveLength(9);
  });

  it('PIN: every frame names its own language', async () => {
    const r = await rig([
      { targetLanguage: 'es', voiceId: 'v-es' },
      { targetLanguage: 'fr', voiceId: 'v-fr' },
    ]);
    await utterance(r);

    const languages = new Set(r.sent.map((audio) => audio.targetLanguage));
    // Several streams share a segmentId; the language is the only thing that
    // tells their frames apart.
    expect(languages).toEqual(new Set(['es', 'fr']));
    expect(new Set(r.sent.map((audio) => audio.segmentId))).toEqual(new Set(['seg_1']));
  });

  it('PIN: each language is ordered independently from sequence zero', async () => {
    const r = await rig([
      { targetLanguage: 'es', voiceId: 'v-es' },
      { targetLanguage: 'fr', voiceId: 'v-fr' },
    ]);
    await utterance(r);

    for (const language of ['es', 'fr']) {
      const sequences = r.sent
        .filter((audio) => audio.targetLanguage === language)
        .map((audio) => audio.sequence);
      expect(sequences, language).toEqual(sequences.map((_, index) => index));
    }
  });

  it('PIN: a duplicate language costs one pipeline, not two', async () => {
    const r = await rig([
      { targetLanguage: 'es', voiceId: 'v-es' },
      { targetLanguage: 'es', voiceId: 'v-es-other' },
    ]);
    await utterance(r);
    // Ten Spanish listeners are one translation and one synthesis whose frames
    // all of them receive.
    expect(r.translations).toEqual(['es']);
    expect(r.syntheses).toEqual(['es']);
  });

  it('PIN: no plans means captions only, and no synthesis at all', async () => {
    const r = await rig([]);
    await utterance(r);
    expect(r.translations).toEqual([]);
    expect(r.syntheses).toEqual([]);
    expect(r.sent).toEqual([]);
    expect(r.host.spokenLanguages).toEqual([]);
  });

  it('PIN: aborting withdraws every language, not just the first', async () => {
    const r = await rig([
      { targetLanguage: 'es', voiceId: 'v-es' },
      { targetLanguage: 'fr', voiceId: 'v-fr' },
    ]);
    // Abort WHILE the utterance is still being spoken. Aborting after both
    // pipelines had finished would prove nothing: cancelling something already
    // complete is a no-op whether or not every language was reached.
    for (let i = 0; i < 3; i += 1) await r.host.onAudio(frame(i, voiced()));
    r.session.emit({ kind: 'final', text: 'good afternoon' });
    await r.host.abort('superseded');

    const before = r.sent.length;
    // Whatever the pipelines were about to produce must not arrive after this.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(r.sent).toHaveLength(before);
  });
});
