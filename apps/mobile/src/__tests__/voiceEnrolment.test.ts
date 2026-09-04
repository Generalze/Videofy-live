/** @author masterzee001 */
/**
 * Enrolment against the transcribed media-ingest contract. The fake fetch
 * records what would go on the wire, so a drift from
 * voice-profile-init-route.ts or voice-enrollment-route.ts lands here as a
 * diff instead of as a 4xx on a real phone.
 */
import { describe, expect, it } from 'vitest';
import {
  deleteVoice,
  enrolVoice,
  ENROLMENT_MIME_TYPE,
  judgeTake,
  readEnrolmentReply,
  takeCounter,
  VOICE_CONSENT_TEXT_VERSION,
} from '../people/voiceEnrolment';

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function harness(replies: readonly { status: number; body: unknown }[]) {
  const sent: Sent[] = [];
  let index = 0;
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    sent.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
      body: init.body,
    });
    const reply = replies[index] ?? { status: 500, body: {} };
    index += 1;
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  };
  return { fetch, sent };
}

const audio = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]).buffer;

describe('enrolVoice', () => {
  it('records consent first, then posts the raw sample to that profile', async () => {
    const { fetch, sent } = harness([
      { status: 201, body: { voiceProfileId: 'vp_1', state: 'consented' } },
      { status: 201, body: { state: 'ready', personalVoiceReady: true } },
    ]);
    const outcome = await enrolVoice({ fetch, ingestUrl: 'https://c7.example/media', token: 'tok', enrolledLanguage: 'yo', audio, mimeType: ENROLMENT_MIME_TYPE });

    expect(sent[0]).toEqual({
      url: 'https://c7.example/media/voice-profiles',
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tok' },
      body: JSON.stringify({ consentTextVersion: VOICE_CONSENT_TEXT_VERSION, callUseGranted: true, trainingUseGranted: false }),
    });
    expect(sent[1]?.url).toBe('https://c7.example/media/voice-profiles/vp_1/enrollment');
    expect(sent[1]?.method).toBe('POST');
    expect(sent[1]?.headers).toEqual({
      'content-type': 'audio/mp4',
      authorization: 'Bearer tok',
      'x-videofy-enrolled-language': 'yo',
    });
    expect(sent[1]?.body).toBe(audio);
    expect(outcome).toEqual({ ok: true, personalVoiceReady: true, message: 'Your voice is ready. Translated speech will sound like you.' });
  });

  it('never grants training use', async () => {
    const { fetch, sent } = harness([{ status: 400, body: { error: 'nope' } }]);
    await enrolVoice({ fetch, ingestUrl: 'x', token: 't', enrolledLanguage: 'en', audio, mimeType: ENROLMENT_MIME_TYPE });
    expect(JSON.parse(String(sent[0]?.body)).trainingUseGranted).toBe(false);
  });

  it('stops after a refused consent and says why', async () => {
    const { fetch, sent } = harness([{ status: 400, body: { error: 'Permission to use your voice for translated speech is required.' } }]);
    const outcome = await enrolVoice({ fetch, ingestUrl: 'x', token: 't', enrolledLanguage: 'en', audio, mimeType: ENROLMENT_MIME_TYPE });
    expect(sent).toHaveLength(1);
    expect(outcome).toEqual({ ok: false, message: 'Permission to use your voice for translated speech is required.' });
  });

  it('reports a saved-but-not-ready enrolment as saved, not as ready', async () => {
    const { fetch } = harness([
      { status: 201, body: { voiceProfileId: 'vp_2' } },
      { status: 202, body: { state: 'enrolled', personalVoiceReady: false, message: 'Your recording was saved. Personal voice is not available yet.' } },
    ]);
    const outcome = await enrolVoice({ fetch, ingestUrl: 'x', token: 't', enrolledLanguage: 'en', audio, mimeType: ENROLMENT_MIME_TYPE });
    expect(outcome).toEqual({ ok: true, personalVoiceReady: false, message: 'Your recording was saved. Personal voice is not available yet.' });
  });

  it('carries the service refusal of the phone format, in the service words', async () => {
    const { fetch } = harness([
      { status: 201, body: { voiceProfileId: 'vp_3' } },
      { status: 415, body: { error: 'Unsupported recording format.' } },
    ]);
    const outcome = await enrolVoice({ fetch, ingestUrl: 'x', token: 't', enrolledLanguage: 'en', audio, mimeType: ENROLMENT_MIME_TYPE });
    expect(outcome).toEqual({ ok: false, message: 'Unsupported recording format.' });
  });

  it('turns a network failure into words, never a throw', async () => {
    const fetch = async (): Promise<Response> => {
      throw new Error('offline');
    };
    const outcome = await enrolVoice({ fetch, ingestUrl: 'x', token: 't', enrolledLanguage: 'en', audio, mimeType: ENROLMENT_MIME_TYPE });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('Could not reach C7');
  });
});

describe('readEnrolmentReply', () => {
  it('maps the statuses the route can answer', () => {
    expect(readEnrolmentReply(401, {}).message).toBe('Sign in again to record your voice.');
    expect(readEnrolmentReply(413, {}).message).toContain('too long');
    expect(readEnrolmentReply(409, { error: 'Permission to use your voice has not been given yet.' }).message).toBe('Permission to use your voice has not been given yet.');
    expect(readEnrolmentReply(500, {}).message).toBe('Your voice could not be saved.');
  });
});

describe('deleteVoice', () => {
  it('sends the owner-scoped delete and reads the answer', async () => {
    const { fetch, sent } = harness([{ status: 200, body: { deleted: 1, generatedAudioRemoved: 0, nothingLeft: true } }]);
    const outcome = await deleteVoice({ fetch, ingestUrl: 'https://c7.example/media', token: 'tok' });
    expect(sent[0]?.url).toBe('https://c7.example/media/voice-profiles');
    expect(sent[0]?.method).toBe('DELETE');
    expect(sent[0]?.headers).toEqual({ authorization: 'Bearer tok' });
    expect(outcome).toEqual({ ok: true, message: 'Your voice was deleted.' });
  });

  it('says nothing was there when nothing was there', async () => {
    const { fetch } = harness([{ status: 200, body: { deleted: 0, generatedAudioRemoved: 0, nothingLeft: true } }]);
    expect((await deleteVoice({ fetch, ingestUrl: 'x', token: 't' })).message).toBe('There was no recorded voice to delete.');
  });

  it('does not report success for a request that never arrived', async () => {
    const fetch = async (): Promise<Response> => {
      throw new Error('offline');
    };
    expect((await deleteVoice({ fetch, ingestUrl: 'x', token: 't' })).ok).toBe(false);
  });
});

describe('the take', () => {
  it('needs twenty seconds', () => {
    expect(judgeTake(19_999)).toBe('too-short');
    expect(judgeTake(20_000)).toBe('ok');
  });

  it('counts in m:ss', () => {
    expect(takeCounter(0)).toBe('0:00');
    expect(takeCounter(12_400)).toBe('0:12');
    expect(takeCounter(61_000)).toBe('1:01');
  });
});
