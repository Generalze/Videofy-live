/**
 * P6.4 ingest-plan contract: TTS is synthesized for target L iff L is in
 * `targetLanguages` AND NOT in `textOnlyLanguages`. A text-only target is
 * translated for captions but never spoken; an EMPTY target list is a valid
 * STT-only session (transcription events only); and every skipped synthesis
 * is counted per language so a captions-without-clips session is checkable.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ProcessingSessionStore,
  type ProcessingSession,
  type WebRtcSessionInput,
} from '../media-session.js';
import type {
  TextToSpeechProviderInput,
} from '../text-to-speech-provider.js';
import type { TranslationProviderInput } from '../translation-provider.js';

/**
 * The configured default voice: the fallback `voiceIdForLanguage` lands on
 * when a language has no per-session voice. A text-only target must never
 * produce a synthesis request that carries it.
 */
const DEFAULT_FALLBACK_VOICE = 'default-fallback-voice';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Harness {
  store: ProcessingSessionStore;
  stagingDir: string;
  ttsRequests: TextToSpeechProviderInput[];
  translationRequests: TranslationProviderInput[];
  transcriptionEvents: string[];
  translationEvents: string[];
  generatedReady: string[];
}

async function harness(): Promise<Harness> {
  const outputBaseDir = await mkdtemp(join(tmpdir(), 'videofy-text-only-'));
  const stagingDir = await mkdtemp(join(tmpdir(), 'videofy-text-only-staging-'));
  tempDirs.push(outputBaseDir, stagingDir);

  const ttsRequests: TextToSpeechProviderInput[] = [];
  const translationRequests: TranslationProviderInput[] = [];
  const transcriptionEvents: string[] = [];
  const translationEvents: string[] = [];
  const generatedReady: string[] = [];

  const store = new ProcessingSessionStore({
    outputBaseDir,
    webRtcStagingDir: stagingDir,
    transcriptionProvider: {
      name: 'fake-stt',
      transcribe: async (input) => ({
        segments: [
          {
            text: `utterance ${input.chunk.index}`,
            startMs: 0,
            endMs: input.chunk.endMs - input.chunk.startMs,
          },
        ],
        detectedLanguage: 'en',
        confidence: 0.95,
      }),
    },
    translationProvider: {
      name: 'fake-mt',
      translate: async (input) => {
        translationRequests.push(input);
        return { translatedText: `${input.targetLanguage}:${input.sourceText}` };
      },
    },
    textToSpeechProvider: {
      name: 'fake-tts',
      generate: async (input) => {
        ttsRequests.push(input);
        await writeFile(input.outputPath, wavFixture());
        return { audioPath: input.outputPath, providerLatencyMs: 2 };
      },
    },
    translationTargetLanguage: 'es',
    translationSupportedTargetLanguages: ['es', 'fr'],
    textToSpeechSupportedLanguages: ['es', 'fr'],
    textToSpeechVoiceId: DEFAULT_FALLBACK_VOICE,
    onTranscriptionEvent: (event) => transcriptionEvents.push(`${event.sequence}:${event.status}`),
    onTranslationEvent: (event) =>
      translationEvents.push(`${event.sequence}:${event.status}:${event.targetLanguage}`),
    onGeneratedAudioReady: (event) =>
      generatedReady.push(`${event.sequence}:${event.targetLanguage}:${event.voiceId}`),
  });

  return { store, stagingDir, ttsRequests, translationRequests, transcriptionEvents, translationEvents, generatedReady };
}

function callInput(overrides: Partial<WebRtcSessionInput> = {}): WebRtcSessionInput {
  return {
    sessionId: 'call_call-1_p1_r1',
    broadcastId: 'call-1',
    broadcasterPeerId: 'peer_p1',
    revision: 1,
    sourceLanguage: 'en',
    sourceLanguageMode: 'manual',
    generatedAudioPacing: 'natural',
    ...overrides,
  };
}

async function ingestChunk(
  h: Harness,
  sessionId: string,
  sequence: number,
  partial?: { partialSequence: number },
): Promise<ProcessingSession> {
  const suffix = partial ? `-p${partial.partialSequence}` : '';
  const sourcePath = join(h.stagingDir, `chunk-${sequence}${suffix}.wav`);
  await writeFile(sourcePath, wavFixture());
  return h.store.ingestWebRtcChunk(sessionId, {
    sequence,
    startMs: sequence * 5_000,
    endMs: sequence * 5_000 + 5_000,
    sampleRate: 16000,
    channelCount: 1,
    pcmFormat: 'pcm_s16le',
    mimeType: 'audio/wav',
    sizeBytes: wavFixture().length,
    sourcePath,
    ...(partial ? { partial: true, partialSequence: partial.partialSequence } : {}),
  });
}

