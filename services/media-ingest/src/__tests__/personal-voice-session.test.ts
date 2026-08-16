/** @owner masterzee001 */
/**
 * P6.3 acceptance: does a speaker's own voice actually reach synthesis?
 *
 * These tests drive a REAL ProcessingSessionStore, a REAL VoiceProfileStore and
 * the REAL routing provider, composed the same way `index.ts` composes them.
 * That is deliberate and it is the whole point of the file.
 *
 * Every previous "personal voice works" claim in this milestone was made on
 * unit tests that mocked the thing being asserted — the provider was correct,
 * the router was correct, and nothing in the running system called either. A
 * test that stubs the wiring cannot fail when the wiring is missing, so these
 * assert against the session pipeline itself: audio in, generated audio out,
 * and the voice that was actually used.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessingSessionStore } from '../media-session.js';
import { personalVoiceId } from '../openvoice-personal-voice.js';
import { createPersonalVoiceWiring } from '../personal-voice-wiring.js';
import {
  VoiceProfileStore,
  type VoiceEnrollmentStoragePort,
} from '../voice-profile-store.js';
import type {
  TextToSpeechProvider,
  TextToSpeechProviderInput,
} from '../text-to-speech-provider.js';

const OWNER_A = 'devid_aaaaaaaaaaaa';
const OWNER_B = 'devid_bbbbbbbbbbbb';
/** The session's own standard voice, distinct from the service-wide default. */
const SESSION_STANDARD_VOICE = 'es_ES-sharvard-female';
const SERVICE_DEFAULT_VOICE = 'en_US-default';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'videofy-personal-voice-'));
  tempDirs.push(dir);
  return dir;
}

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

/** Distinguishable from the standard provider's output by its bytes alone. */
function personalAudio(): Uint8Array {
  const wav = wavFixture();
  wav.write('PERS', 44);
  return new Uint8Array(wav);
}

function memoryEnrollmentStorage(): VoiceEnrollmentStoragePort {
  return {
    writeEnrollmentRecording: async (profileId) => `rec_${profileId}`,
    readEnrollmentRecording: async () => new Uint8Array([1, 2, 3, 4]),
    deleteEnrollmentRecording: async () => 'removed',
    deleteVoiceAsset: async () => 'removed',
  };
}

interface Harness {
  readonly voices: VoiceProfileStore;
  readonly sessions: ProcessingSessionStore;
  readonly stagingDir: string;
  /** voiceId reported on each generated-audio event, in order. */
  readonly spokenWith: string[];
  /** Every asset ref the engine was asked to speak with, in order. */
  readonly engineAssetRefs: string[];
  /** Text the engine was asked to speak, in order. */
  readonly engineText: string[];
  /** Inputs the standard provider actually received, in order. */
  readonly standardCalls: TextToSpeechProviderInput[];
  /** Every session snapshot pushed to the operator dashboard. */
  readonly emitted: unknown[];
  /** Flip to make the engine fail the way a dying service does. */
  failPersonalSynthesis: boolean;
}

/**
 * The service, assembled from the SAME wiring `index.ts` uses.
 *
 * `createPersonalVoiceWiring` is imported, not reimplemented. A test that
 * rebuilt those two functions would pass while the running service used
 * different ones — which is precisely how this milestone twice reported a
 * working personal voice that had never been connected to anything.
 */
