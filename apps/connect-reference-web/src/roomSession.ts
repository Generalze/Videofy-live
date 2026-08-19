// owner: masterzee001
/**
 * RoomSession: the one object between the screens and a live conference.
 *
 * It owns the SDK call object, keeps a render-ready view of it, and carries
 * the whole recovery story: when the SDK signals that the credential in hand
 * is finished, the session fetches a FRESH join token from the KC server and
 * joins again — bounded attempts, visible status, product language — exactly
 * the loop rejoinPlan.ts pins down. Dependencies are injected so the loop is
 * a unit-testable fact.
 *
 * Recovery must also carry what a call object cannot: video attachments, the
 * words spoken so far, and every mid-call choice live in THIS object, because
 * a disposed call takes its own copies to the grave. And a leave is final —
 * a join that resolves after leave() surrenders its seat on the spot instead
 * of resurrecting the session with a live microphone.
 */
import type { AudioMode, CallSnapshot, VideofyCall, VideofyClient } from '@videofy/connect';
import { rejoinDelayMs, REJOIN_MAX_ATTEMPTS, shouldKeepTrying } from './rejoinPlan';

export type SessionPhase = 'joining' | 'live' | 'rejoining' | 'rejoin-failed' | 'ended';

export interface SessionView {
  phase: SessionPhase;
  snapshot: CallSnapshot | null;
  audioBlocked: boolean;
  micOn: boolean;
  cameraOn: boolean;
  rejoinAttempt: number;
  /** Product-worded transient notice (SDK errors are public-safe). */
  notice: string | null;
}

/** What a freshly minted token must reflect about the member RIGHT NOW. */
export interface CurrentPreferences {
  /** The hearing language chosen mid-call; null while the lobby choice stands. */
  hearLanguage: string | null;
}

export interface RoomSessionDeps {
  client: VideofyClient;
  /**
   * Mints a FRESH single-use join token from the KC server. The preferences
   * carry what the member changed mid-call, so a recovery token never quietly
   * reverts them to the lobby's original choices.
   */
  mintToken(current: CurrentPreferences): Promise<string>;
  /**
   * True for mint failures that mean the room itself is over — retrying
   * cannot help, and the truthful screen is the closed room, not the rejoin
   * banner. Absent means every failure is treated as transient.
   */
  isTerminalRejoinFailure?(failure: unknown): boolean;
  delay?(ms: number): Promise<void>;
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(failure: unknown): string {
  if (failure instanceof Error && failure.message.length > 0) return failure.message;
  return 'Something went wrong in the room.';
}

/** Surrender a seat whose join resolved after the member already left. */
function discard(call: VideofyCall): void {
  try {
    call.leave();
  } catch {
    /* the seat was already gone */
  }
  call.dispose();
}

/**
 * Splice a carried transcript onto a live one. The SDK heads each call's
 * transcript with a single header line followed by a blank line; when both
 * halves exist, the later header is stripped so exactly one header survives
 * the splice — the carried half already wears it.
 */
function joinTranscripts(earlier: string, later: string): string {
  if (earlier.length === 0) return later;
  if (later.length === 0) return earlier;
  const lines = later.split('\n');
  if (lines[0] !== undefined && lines[0].startsWith('Videofy transcript')) {
    lines.shift();
    if (lines[0] === '') lines.shift();
  }
  if (lines.length === 0) return earlier;
  return earlier + '\n' + lines.join('\n');
}

export class RoomSession {
  private readonly deps: RoomSessionDeps;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly listeners = new Set<(view: SessionView) => void>();

  private call: VideofyCall | null = null;
  private closed = false;
  private rejoining = false;

  /** Every element the screens attached, replayed onto each adopted call. */
  private readonly attachments = new Map<string, { srcObject: unknown }>();
  /** Words from calls recovery already disposed; getTranscript prepends them. */
  private carriedTranscript = '';
  /** Mid-call choices, remembered so a rejoin changes nothing the member set. */
  private audioModeChoice: AudioMode | null = null;
  private hearLanguageChoice: string | null = null;
  private captionsChoice: boolean | null = null;

  private view: SessionView = {
    phase: 'joining',
    snapshot: null,
    audioBlocked: false,
    micOn: true,
    cameraOn: false,
    rejoinAttempt: 0,
    notice: null,
  };

  constructor(deps: RoomSessionDeps) {
    this.deps = deps;
    this.delay = deps.delay ?? defaultDelay;
  }

  getView(): SessionView {
    return this.view;
  }

