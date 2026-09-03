import { readFileSync } from 'node:fs';
import { URL, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { MediaStateEvent, TargetLanguageCapability } from '@videofy-live/shared-types';
import {
  buildPartnerPreviewReadiness,
  preflightVerdict,
  type PartnerPreviewReadinessItem,
  shouldShowMockControls,
} from './partnerPreviewReadiness';
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
  it('shows Phase 1 mock controls only for an explicitly configured mock source', () => {
    expect(shouldShowMockControls(null)).toBe(false);
    expect(shouldShowMockControls(mediaState())).toBe(false);
    expect(shouldShowMockControls({ ...mediaState(), videoSource: 'mock' })).toBe(true);
  });

  it('marks the whole chain ready when every real service and the operator choices say so', () => {
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

  it('does not claim ready when no selected target has a voice or listeners are absent', () => {
    const items = buildPartnerPreviewReadiness({
      gatewayConnected: true,
      mediaIngestHealthy: true,
      programmeSource: createInitialProgrammeSourceSnapshot(),
      mediaState: null,
      selectedTargetLanguages: ['fr'],
    });

    expect(items.find((item) => item.id === 'targets')).toMatchObject({
      state: 'warning',
      detail: 'No selected target language has a voice available yet.',
    });
    expect(items.find((item) => item.id === 'listeners')).toMatchObject({ state: 'warning' });
    expect(items.find((item) => item.id === 'source')).toMatchObject({ state: 'warning' });
  });
});

/*
 * Founder ruling (30 Aug 2026): no EN->ES preset anywhere. Readiness is
 * computed from the operator's actual target languages and from whatever
 * engines the deployment routes to, never from one vendor's name.
 */
describe('readiness has no preset language or vendor', () => {
  const french: TargetLanguageCapability = { ...spanish, language: 'fr', label: 'French', translationModel: 'x', voiceId: 'fr_FR-x' };

  it('is ready for whichever target the operator chose, with any engine that reports ready', () => {
    const items = buildPartnerPreviewReadiness({
      gatewayConnected: true,
      mediaIngestHealthy: true,
      programmeSource: createInitialProgrammeSourceSnapshot(),
      mediaState: { ...mediaState(), translatedLanguages: ['fr'] },
      targetLanguageCatalogue: [spanish, french],
      translation: { status: 'translated', providerName: 'deepl', providerStatus: 'ready', progressPct: 100, totalSegments: 1, translatedSegments: 1, failedSegments: 0, sourceLanguage: 'en', sourceLanguageRevision: 0, targetLanguage: 'fr', targetLanguages: ['fr'], events: [] },
      generatedAudio: { status: 'generated', providerName: 'elevenlabs', providerStatus: 'ready', progressPct: 100, totalSegments: 1, generatedSegments: 1, failedSegments: 0, targetLanguage: 'fr', targetLanguages: ['fr'], voiceId: 'v', textOnlyLanguages: [], outputFormat: { container: 'wav', codec: 'pcm_s16le' }, events: [] },
      selectedTargetLanguages: ['fr'],
    });
    expect(items.find((item) => item.id === 'targets')).toMatchObject({ state: 'ready', detail: 'French - voice-available' });
    expect(items.find((item) => item.id === 'translation')).toMatchObject({ state: 'ready', detail: 'deepl:ready' });
    expect(items.find((item) => item.id === 'tts')).toMatchObject({ state: 'ready', detail: 'elevenlabs:ready' });
  });

  it('describes the source language honestly before a session exists: auto-detect is undecided, manual is a choice', () => {
    const base = { gatewayConnected: false, mediaIngestHealthy: false, programmeSource: createInitialProgrammeSourceSnapshot(), mediaState: null, selectedTargetLanguages: [] };
    expect(buildPartnerPreviewReadiness({ ...base, sourceLanguage: 'en', sourceLanguageMode: 'auto-detect' }).find((item) => item.id === 'language')).toMatchObject({ state: 'warning' });
    expect(buildPartnerPreviewReadiness({ ...base, sourceLanguage: 'yo', sourceLanguageMode: 'manual' }).find((item) => item.id === 'language')).toMatchObject({ state: 'ready', detail: 'YO - set by you' });
  });
});

/*
 * P7: Preflight refuses, rather than warning beside a working button.
 *
 * The page has always computed an honest answer and nothing consulted it: a
 * red line saying the gateway was unreachable sat next to a Go Live that
 * worked. These pin the verdict and the distinction it rests on.
 */
describe('preflightVerdict', () => {
  const item = (
    id: string,
    state: 'ready' | 'warning' | 'blocked',
    label = id,
  ): PartnerPreviewReadinessItem => ({ id, label, state, detail: '' });

  it('allows a programme whose hard dependencies are all satisfied', () => {
    const verdict = preflightVerdict([item('gateway', 'ready'), item('ingest', 'ready')]);
    expect(verdict).toEqual({ canGoLive: true, blockedBy: [], refusal: null });
  });

  it('refuses when a hard dependency is blocked', () => {
    const verdict = preflightVerdict([
      item('gateway', 'blocked', 'Gateway connection'),
      item('ingest', 'ready'),
    ]);
    expect(verdict.canGoLive).toBe(false);
    expect(verdict.blockedBy).toEqual(['Gateway connection']);
    expect(verdict.refusal).toBe('Not ready: Gateway connection.');
  });

  it('names every blocker, so they are not fixed one per attempt', () => {
    const verdict = preflightVerdict([
      item('gateway', 'blocked', 'Gateway connection'),
      item('ingest', 'blocked', 'Media ingest'),
      item('listeners', 'warning', 'Listeners connected'),
    ]);
    expect(verdict.refusal).toBe('Not ready: Gateway connection and Media ingest.');
  });

  it('lets a warning through, because it is not a hard dependency', () => {
    /*
     * A captions-only programme with nobody watching yet is a real way to go
     * on air. Treating every amber line as a blocker would prevent broadcasts
     * that are perfectly valid, which is its own kind of dishonesty.
     */
    const verdict = preflightVerdict([
      item('listeners', 'warning'),
      item('voices', 'warning'),
      item('gateway', 'ready'),
    ]);
    expect(verdict.canGoLive).toBe(true);
  });

  it('is what the Live page actually consults', () => {
    // The join. Page 09's answer is worthless if page 10 does not obey it.
    const source = readFileSync(
      fileURLToPath(new URL('./pages/LivePage.tsx', import.meta.url)),
      'utf8',
    ).replace(/\r\n/gu, '\n');
    expect(source).toContain('&& preflight.canGoLive');
  });
});