async function harness(): Promise<Harness> {
  const outputBaseDir = await createTempDir();
  const stagingDir = await createTempDir();
  const voices = new VoiceProfileStore(memoryEnrollmentStorage());

  const spokenWith: string[] = [];
  const engineAssetRefs: string[] = [];
  const engineText: string[] = [];
  const standardCalls: TextToSpeechProviderInput[] = [];
  const emitted: unknown[] = [];
  const state = { failPersonalSynthesis: false };

  const standard: TextToSpeechProvider = {
    name: 'piper',
    generate: async (input) => {
      standardCalls.push(input);
      await writeFile(input.outputPath, wavFixture());
      return { audioPath: input.outputPath, providerLatencyMs: 1 };
    },
  };

  const wiring = createPersonalVoiceWiring({
    voiceProfileStore: voices,
    engine: {
      synthesize: async (input) => {
        engineAssetRefs.push(input.voiceAssetRef);
        engineText.push(input.text);
        if (state.failPersonalSynthesis) {
          return { ok: false as const, reason: 'provider-unavailable' };
        }
        return { ok: true as const, audio: personalAudio() };
      },
    },
    defaultVoiceId: SERVICE_DEFAULT_VOICE,
    writeAudio: async (outputPath, audio) => {
      await writeFile(outputPath, audio);
    },
  });

  const sessions = new ProcessingSessionStore({
    outputBaseDir,
    webRtcStagingDir: stagingDir,
    translationTargetLanguage: 'es',
    translationSupportedTargetLanguages: ['es'],
    textToSpeechSupportedLanguages: ['es'],
    textToSpeechVoiceId: SERVICE_DEFAULT_VOICE,
    textToSpeechProvider: wiring.wrapTextToSpeechProvider(standard),
    resolvePersonalVoiceId: wiring.resolvePersonalVoiceId,
    onGeneratedAudioReady: (event) => spokenWith.push(event.voiceId),
    onSessionChange: (session) => emitted.push(session),
  });

  return {
    voices,
    sessions,
    stagingDir,
    spokenWith,
    engineAssetRefs,
    engineText,
    standardCalls,
    emitted,
    get failPersonalSynthesis() {
      return state.failPersonalSynthesis;
    },
    set failPersonalSynthesis(value: boolean) {
      state.failPersonalSynthesis = value;
    },
  };
}

/** A ready-to-use voice, through the real consent lifecycle. */
async function enrolledVoice(
  voices: VoiceProfileStore,
  profileId: string,
  ownerId: string,
): Promise<void> {
  voices.begin({ voiceProfileId: profileId, ownerId, consentTextVersion: 'v1' });
  voices.grantCallUse(profileId);
  await voices.attachEnrollmentRecording(profileId, new Uint8Array([1, 2, 3]), 'en');
  voices.accept(profileId, `ov2_${profileId}`);
}

async function joinCall(
  h: Harness,
  sessionId: string,
  voiceOwnerId?: string,
): Promise<string> {
  const session = await h.sessions.createWebRtcSession({
    sessionId,
    broadcastId: `callcast_${sessionId}`,
    broadcasterPeerId: `peer_${sessionId}`,
    revision: 1,
    targetLanguage: 'es',
    targetLanguages: ['es'],
    sourceLanguage: 'en',
    sourceLanguageMode: 'manual',
    voiceIdsByLanguage: { es: SESSION_STANDARD_VOICE },
    ...(voiceOwnerId ? { voiceOwnerId } : {}),
  });
  return session.id;
}

/** One utterance. The session is never recreated, which is the point. */
async function say(h: Harness, sessionId: string, sequence: number): Promise<void> {
  const sourcePath = join(h.stagingDir, `utterance-${sequence}.wav`);
  await writeFile(sourcePath, wavFixture());
  await h.sessions.ingestWebRtcChunk(sessionId, {
    sequence,
    startMs: sequence * 15_000,
    endMs: (sequence + 1) * 15_000,
    sampleRate: 16000,
    channelCount: 1,
    pcmFormat: 'pcm_s16le',
    mimeType: 'audio/wav',
    sizeBytes: wavFixture().length,
    sourcePath,
  });
}

describe('a speaker with no personal voice is completely unaffected', () => {
  it('A: speaks in the standard voice when the call carries no owner', async () => {
    const h = await harness();
    const sessionId = await joinCall(h, 'call_a_participant_1');

    await say(h, sessionId, 0);

    expect(h.spokenWith).toEqual([SESSION_STANDARD_VOICE]);
    expect(h.engineAssetRefs).toEqual([]);
  });

  it('B: speaks in the standard voice when the owner has no usable profile', async () => {
    // An owner who opened enrollment and never finished it. Nothing is ready,
    // so nothing personal may be spoken.
    const h = await harness();
    h.voices.begin({ voiceProfileId: 'vp_half', ownerId: OWNER_A, consentTextVersion: 'v1' });
    h.voices.grantCallUse('vp_half');
    const sessionId = await joinCall(h, 'call_b_participant_1', OWNER_A);

    await say(h, sessionId, 0);

    expect(h.spokenWith).toEqual([SESSION_STANDARD_VOICE]);
    expect(h.engineAssetRefs).toEqual([]);
  });
});

