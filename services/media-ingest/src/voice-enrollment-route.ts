/** @owner masterzee001 */
/**
 * The browser's way into voice enrollment (P6.3).
 *
 * Deliberately narrow. It validates the transport — size, declared type, owner
 * shape — and then hands off. Every rule about consent, lifecycle and what may
 * be stored stays in VoiceProfileStore, because a second place that knows how
 * voice profiles work is a second place that can disagree with the first, and
 * the disagreement always surfaces as biometric data existing when it should
 * not.
 *
 * Nothing here is logged. Not the body, not the recording reference, not the
 * derived asset reference, not the owner id. A log line naming any of those
 * identifies whose voice it is and travels to places recordings should not.
 */
import type express from 'express';
import type { AuthenticateRequest } from './account-authentication.js';
import { declaredTypeMatches, detectAudioContainer } from './audio-container.js';
import type { VoiceProfileStore } from './voice-profile-store.js';
import type { VoiceProfileProvider } from './voice-profile-provider.js';

/**
 * A short enrollment sample. Generous for a few sentences of Opus, small
 * enough that an arbitrary blob is refused rather than written to disk.
 */
export const MAX_ENROLLMENT_BYTES = 5 * 1024 * 1024;

/**
 * Declared types we will accept. The header is checked but not trusted: the
 * bytes are stored as supplied and never executed or interpreted here, and the
 * validating engine downstream is the real authority on what it can read.
 */
const ACCEPTED_MIME_PREFIXES = ['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mpeg'];

export interface VoiceEnrollmentRouteDependencies {
  readonly store: VoiceProfileStore;
  readonly provider: VoiceProfileProvider;
  readonly newVoiceProfileId: () => string;
  /**
   * Establishes who is calling from a verified session token. Injected so this
   * route never learns how a token is signed, and so tests cannot accidentally
   * exercise a different rule from the one production uses.
   */
  readonly authenticate: AuthenticateRequest;
}

interface EnrollmentOutcome {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export function registerVoiceEnrollmentRoute(
  app: express.Express,
  deps: VoiceEnrollmentRouteDependencies,
): void {
  app.post(
    '/voice-profiles/:voiceProfileId/enrollment',
    // Raw audio, capped. express.json elsewhere does not apply to this route.
    (req, res, next) => {
      const contentType = req.headers['content-type'] ?? '';
      if (!ACCEPTED_MIME_PREFIXES.some((prefix) => contentType.startsWith(prefix))) {
        res.status(415).json({ error: 'Unsupported recording format.' });
        return;
      }
      next();
    },
    async (req, res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let refused = false;

      req.on('data', (chunk: Buffer) => {
        if (refused) return;
        total += chunk.length;
        if (total > MAX_ENROLLMENT_BYTES) {
          refused = true;
          res.status(413).json({ error: 'That recording is too long.' });
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (refused) return;
        void handleEnrollment(deps, req, Buffer.concat(chunks)).then(
          (outcome) => res.status(outcome.status).json(outcome.body),
          // A thrown error must not surface a stack, a path or a reference.
          () => res.status(500).json({ error: 'Your voice could not be saved.' }),
        );
      });
    },
  );
}

async function handleEnrollment(
  deps: VoiceEnrollmentRouteDependencies,
  req: express.Request,
  audio: Buffer,
): Promise<EnrollmentOutcome> {
  // Ownership comes from a verified session token and nowhere else. It used
  // to come from a header the client simply asserted, which with real
  // accounts would let anybody enrol into somebody else's voice.
  const ownerId = deps.authenticate(req);
  if (!ownerId) {
    return { status: 401, body: { error: 'Sign in to record your voice.' } };
  }
  if (audio.byteLength === 0) {
    return { status: 400, body: { error: 'Nothing was recorded.' } };
  }

  // The bytes are the authority, not the header. A caller announcing one
  // format while sending another is refused rather than stored under the name
  // it asked for.
  const container = detectAudioContainer(new Uint8Array(audio));
  const declared = req.header('content-type') ?? '';
  if (!declaredTypeMatches(declared, container)) {
    return { status: 415, body: { error: 'That recording format is not supported.' } };
  }

  const enrolledLanguage = req.header('x-videofy-enrolled-language') ?? 'en';
  const voiceProfileId = req.params.voiceProfileId || deps.newVoiceProfileId();

  // A profile that already exists must belong to the browser presenting it.
  // Without this, knowing someone's profile id was enough to overwrite their
  // enrollment with your own recording — and their calls would then have gone
  // out in your voice. Absent profiles fall through: this route also creates
  // one, and the store refuses anything that has not been consented to.
  const existing = deps.store.get(voiceProfileId);
  if (existing && existing.profile.ownerId !== ownerId) {
    return { status: 404, body: { error: 'No voice was found for this browser.' } };
  }

  // The store is the consent authority. If the profile does not exist, or
  // call-use consent has not been granted, it refuses and NOTHING is written.
  const attached = await deps.store.attachEnrollmentRecording(
    voiceProfileId,
    new Uint8Array(audio),
    enrolledLanguage,
  );
  if (!attached) {
    return {
      status: 409,
      body: { error: 'Permission to use your voice has not been given yet.' },
    };
  }

  const stored = deps.store.get(voiceProfileId);
  const enrollmentRecordingRef = stored?.enrollmentRecordingRef;
  if (!enrollmentRecordingRef) {
    return { status: 500, body: { error: 'Your voice could not be saved.' } };
  }

  const created = await deps.provider.createAsset({
    voiceProfileId,
    enrollmentRecordingRef,
    enrolledLanguage,
  });

  if (!created.ok) {
    // The recording is kept — a validated engine can derive from it later
    // without asking anyone to record again — and the profile stays out of
    // `ready`, so the call resolver keeps using the standard voice. Reporting
    // success here is what would put a "personal voice" label on a voice that
    // does not exist.
    return {
      status: 202,
      body: {
        state: attached.state,
        personalVoiceReady: false,
        message: 'Your recording was saved. Personal voice is not available yet.',
      },
    };
  }

  const ready = deps.store.accept(voiceProfileId, created.voiceAssetRef);
  if (ready) {
    // Recording again REPLACES a voice. Superseded enrolments are removed here
    // rather than left behind, because an owner holding several voices is both
    // a wrong answer to "which is theirs" and a pile of recordings nobody asked
    // to keep. Only once the new one is genuinely usable, so a failed
    // enrollment never costs someone the voice they already had.
    await deps.store.supersede(ownerId, voiceProfileId);
  }
  return {
    status: 201,
    body: { state: ready?.state ?? attached.state, personalVoiceReady: ready !== null },
  };
}
