import { describe, expect, it } from 'vitest';
import type { MediaStateEvent, TargetLanguageCapability } from '@videofy-live/shared-types';
import { buildPartnerPreviewReadiness } from './partnerPreviewReadiness';
import { createInitialProgrammeSourceSnapshot } from './programmeSourceManager';

const spanish: TargetLanguageCapability = {
  language: 'es',
  label: 'Spanish',
  experimental: false,
  license: 'reviewed',
  commercialUse: 'unknown',
  translationAvailable: true,
  voiceAvailable: true,
  textOnly: false,
  availability: 'voice-available',
  translationModel: 'Helsinki-NLP/opus-mt-en-es',
  voiceId: 'es_ES-sharvard-medium',
};

function mediaState(listeners = 1): MediaStateEvent {
  return {
    eventId: 'state_demo',
    streamStatus: 'processing',
    videoSource: 'local-file',
    videoTimestampMs: 0,
    sourceAudioActive: true,
    translatedLanguages: ['es'],
    connectedListeners: listeners,
    createdAt: new Date().toISOString(),
  };
}

describe('partner preview readiness', () => {
  it('marks the validated English-to-Spanish path ready when real providers are visible', () => {
    const items = buildPartnerPreviewReadiness({
      gatewayConnected: true,
      mediaIngestHealthy: true,
      programmeSource: {
        ...createInitialProgrammeSourceSnapshot(),
        sourceType: 'uploaded-video',
        status: 'broadcasting',
        previewReady: true,
        audioDetected: true,
        videoDetected: true,
      },
      mediaState: mediaState(),
      sourceLanguageControl: {
        defaultLanguage: 'en',
        activeLanguage: 'en',
        mode: 'auto-detect',
        status: 'locked',
        detectedLanguage: 'en',
        detectionConfidence: 0.98,
        confirmedLanguage: 'en',
        rejectedLanguage: null,
        locked: true,
        revision: 0,
        confidenceThreshold: 0.82,
        updatedAt: new Date().toISOString(),
      },
      targetLanguageCatalogue: [spanish],
      translation: {
        status: 'translated',
        providerName: 'opus-mt',
        providerStatus: 'ready',
        progressPct: 100,
        totalSegments: 1,
        translatedSegments: 1,
        failedSegments: 0,
        sourceLanguage: 'en',
        sourceLanguageRevision: 0,
        targetLanguage: 'es',
        targetLanguages: ['es'],
        events: [],
      },
      generatedAudio: {
        status: 'generated',
        providerName: 'piper',
        providerStatus: 'ready',
        progressPct: 100,
        totalSegments: 1,
        generatedSegments: 1,
        failedSegments: 0,
        targetLanguage: 'es',
        targetLanguages: ['es'],
        voiceId: 'es_ES-sharvard-medium',
        textOnlyLanguages: [],
        outputFormat: { container: 'wav', codec: 'pcm_s16le' },
        events: [],
      },
      selectedTargetLanguages: ['es'],
    });

    expect(items.every((item) => item.state === 'ready')).toBe(true);
    expect(items.find((item) => item.id === 'source')?.detail).toBe(
      'uploaded-video - broadcasting - audio - video',
    );
  });

  it('reports media-ingest upload source state without falsely naming a selected live source', () => {
    const items = buildPartnerPreviewReadiness({
      gatewayConnected: true,
      mediaIngestHealthy: true,
      programmeSource: createInitialProgrammeSourceSnapshot(),
      mediaState: mediaState(),
      selectedTargetLanguages: ['es'],
    });

    expect(items.find((item) => item.id === 'source')).toMatchObject({
      state: 'ready',
      detail: 'media ingest - local-file - audio active',
    });
  });

  it('does not claim ready when Spanish is not selected or listeners are absent', () => {
    const items = buildPartnerPreviewReadiness({
      gatewayConnected: true,
      mediaIngestHealthy: true,
      programmeSource: createInitialProgrammeSourceSnapshot(),
      mediaState: null,
      selectedTargetLanguages: ['fr'],
    });

    expect(items.find((item) => item.id === 'spanish')).toMatchObject({ state: 'warning' });
    expect(items.find((item) => item.id === 'listeners')).toMatchObject({ state: 'warning' });
    expect(items.find((item) => item.id === 'source')).toMatchObject({ state: 'warning' });
  });
});