describe('text-only target languages (P6.4)', () => {
  it('translates a text-only target for captions but requests zero synthesis, counting every skip', async () => {
    const h = await harness();
    const session = await h.store.createWebRtcSession(
      callInput({ targetLanguages: ['es'], textOnlyLanguages: ['es'] }),
    );
    expect(session.textOnlyLanguages).toEqual(['es']);

    const updated = await ingestChunk(h, session.id, 0);

    // The caption channel is fully alive…
    expect(h.translationRequests.map((request) => request.targetLanguage)).toEqual(['es']);
    expect(h.translationEvents).toEqual(['0:queued:es', '0:translating:es', '0:translated:es']);
    // …while the voice channel never starts.
    expect(h.ttsRequests).toHaveLength(0);
    expect(h.generatedReady).toHaveLength(0);
    expect(updated.generatedAudio).toMatchObject({
      providerStatus: 'text-only',
      textOnlyLanguages: ['es'],
      events: [],
    });
    expect(updated.state).toBe('processing');
    expect(h.store.skippedSynthesisCounts(session.id)).toEqual({ es: 1 });

    await ingestChunk(h, session.id, 1);
    expect(h.store.skippedSynthesisCounts(session.id)).toEqual({ es: 2 });
    expect(h.ttsRequests).toHaveLength(0);

    // The counter is diagnostics for the session and dies with it.
    await h.store.removeCallSession(session.id);
    expect(h.store.skippedSynthesisCounts(session.id)).toEqual({});
  });

  it('runs an empty-target session as STT-only: transcription flows, nothing downstream runs, and stop completes it', async () => {
    const h = await harness();
    const session = await h.store.createWebRtcSession(callInput({ targetLanguages: [] }));
    expect(session.targetLanguages).toEqual([]);

    await ingestChunk(h, session.id, 0);
    const updated = await ingestChunk(h, session.id, 1);

    expect(h.transcriptionEvents).toEqual([
      '0:queued',
      '0:transcribing',
      '0:transcribed',
      '1:queued',
      '1:transcribing',
      '1:transcribed',
    ]);
    expect(h.translationRequests).toHaveLength(0);
    expect(h.ttsRequests).toHaveLength(0);
    expect(updated.translation.events).toEqual([]);
    expect(updated.generatedAudio.events).toEqual([]);
    expect(updated.state).toBe('processing');

    // Streaming partials survive too: transcription only, still no translation.
    const transcriptionCountBefore = h.transcriptionEvents.length;
    await ingestChunk(h, session.id, 2, { partialSequence: 0 });
    expect(h.transcriptionEvents.length).toBeGreaterThan(transcriptionCountBefore);
    expect(h.translationRequests).toHaveLength(0);

    expect(h.store.skippedSynthesisCounts(session.id)).toEqual({});
    expect(h.store.stopWebRtcSession(session.id).state).toBe('completed');
  });

  it('keeps a synthesized language exactly as before, speaking with its mapped voice', async () => {
    const h = await harness();
    const session = await h.store.createWebRtcSession(
      callInput({ targetLanguages: ['es'], voiceIdsByLanguage: { es: 'es-voice-1' } }),
    );

    const updated = await ingestChunk(h, session.id, 0);

    expect(h.translationEvents).toEqual(['0:queued:es', '0:translating:es', '0:translated:es']);
    expect(h.ttsRequests).toHaveLength(1);
    expect(h.ttsRequests[0]).toMatchObject({ targetLanguage: 'es', voiceId: 'es-voice-1' });
    expect(h.generatedReady).toEqual(['0:es:es-voice-1']);
    expect(updated.generatedAudio.events[0]).toMatchObject({
      targetLanguage: 'es',
      status: 'generated',
    });
    expect(h.store.skippedSynthesisCounts(session.id)).toEqual({});
  });

  it('never consults the default-voice fallback for a text-only target while the other target speaks', async () => {
    const h = await harness();
    const session = await h.store.createWebRtcSession(
      callInput({
        targetLanguages: ['es', 'fr'],
        textOnlyLanguages: ['fr'],
        voiceIdsByLanguage: { es: 'es-voice-1' },
      }),
    );

    const updated = await ingestChunk(h, session.id, 0);

    // Captions fan out to BOTH targets, text-only included.
    expect(h.translationRequests.map((request) => request.targetLanguage).sort()).toEqual([
      'es',
      'fr',
    ]);
    // Synthesis runs for the audible target only, with its mapped voice —
    // no request ever carries the configured default fallback.
    expect(h.ttsRequests.map((request) => request.targetLanguage)).toEqual(['es']);
    expect(h.ttsRequests[0]?.voiceId).toBe('es-voice-1');
    expect(
      h.ttsRequests.some((request) => request.voiceId === DEFAULT_FALLBACK_VOICE),
    ).toBe(false);
    expect(
      updated.generatedAudio.events.filter((event) => event.targetLanguage === 'fr'),
    ).toEqual([]);
    expect(updated.generatedAudio.textOnlyLanguages).toEqual(['fr']);
    expect(h.store.skippedSynthesisCounts(session.id)).toEqual({ fr: 1 });
  });

  it('refuses a text-only language that is not a session target', async () => {
    const h = await harness();
    await expect(
      h.store.createWebRtcSession(
        callInput({ targetLanguages: ['es'], textOnlyLanguages: ['fr'] }),
      ),
    ).rejects.toMatchObject({
      name: 'MediaIngestError',
      code: 'unsupported-language',
      statusCode: 400,
    });
  });
});

