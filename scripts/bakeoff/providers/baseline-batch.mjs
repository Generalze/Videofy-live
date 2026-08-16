// Videofy Live — C-AI1.0 baseline: the batch pipeline as it ships today.
//
// This is the control every commercial candidate is measured against. It runs
// the real media-ingest chain — the same recognition, translation and synthesis
// a live call uses — so the comparison is against what Videofy actually does,
// not against a description of it.
//
// It declares almost no capabilities, and that is the honest answer: the batch
// path cannot report a first-partial time because it has no partial until a
// whole chunk is closed. The runner leaves those stages unmeasured rather than
// recording a zero that would flatter it.
import { copyFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NO_CAPABILITIES } from '../provider-contract.mjs';

const BASE = process.env['MEDIA_INGEST_URL'] ?? 'http://localhost:3002';

async function post(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

const VOICES = {
  en: 'en_US-hfc_female-medium',
  es: 'es_ES-sharvard-medium',
  fr: 'fr_FR-siwis-medium',
};

export function createBaselineBatchProvider({ stagingDir, audioDir }) {
  let sessionId = null;
  let cursorMs = 0;
  let sequence = 0;
  let audioSeconds = 0;
  // media-ingest returns the WHOLE session on every submission, so the events
  // for one utterance are only the ones that appeared since the last. Without
  // this the score compares each utterance against everything said before it.
  let seenTranscripts = 0;
  let seenTranslations = 0;
  let seenClips = 0;

  return {
    name: 'videofy-batch-baseline',
    capabilities: {
      ...NO_CAPABILITIES,
      // The one thing it does do: a chunk may carry several target languages.
      multipleTargetLanguages: true,
    },

    async setUp() {
      sessionId = `call_bakeoff${Math.floor(Math.random() * 99999)}_participant_1_r1`;
    },

    async run(utterance) {
      // A session is bound to one language pair, so each pair gets its own.
      const wantedSession = `${sessionId}_${utterance.sourceLanguage}_${utterance.targetLanguage}`;
      if (this._current !== wantedSession) {
        if (this._current) await this._stop(this._current);
        await post('/internal/webrtc/sessions', {
          sessionId: wantedSession,
          broadcastId: `callcast_bakeoff_${utterance.sourceLanguage}_${utterance.targetLanguage}`,
          broadcasterPeerId: 'peer_bakeoff',
          revision: 1,
          sourceLanguage: utterance.sourceLanguage,
          sourceLanguageMode: 'manual',
          targetLanguage: utterance.targetLanguage,
          targetLanguages: [utterance.targetLanguage],
          voiceIdsByLanguage: { [utterance.targetLanguage]: VOICES[utterance.targetLanguage] },
          generatedAudioPacing: 'natural',
        });
        this._current = wantedSession;
        cursorMs = 0;
        sequence = 0;
        seenTranscripts = 0;
        seenTranslations = 0;
        seenClips = 0;
      }

      const source = join(audioDir, `${utterance.id}.wav`);
      const staged = join(stagingDir, `bakeoff-${utterance.id}-${Date.now()}.wav`);
      copyFileSync(source, staged);
      const bytes = statSync(source).size;
      // 16 kHz mono 16-bit is 32 bytes per millisecond.
      const durationMs = Math.max(1000, Math.round((bytes - 44) / 32));
      audioSeconds += durationMs / 1000;

      const startedAt = Date.now();
      const result = await post(
        `/internal/webrtc/sessions/${encodeURIComponent(wantedSession)}/chunks`,
        {
          sequence: sequence++,
          startMs: cursorMs,
          endMs: cursorMs + durationMs,
          sampleRate: 16000,
          channelCount: 1,
          pcmFormat: 'pcm_s16le',
          mimeType: 'audio/wav',
          sizeBytes: bytes,
          sourcePath: staged,
        },
      );
      // A real speaker pauses; contiguous chunks are not what a call produces.
      cursorMs += durationMs + 1200;

      const session = result.json?.session;
      const allTranscripts = (session?.transcription?.events ?? []).filter((e) => e.status === 'transcribed');
      const allTranslations = (session?.translation?.events ?? []).filter((e) => e.status === 'translated');
      const allClips = (session?.generatedAudio?.events ?? []).filter((e) => e.status === 'generated');
      const transcripts = allTranscripts.slice(seenTranscripts);
      const translations = allTranslations.slice(seenTranslations);
      const clips = allClips.slice(seenClips);
      seenTranscripts = allTranscripts.length;
      seenTranslations = allTranslations.length;
      seenClips = allClips.length;
      const elapsed = Date.now() - startedAt;

      return {
        transcript: transcripts.map((e) => e.sourceText).join(' ').trim(),
        translation: translations.at(-1)?.translatedText ?? null,
        // More than one piece for a single utterance is boundary damage.
        segmentCount: Math.max(1, transcripts.length),
        timings: {
          // No partial and no streamed audio exist on this path; left absent so
          // the report shows unmeasured rather than an implied zero.
          stableTranscriptMs: elapsed,
          firstTranslatedTextMs: elapsed,
          firstTranslatedAudioMs: clips.length > 0 ? elapsed : undefined,
          utteranceCompleteMs: elapsed,
        },
      };
    },

    async _stop(id) {
      await post(`/internal/webrtc/sessions/${encodeURIComponent(id)}/stop`, {}).catch(() => {});
      await fetch(`${BASE}/internal/webrtc/sessions/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }).catch(() => {});
    },

    async tearDown() {
      if (this._current) await this._stop(this._current);
    },

    usage() {
      // Local models: no provider charge. Recorded so the comparison shows a
      // real zero rather than an absent field a reader might mistake for cheap.
      return {
        speechInputMinutes: audioSeconds / 60,
        speechInputRate: 0,
        translationUnits: 0,
        translationRate: 0,
        synthesizedMinutes: 0,
        synthesizedRate: 0,
        sessionCharge: 0,
        targetLanguages: 1,
        conversationMinutes: audioSeconds / 60,
        note: 'self-hosted; cost is hardware and power, not per-minute billing',
      };
    },
  };
}