describe('a speaker with a ready voice is heard in it', () => {
  it('C: routes the utterance to the engine with that profile asset', async () => {
    const h = await harness();
    await enrolledVoice(h.voices, 'vp_a', OWNER_A);
    const sessionId = await joinCall(h, 'call_c_participant_1', OWNER_A);

    await say(h, sessionId, 0);

    expect(h.spokenWith).toEqual([personalVoiceId('vp_a')]);
    expect(h.engineAssetRefs).toEqual(['ov2_vp_a']);
    expect(h.standardCalls).toHaveLength(0);
  });

  it('D: never reaches another owner’s voice', async () => {
    // Both profiles exist in one store, so the lookup has a wrong answer
    // available to it and must not choose it.
    const h = await harness();
    await enrolledVoice(h.voices, 'vp_a', OWNER_A);
    await enrolledVoice(h.voices, 'vp_b', OWNER_B);
    const sessionId = await joinCall(h, 'call_d_participant_1', OWNER_B);

    await say(h, sessionId, 0);

    expect(h.spokenWith).toEqual([personalVoiceId('vp_b')]);
    expect(h.engineAssetRefs).toEqual(['ov2_vp_b']);
  });
});

describe('consent changes take effect on the next utterance, not the next call', () => {
  it('E: revoking mid-call moves the very next utterance to the standard voice', async () => {
    const h = await harness();
    await enrolledVoice(h.voices, 'vp_a', OWNER_A);
    const sessionId = await joinCall(h, 'call_e_participant_1', OWNER_A);

    await say(h, sessionId, 0);
    await h.voices.revoke('vp_a');
    await say(h, sessionId, 1);

    // No new session, no reconnect, no revision bump: the same live call.
    expect(h.spokenWith).toEqual([personalVoiceId('vp_a'), SESSION_STANDARD_VOICE]);
    expect(h.engineAssetRefs).toEqual(['ov2_vp_a']);
  });

  it('F: deleting mid-call moves the very next utterance to the standard voice', async () => {
    const h = await harness();
    await enrolledVoice(h.voices, 'vp_a', OWNER_A);
    const sessionId = await joinCall(h, 'call_f_participant_1', OWNER_A);

    await say(h, sessionId, 0);
    await h.voices.delete('vp_a');
    await say(h, sessionId, 1);

    expect(h.spokenWith).toEqual([personalVoiceId('vp_a'), SESSION_STANDARD_VOICE]);
  });

  it('G: re-recording mid-call moves the next utterance to the NEW profile', async () => {
    const h = await harness();
    await enrolledVoice(h.voices, 'vp_a1', OWNER_A);
    const sessionId = await joinCall(h, 'call_g_participant_1', OWNER_A);

    await say(h, sessionId, 0);
    await h.voices.delete('vp_a1');
    await enrolledVoice(h.voices, 'vp_a2', OWNER_A);
    await say(h, sessionId, 1);

    expect(h.spokenWith).toEqual([personalVoiceId('vp_a1'), personalVoiceId('vp_a2')]);
    expect(h.engineAssetRefs).toEqual(['ov2_vp_a1', 'ov2_vp_a2']);
  });
});

describe('a failing voice engine costs the voice, never the words', () => {
  it('H: re-speaks the same text in the session’s own standard voice', async () => {
    const h = await harness();
    await enrolledVoice(h.voices, 'vp_a', OWNER_A);
    const sessionId = await joinCall(h, 'call_h_participant_1', OWNER_A);
    h.failPersonalSynthesis = true;

    await say(h, sessionId, 0);

    expect(h.standardCalls).toHaveLength(1);
    const fallback = h.standardCalls[0]!;
    // Not the service-wide default: that voice speaks the wrong language here.
    expect(fallback.voiceId).toBe(SESSION_STANDARD_VOICE);
    expect(fallback.voiceId).not.toBe(SERVICE_DEFAULT_VOICE);
    // The listener is owed the words that were already translated.
    expect(fallback.translatedText).toBe(h.engineText[0]);
    expect(fallback.translatedText.length).toBeGreaterThan(0);
    // And the record says what was actually spoken, not what was attempted.
    expect(h.spokenWith).toEqual([SESSION_STANDARD_VOICE]);
  });

  it('delivers the personal audio bytes when the engine succeeds', async () => {
    // Proves the engine's audio is what lands on disk. Reporting
    // `personal:<id>` while writing Piper output would pass every other
    // assertion in this file.
    const h = await harness();
    await enrolledVoice(h.voices, 'vp_a', OWNER_A);
    const sessionId = await joinCall(h, 'call_i_participant_1', OWNER_A);

    await say(h, sessionId, 0);
    const session = h.sessions.get(sessionId)!;
    const event = session.generatedAudio.events.find((item) => item.status === 'generated')!;
    const written = await readFile(
      join(
        (h.sessions as unknown as { outputBaseDir: string }).outputBaseDir,
        sessionId,
        'tts',
        'es',
        event.audioFilename,
      ),
    );

    expect(written.subarray(44, 48).toString()).toBe('PERS');
  });
});

