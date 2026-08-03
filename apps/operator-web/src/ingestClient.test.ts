import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProcessingSession } from './ingestClient';

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
