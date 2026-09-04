import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaStateEvent } from '@videofy-live/shared-types';
import {
  cancelProcessingSession,
  createMicrophoneSession,
  createProcessingSession,
  exportTranscript,
  fetchTargetLanguageCatalogue,
  pauseProcessingSession,
  refreshProcessingSessionFromMediaState,
  resumeProcessingSession,
  sendMicrophoneChunk,
  updateSourceLanguageControl,
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
      // No session in this test's (absent) storage, so no bearer is sent.
      headers: {},
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

describe('programme control authorization', () => {
  const stored = new Map<string, string>();

  beforeEach(() => {
    stored.clear();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  const okSession = () =>
    new Response(JSON.stringify({ session: { id: 'ps_1', streamId: 'stream_1', state: 'live' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  it('sends the C7 session as a bearer on every programme route, read at call time', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push({ url: String(url), auth: headers.get('authorization') });
        return okSession();
      }),
    );
    stored.set('videofy-account:session', JSON.stringify({ accountId: 'acct_a', token: 'tok_first' }));
    await pauseProcessingSession('http://ingest', 'ps_1');
    await createMicrophoneSession('http://ingest', { targetLanguage: 'fr' });
    await updateSourceLanguageControl('http://ingest', 'ps_1', { action: 'confirm' });
    await sendMicrophoneChunk('http://ingest', 'ps_1', { blob: new Blob(['x']), sequence: 1, startMs: 0, endMs: 10 });
    // A sign-in in another tab is honoured by the very next call: nothing is cached.
    stored.set('videofy-account:session', JSON.stringify({ accountId: 'acct_a', token: 'tok_second' }));
    await cancelProcessingSession('http://ingest', 'ps_1');
    expect(seen.map((entry) => entry.auth)).toEqual([
      'Bearer tok_first',
      'Bearer tok_first',
      'Bearer tok_first',
      'Bearer tok_first',
      'Bearer tok_second',
    ]);
    expect(seen.map((entry) => entry.url)).toEqual([
      'http://ingest/sessions/ps_1/pause',
      'http://ingest/microphone/sessions',
      'http://ingest/sessions/ps_1/source-language',
      'http://ingest/microphone/sessions/ps_1/chunks',
      'http://ingest/sessions/ps_1/cancel',
    ]);
  });

  it('sends no bearer when nobody is signed in, and the public catalogue never carries one', async () => {
    const seen: Array<string | null> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('authorization'));
        return String(url).endsWith('/languages/catalogue')
          ? new Response(JSON.stringify({ catalogue: [] }), { status: 200 })
          : okSession();
      }),
    );
    await resumeProcessingSession('http://ingest', 'ps_1');
    stored.set('videofy-account:session', JSON.stringify({ accountId: 'acct_a', token: 'tok_x' }));
    await fetchTargetLanguageCatalogue('http://ingest');
    expect(seen).toEqual([null, null]);
  });

  it("surfaces the service's own refusal sentence on 401 and 403", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'Sign in to operate.' }), { status: 401 })),
    );
    await expect(pauseProcessingSession('http://ingest', 'ps_1')).rejects.toMatchObject({
      name: 'IngestClientError',
      status: 401,
      message: 'Sign in to operate.',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'This account is not enabled for the operator console.' }), {
            status: 403,
          }),
      ),
    );
    await expect(exportTranscript('http://ingest', 'ps_1')).rejects.toMatchObject({
      status: 403,
      message: 'This account is not enabled for the operator console.',
    });
  });
});