describe('withdrawal reaches audio that already exists', () => {
  it('destroys the generated clips, so a queued one cannot be fetched', async () => {
    // The decisive property. Translated speech is generated ahead of playback
    // and sits in every listener's queue, so consent withdrawal that only
    // changed future routing would let several more cloned utterances play
    // out while the system considered itself compliant. The only thing this
    // process controls is whether the bytes are still there to fetch.
    const h = await harness();
    await enrolledVoice(h.voices, 'vp_a', OWNER_A);
    const sessionId = await joinCall(h, 'call_m_participant_1', OWNER_A);
    await say(h, sessionId, 0);
    await say(h, sessionId, 1);

    const outputBase = (h.sessions as unknown as { outputBaseDir: string }).outputBaseDir;
    const clipPath = (sequence: number) =>
      join(outputBase, sessionId, 'tts', 'es', `tts-${String(sequence).padStart(6, '0')}.wav`);
    await expect(readFile(clipPath(0))).resolves.toBeDefined();

    const removed = await h.sessions.purgePersonalVoiceAudio(personalVoiceId('vp_a'));

    expect(removed).toBe(2);
    await expect(readFile(clipPath(0))).rejects.toBeDefined();
    await expect(readFile(clipPath(1))).rejects.toBeDefined();
    // The record stops advertising a clip that can no longer be played.
    const session = h.sessions.get(sessionId)!;
    expect(session.generatedAudio.events.every((e) => e.status !== 'generated')).toBe(true);
  });

  it('leaves audio spoken in every other voice alone', async () => {
    // A withdrawal that reached further than the voice withdrawn would delete
    // other people's translated speech out of a live call.
    const h = await harness();
    await enrolledVoice(h.voices, 'vp_a', OWNER_A);
    const mine = await joinCall(h, 'call_n_participant_1', OWNER_A);
    const theirs = await joinCall(h, 'call_n_participant_2');
    await say(h, mine, 0);
    await say(h, theirs, 0);

    const removed = await h.sessions.purgePersonalVoiceAudio(personalVoiceId('vp_a'));

    expect(removed).toBe(1);
    const untouched = h.sessions.get(theirs)!;
    expect(untouched.generatedAudio.events.some((e) => e.status === 'generated')).toBe(true);
  });
});

describe('the owner never leaks out of media-ingest', () => {
  it('is absent from the session every route and the dashboard can see', async () => {
    const h = await harness();
    await enrolledVoice(h.voices, 'vp_a', OWNER_A);
    const sessionId = await joinCall(h, 'call_j_participant_1', OWNER_A);

    await say(h, sessionId, 0);

    // ProcessingSession is what the HTTP routes return and what is pushed to
    // the operator dashboard, so the owner must be reachable through neither.
    expect(JSON.stringify(h.sessions.get(sessionId))).not.toContain('devid_');
    expect(h.emitted.length).toBeGreaterThan(0);
    expect(JSON.stringify(h.emitted)).not.toContain('devid_');
  });

  it('refuses a session whose owner id is not a real voice identity', async () => {
    // A participant id, a socket id or a display name would each be a string in
    // scope at the call site. None of them may become a voice owner.
    const h = await harness();

    await expect(
      h.sessions.createWebRtcSession({
        sessionId: 'call_k_participant_1',
        broadcastId: 'callcast_k',
        broadcasterPeerId: 'peer_k',
        revision: 1,
        targetLanguage: 'es',
        sourceLanguage: 'en',
        sourceLanguageMode: 'manual',
        voiceOwnerId: 'participant_1',
      }),
    ).rejects.toMatchObject({ code: 'invalid-media' });
  });

  it('forgets the owner when the call session is removed', async () => {
    const h = await harness();
    await enrolledVoice(h.voices, 'vp_a', OWNER_A);
    const sessionId = await joinCall(h, 'call_l_participant_1', OWNER_A);
    await say(h, sessionId, 0);

    h.sessions.stopWebRtcSession(sessionId);
    await h.sessions.removeCallSession(sessionId);

    const owners = (h.sessions as unknown as { voiceOwnersBySession: Map<string, string> })
      .voiceOwnersBySession;
    expect(owners.size).toBe(0);
  });
});