  subscribe(listener: (view: SessionView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private update(patch: Partial<SessionView>): void {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener(this.view);
  }

  /** First join, from the lobby. Resolves quietly if leave() won the race. */
  async start(media: { microphone: boolean; camera: boolean }): Promise<void> {
    this.update({ phase: 'joining', micOn: media.microphone, cameraOn: media.camera });
    const token = await this.deps.mintToken(this.currentPreferences());
    if (this.closed) return;
    const call = await this.deps.client.join({ token, media });
    if (this.closed) {
      // leave() ran while this join was in flight. Adopting now would seat
      // the member again with a live microphone; surrender the seat instead.
      discard(call);
      return;
    }
    this.adopt(call);
    this.update({ phase: 'live', snapshot: call.getSnapshot(), notice: null });
  }

  private currentPreferences(): CurrentPreferences {
    return { hearLanguage: this.hearLanguageChoice };
  }

  private adopt(call: VideofyCall): void {
    this.call = call;
    call.on('state', (snapshot) => {
      this.update({ snapshot });
    });
    call.on('audioBlocked', () => {
      this.update({ audioBlocked: true });
    });
    call.on('error', (failure) => {
      this.update({ notice: failure.message });
    });
    call.on('connectionChanged', (change) => {
      if (change.connection === 'ended' && !this.rejoining && !this.closed) {
        this.update({ phase: 'ended' });
      }
    });
    call.on('needsNewJoinToken', () => {
      void this.runRejoin();
    });

    // A fresh call knows nothing the member arranged on the old one: replay
    // every video attachment and every mid-call choice, or a rejoin lands on
    // black tiles wearing the lobby's original settings. The hear language
    // is ack-gated on the wire and the minted token already carried it, so a
    // refusal here is not worth a notice.
    for (const [participantId, element] of this.attachments) {
      call.attachVideo(participantId, element);
    }
    if (this.audioModeChoice !== null) call.setAudioMode(this.audioModeChoice);
    if (this.captionsChoice !== null) call.setCaptions(this.captionsChoice);
    if (this.hearLanguageChoice !== null) {
      void call.setHearLanguage(this.hearLanguageChoice).catch(() => {
        /* the token already carried this choice */
      });
    }
  }

  /**
   * The recovery loop. The old credential is terminal, so every attempt
   * mints a fresh token before joining; delays and the attempt bound come
   * from rejoinPlan. leave() may land between any two awaits, so closed is
   * re-checked after every one — and a join that resolves for a session
   * already left surrenders the seat instead of adopting it.
   */
  private async runRejoin(): Promise<void> {
    if (this.rejoining || this.closed) return;
    this.rejoining = true;
    const finished = this.call;
    this.call = null;
    if (finished !== null) {
      // The words spoken so far live inside the call object about to be
      // disposed; carry them, or the transcript restarts empty. A room
      // policy may refuse transcript reads — carrying nothing is right then.
      let words = '';
      try {
        words = finished.getTranscript();
      } catch {
        words = '';
      }
      this.carriedTranscript = joinTranscripts(this.carriedTranscript, words);
      finished.dispose();
    }

    for (let attempt = 1; shouldKeepTrying(attempt); attempt += 1) {
      if (this.closed) {
        this.rejoining = false;
        return;
      }
      this.update({ phase: 'rejoining', rejoinAttempt: attempt });
      await this.delay(rejoinDelayMs(attempt));
      if (this.closed) {
        this.rejoining = false;
        return;
      }
      try {
        const token = await this.deps.mintToken(this.currentPreferences());
        if (this.closed) {
          this.rejoining = false;
          return;
        }
        const call = await this.deps.client.join({
          token,
          media: { microphone: this.view.micOn, camera: this.view.cameraOn },
        });
        if (this.closed) {
          // leave() won the race with this attempt's join; adopting would
          // resurrect the session with a hot microphone and a ghost seat.
          discard(call);
          this.rejoining = false;
          return;
        }
        this.adopt(call);
        this.rejoining = false;
        this.update({
          phase: 'live',
          snapshot: call.getSnapshot(),
          rejoinAttempt: 0,
          notice: null,
        });
        return;
      } catch (failure) {
        if (this.deps.isTerminalRejoinFailure?.(failure) === true) {
          // The room itself is over. Every further attempt would fail the
          // same way, and "return to the lobby and join again" would be a
          // lie — show the closed-room screen instead.
          this.rejoining = false;
          this.update({ phase: 'ended', notice: null });
          return;
        }
        this.update({ notice: messageOf(failure) });
      }
    }
    this.rejoining = false;
    this.update({ phase: 'rejoin-failed', rejoinAttempt: REJOIN_MAX_ATTEMPTS });
  }

  async enableAudio(): Promise<void> {
    if (this.call === null) return;
    await this.call.enableAudio();
    this.update({ audioBlocked: false });
  }

  async setMicrophone(enabled: boolean): Promise<void> {
    if (this.call === null) return;
    await this.call.setMicrophone(enabled);
    this.update({ micOn: enabled });
  }

  async setCamera(enabled: boolean): Promise<void> {
    if (this.call === null) return;
    await this.call.setCamera(enabled);
    this.update({ cameraOn: enabled });
  }

  setAudioMode(mode: AudioMode): void {
    this.audioModeChoice = mode;
    this.call?.setAudioMode(mode);
  }

  async setHearLanguage(language: string): Promise<void> {
    this.hearLanguageChoice = language;
    if (this.call === null) return;
    await this.call.setHearLanguage(language);
  }

  setCaptions(enabled: boolean): void {
    this.captionsChoice = enabled;
    this.call?.setCaptions(enabled);
  }

  attachVideo(participantId: string, element: { srcObject: unknown }): void {
    this.attachments.set(participantId, element);
    this.call?.attachVideo(participantId, element);
  }

  detachVideo(participantId: string): void {
    this.attachments.delete(participantId);
    this.call?.detachVideo(participantId);
  }

  getTranscript(): string {
    return joinTranscripts(this.carriedTranscript, this.call?.getTranscript() ?? '');
  }

  /** Hang up: surrender the seat and release everything. */
  leave(): void {
    this.closed = true;
    const finished = this.call;
    this.call = null;
    if (finished !== null) {
      try {
        finished.leave();
      } catch {
        /* the seat was already gone */
      }
      finished.dispose();
    }
    this.update({ phase: 'ended' });
  }
}
