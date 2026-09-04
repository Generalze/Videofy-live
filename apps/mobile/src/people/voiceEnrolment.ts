/** @author masterzee001 */
/**
 * Voice enrolment from the phone: a short sample of your voice, so translated
 * speech sounds like you.
 *
 * TRANSCRIBED FROM THE SERVICE, NOT GUESSED. media-ingest owns the rules
 * (services/media-ingest/src/voice-profile-init-route.ts and
 * voice-enrollment-route.ts): consent is recorded FIRST by creating the
 * profile, then the raw recording is posted to that profile with a truthful
 * content-type, a bearer session token, and the language it was spoken in.
 * The bytes are the authority on format server-side, so the declared type
 * here must be what the phone actually recorded.
 *
 * WHAT THE PHONE RECORDS. expo-audio on Android writes AAC in an MP4
 * container (the HIGH_QUALITY preset: `.m4a`); MediaRecorder has no Opus
 * encoder in this build, so WebM is not an option. The upload therefore
 * declares `audio/mp4`, which the service's container detection understands
 * but its accepted-type list does not yet include. Until that list grows,
 * the honest answer from staging is 415 and this module says so in words.
 *
 * Nothing here logs. Not the audio, not the token, not the profile id.
 */

/** Not a secret: `EXPO_PUBLIC_` values are compiled into the bundle. Staging mounts media-ingest at /media (deploy/staging/Caddyfile). */
export const INGEST_URL = process.env['EXPO_PUBLIC_INGEST_URL'] ?? 'https://staging.consummate7.com/media';

/** The consent wording the person accepted; the same version the web app records. */
export const VOICE_CONSENT_TEXT_VERSION = 'voice-consent-v1';

/** What expo-audio's HIGH_QUALITY preset writes on Android: AAC in MP4 (.m4a). */
export const ENROLMENT_MIME_TYPE = 'audio/mp4';

/** A take shorter than this cannot describe a voice; longer than this is stopped for the person. */
export const MIN_TAKE_MS = 20_000;
export const MAX_TAKE_MS = 30_000;

export type TakeVerdict = 'too-short' | 'ok';

export function judgeTake(durationMs: number): TakeVerdict {
  return durationMs < MIN_TAKE_MS ? 'too-short' : 'ok';
}

/** "0:12" for the recording counter. */
export function takeCounter(elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export type EnrolmentOutcome =
  | { readonly ok: true; readonly personalVoiceReady: boolean; readonly message: string }
  | { readonly ok: false; readonly message: string };

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface EnrolVoiceInput {
  readonly fetch: FetchLike;
  readonly ingestUrl: string;
  /** The session's bearer token, read at upload time and never kept. */
  readonly token: string;
  /** The language the sample was spoken in (`x-videofy-enrolled-language`). */
  readonly enrolledLanguage: string;
  readonly audio: ArrayBuffer;
  readonly mimeType: string;
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await response.json();
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function wordsIn(body: Record<string, unknown>, key: 'error' | 'message'): string | null {
  const value = body[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** The words for what the enrollment route answered (voice-enrollment-route.ts). */
export function readEnrolmentReply(status: number, body: Record<string, unknown>): EnrolmentOutcome {
  if (status === 201 || status === 202) {
    const ready = body['personalVoiceReady'] === true;
    return {
      ok: true,
      personalVoiceReady: ready,
      message: ready
        ? 'Your voice is ready. Translated speech will sound like you.'
        : (wordsIn(body, 'message') ?? 'Your recording was saved. Personal voice is not available yet.'),
    };
  }
  if (status === 401) return { ok: false, message: 'Sign in again to record your voice.' };
  if (status === 413) return { ok: false, message: 'That recording is too long. Keep it under 30 seconds.' };
  if (status === 415) return { ok: false, message: wordsIn(body, 'error') ?? 'That recording format is not supported yet.' };
  return { ok: false, message: wordsIn(body, 'error') ?? 'Your voice could not be saved.' };
}

/**
 * Consent, then the sample. Two requests because the service refuses to let
 * the arrival of audio manufacture the permission to store it.
 */
export async function enrolVoice(input: EnrolVoiceInput): Promise<EnrolmentOutcome> {
  const authorization = `Bearer ${input.token}`;
  let voiceProfileId: string;
  try {
    const begun = await input.fetch(`${input.ingestUrl}/voice-profiles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization },
      body: JSON.stringify({
        consentTextVersion: VOICE_CONSENT_TEXT_VERSION,
        callUseGranted: true,
        trainingUseGranted: false,
      }),
    });
    const body = await bodyOf(begun);
    if (begun.status === 401) return { ok: false, message: 'Sign in again to record your voice.' };
    const id = body['voiceProfileId'];
    if (!begun.ok || typeof id !== 'string' || id.length === 0) {
      return { ok: false, message: wordsIn(body, 'error') ?? 'Enrolment could not be started.' };
    }
    voiceProfileId = id;
  } catch {
    return { ok: false, message: 'Could not reach C7. Check your connection and try again.' };
  }

  try {
    const uploaded = await input.fetch(`${input.ingestUrl}/voice-profiles/${encodeURIComponent(voiceProfileId)}/enrollment`, {
      method: 'POST',
      headers: {
        'content-type': input.mimeType,
        authorization,
        'x-videofy-enrolled-language': input.enrolledLanguage,
      },
      body: input.audio,
    });
    return readEnrolmentReply(uploaded.status, await bodyOf(uploaded));
  } catch {
    return { ok: false, message: 'Could not reach C7. Check your connection and try again.' };
  }
}

export interface DeleteVoiceOutcome {
  readonly ok: boolean;
  readonly message: string;
}

/** "Delete my voice": everything this account holds (voice-withdrawal-route.ts DELETE /voice-profiles). */
export async function deleteVoice(input: { readonly fetch: FetchLike; readonly ingestUrl: string; readonly token: string }): Promise<DeleteVoiceOutcome> {
  try {
    const response = await input.fetch(`${input.ingestUrl}/voice-profiles`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${input.token}` },
    });
    const body = await bodyOf(response);
    if (!response.ok) return { ok: false, message: wordsIn(body, 'error') ?? 'Your voice could not be deleted.' };
    return {
      ok: true,
      message: wordsIn(body, 'message') ?? (body['deleted'] === 0 ? 'There was no recorded voice to delete.' : 'Your voice was deleted.'),
    };
  } catch {
    // A comforting success here would be the worst thing this function could say.
    return { ok: false, message: 'Your voice could not be deleted. Check your connection and try again.' };
  }
}

/** What is on file, from GET /voice-profiles/mine; null when the service could not be asked. */
export type VoiceStatus = 'none' | 'saved' | 'ready';

export async function voiceStatus(input: { readonly fetch: FetchLike; readonly ingestUrl: string; readonly token: string }): Promise<VoiceStatus | null> {
  try {
    const response = await input.fetch(`${input.ingestUrl}/voice-profiles/mine`, {
      headers: { authorization: `Bearer ${input.token}` },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { enrolled?: unknown; personalVoiceReady?: unknown };
    if (body.enrolled !== true) return 'none';
    return body.personalVoiceReady === true ? 'ready' : 'saved';
  } catch {
    return null;
  }
}