function wavFixture(): Buffer {
  const samples = Buffer.alloc(320);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

/* ============================================================================
 * P6.4 HARD INTEGRATION BLOCKER — multiple audio target languages are
 * multiple legitimate generated outputs.
 *
 * The pre-W5 realtime path synthesized only targetLanguages[0] on finals. At
 * conference size that silently un-translates somebody: B hears French and C
 * hears Spanish, and only one of them gets a voice. The locked rule:
 *
 *   Do not solve the first-target defect by reordering targetLanguages.
 *   Remove the assumption that only one generated-audio target can exist.
 *
 * These tests pin the removal: every audio-flagged target is synthesized for
 * the same final segment, with per-language clip identity, and ARRAY POSITION
 * decides nothing.
 * ========================================================================== */

describe('multi-audio-target synthesis (P6.4 blocker)', () => {
  it('synthesizes EVERY audio target of one final segment — fr and es each get exactly one clip', async () => {
    const h = await harness();
    const session = await h.store.createWebRtcSession(
      callInput({
        targetLanguages: ['fr', 'es'],
        voiceIdsByLanguage: { fr: 'fr-voice-1', es: 'es-voice-1' },
      }),
    );

    const updated = await ingestChunk(h, session.id, 0);

    // STT once, translation once per language.
    expect(h.transcriptionEvents.filter((event) => event.endsWith(':transcribed'))).toHaveLength(1);
    expect(h.translationRequests.map((request) => request.targetLanguage).sort()).toEqual([
      'es',
      'fr',
    ]);
    // One synthesis per audio language, each with its own mapped voice.
    expect(
      h.ttsRequests.map((request) => `${request.targetLanguage}:${request.voiceId}`).sort(),
    ).toEqual(['es:es-voice-1', 'fr:fr-voice-1']);
    // One published clip per language, distinctly identified.
    expect([...h.generatedReady].sort()).toEqual(['0:es:es-voice-1', '0:fr:fr-voice-1']);
    const generatedLanguages = updated.generatedAudio.events
      .filter((event) => event.status === 'generated')
      .map((event) => event.targetLanguage)
      .sort();
    expect(generatedLanguages).toEqual(['es', 'fr']);
    expect(h.store.skippedSynthesisCounts(session.id)).toEqual({});
  });

  it('array position decides nothing: reversed target order produces the identical synthesized set', async () => {
    const h = await harness();
    const session = await h.store.createWebRtcSession(
      callInput({
        targetLanguages: ['es', 'fr'],
        voiceIdsByLanguage: { fr: 'fr-voice-1', es: 'es-voice-1' },
      }),
    );

    await ingestChunk(h, session.id, 0);

    expect(
      h.ttsRequests.map((request) => `${request.targetLanguage}:${request.voiceId}`).sort(),
    ).toEqual(['es:es-voice-1', 'fr:fr-voice-1']);
  });

  it('four-person matrix segment: two audio languages plus a caption-only requirement yield exactly two syntheses', async () => {
    // A speaks en. B hears fr (Translated), C hears es (Translated), D reads
    // fr captions with Audio Mode Original. D shares the fr TRANSLATION with
    // B, but D alone must never cause synthesis — with B present fr is an
    // audio target because of B, and the counts below are exactly B + C.
    const h = await harness();
    const session = await h.store.createWebRtcSession(
      callInput({
        targetLanguages: ['fr', 'es'],
        voiceIdsByLanguage: { fr: 'fr-voice-1', es: 'es-voice-1' },
      }),
    );

    await ingestChunk(h, session.id, 0);

    expect(h.translationRequests).toHaveLength(2);
    expect(h.ttsRequests).toHaveLength(2);

    // B leaves: fr collapses to caption-only (D still reads it). Modeled as
    // the replacement session the gateway creates after the reconciliation
    // bump: fr text-only, es still audible.
    const after = await h.store.createWebRtcSession(
      callInput({
        sessionId: 'call_call-1_p1_r2',
        revision: 2,
        targetLanguages: ['fr', 'es'],
        textOnlyLanguages: ['fr'],
        voiceIdsByLanguage: { es: 'es-voice-1' },
      }),
    );
    await ingestChunk(h, after.id, 0);

    const afterTts = h.ttsRequests.slice(2);
    expect(afterTts.map((request) => request.targetLanguage)).toEqual(['es']);
    expect(h.store.skippedSynthesisCounts(after.id)).toEqual({ fr: 1 });
    // The fr caption channel keeps flowing for D.
    expect(
      h.translationRequests.slice(2).map((request) => request.targetLanguage).sort(),
    ).toEqual(['es', 'fr']);
  });
});
