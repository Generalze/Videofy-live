import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaStateEvent } from '@videofy-live/shared-types';
import {
  createProcessingSession,
  fetchTargetLanguageCatalogue,
  refreshProcessingSessionFromMediaState,
  type ProcessingSessionDto,
} from './ingestClient';

describe('fetchTargetLanguageCatalogue', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the deployment catalogue from GET /languages/catalogue before any programme exists', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('http://localhost:3002/languages/catalogue');
      return new Response(
        JSON.stringify({
          service: 'media-ingest',
          catalogue: [{ language: 'fr', label: 'French', state: 'available', translationAvailable: true, voiceAvailable: true, textOnly: false, experimental: false, availability: 'voice-available', translationModel: null, voiceId: null, license: '', commercialUse: 'unknown' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const catalogue = await fetchTargetLanguageCatalogue('http://localhost:3002');
    expect(catalogue.map((entry) => entry.language)).toEqual(['fr']);
  });

  it('fails loudly when the catalogue is missing, so the console shows an honest unavailable state', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    await expect(fetchTargetLanguageCatalogue('http://localhost:3002')).rejects.toThrow(/503/);
  });
});

describe('createProcessingSession', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('submits a requested processing session ID with uploaded programme media', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body;
      expect(body).toBeInstanceOf(FormData);
      expect((body as FormData).get('requestedSessionId')).toBe('wrs_uploaded_video');
      expect((body as FormData).get('targetLanguage')).toBe('es');
      return new Response(
        JSON.stringify({
          session: {
            id: 'wrs_uploaded_video',
            streamId: 'stream_uploaded_video',
            state: 'completed',
          },
        }),
        {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const session = await createProcessingSession(
      'http://localhost:3002',
      new File(['demo'], 'demo.mp4', { type: 'video/mp4' }),
      'es',
      {
        requestedSessionId: 'wrs_uploaded_video',
        targetLanguages: ['es'],
        sourceLanguage: 'en',
        sourceLanguageMode: 'manual',
      },
    );

    expect(session.id).toBe('wrs_uploaded_video');
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3002/sessions', {
      method: 'POST',
      body: expect.any(FormData),
    });
  });
});

describe('refreshProcessingSessionFromMediaState', () => {
  function sessionDto(overrides: Partial<ProcessingSessionDto> = {}): ProcessingSessionDto {
    return {
      id: 'wrs_uploaded_video',
      streamId: 'stream_uploaded_video',
      state: 'processing',
      ...overrides,
    } as ProcessingSessionDto;
  }

  function mediaState(overrides: Partial<MediaStateEvent> = {}): MediaStateEvent {
    return {
      processingSessionId: 'wrs_uploaded_video',
      streamStatus: 'completed',
      ...overrides,
    } as MediaStateEvent;
  }

  it('adopts the fresher stream status for the matching processing session', () => {
    const session = sessionDto({ state: 'created' });

    const refreshed = refreshProcessingSessionFromMediaState(session, mediaState());

    expect(refreshed).not.toBe(session);
    expect(refreshed).toMatchObject({ id: 'wrs_uploaded_video', state: 'completed' });
    expect(session.state).toBe('created');
  });

  it('ignores media state for other sessions or without a session id', () => {
    const session = sessionDto();

    expect(
      refreshProcessingSessionFromMediaState(
        session,
        mediaState({ processingSessionId: 'wrs_other' }),
      ),
    ).toBe(session);
    const detached = mediaState();
    delete (detached as { processingSessionId?: string }).processingSessionId;
    expect(refreshProcessingSessionFromMediaState(session, detached)).toBe(session);
  });

  it('returns the same session when the status is unchanged and passes null through', () => {
    const session = sessionDto({ state: 'completed' });

    expect(refreshProcessingSessionFromMediaState(session, mediaState())).toBe(session);
    expect(refreshProcessingSessionFromMediaState(null, mediaState())).toBeNull();
  });
});
