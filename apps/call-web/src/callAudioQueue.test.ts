import { describe, expect, it } from 'vitest';
import {
  CallGeneratedAudioQueueController,
  type CallGeneratedAudioQueueState,
} from './callAudioQueue';
import {
  GeneratedAudioPlaybackError,
  type CallGeneratedAudioPlayer,
} from './callGeneratedAudioPlayer';
import type { GeneratedAudioFailureReason } from './callGeneratedAudioDiagnostics';
import type { CallGeneratedAudioEvent } from './callTypes';

/**
 * One persistent player, exactly as the browser gives us: autoplay permission
 * belongs to the ELEMENT, so `unlock` is what a user gesture buys and `play`
 * rejects until it has been bought.
 */
class FakePlayer implements CallGeneratedAudioPlayer {
  /** When set, play() rejects with this classified reason. */
  failWith: GeneratedAudioFailureReason | null = null;
  /** Resolves the in-flight unlock, for testing the shared-element race. */
  releaseUnlock: (() => void) | null = null;
  volume = 1;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  /** Every URL this player was asked to start, in order. */
  readonly played: string[] = [];
  paused = false;
  unlockCount = 0;
  disposed = false;
  /** Set true to model Android Chrome before a gesture. */
  requiresGesture = false;
  unlockSucceeds = true;
  private unlocked = false;

  async play(url: string): Promise<void> {
    if (this.failWith) {
      throw new GeneratedAudioPlaybackError(this.failWith, new Error('play failed'));
    }
    if (this.requiresGesture && !this.unlocked) {
      throw new GeneratedAudioPlaybackError(
        'autoplay-policy-blocked',
        Object.assign(new Error('blocked'), { name: 'NotAllowedError' }),
      );
    }
    this.played.push(url);
    this.paused = false;
  }

  pause(): void {
    this.paused = true;
  }

  async unlock(): Promise<boolean> {
    this.unlockCount += 1;
    if (this.releaseUnlock === null && this.holdUnlock) {
      await new Promise<void>((resolve) => {
        this.releaseUnlock = resolve;
      });
    }
    if (!this.unlockSucceeds) return false;
    this.unlocked = true;
    return true;
  }

  holdUnlock = false;

  dispose(): void {
    this.disposed = true;
  }
}

function generatedEvent(overrides: Partial<CallGeneratedAudioEvent> = {}): CallGeneratedAudioEvent {
  return {
    callId: 'calm-river-42',
    speakerParticipantId: 'participant-a',
    targetLanguage: 'en',
    voiceId: 'standard-female',
    audioUrl: `audio-${overrides.sequence ?? 1}`,
    sequence: 1,
    startMs: 0,
    durationMs: 900,
    mediaRevision: 1,
    languageRevision: 1,
    ...overrides,
  };
}

interface SpeechEvent {
  active: boolean;
  clipUrl: string | null;
}

function createController(configure: (player: FakePlayer) => void = () => {}) {
  const player = new FakePlayer();
  configure(player);
  const speechEvents: SpeechEvent[] = [];
  const states: CallGeneratedAudioQueueState[] = [];
  const controller = new CallGeneratedAudioQueueController({
    player,
    onSpeechActiveChange: (active, clip) =>
      speechEvents.push({ active, clipUrl: clip?.audioUrl ?? null }),
    onStateChange: (state) => states.push({ ...state }),
  });
  return { controller, player, speechEvents, states };
}

/** Let the play() promise settle. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('CallGeneratedAudioQueueController', () => {
  it('plays backlogged segments in sequence order once started', async () => {
    const { controller, player } = createController();

    expect(controller.enqueue(generatedEvent({ sequence: 3 }))).toBe(true);
    expect(controller.enqueue(generatedEvent({ sequence: 1 }))).toBe(true);
    expect(controller.enqueue(generatedEvent({ sequence: 2 }))).toBe(true);

    await controller.start();
    await settle();
    expect(player.played).toEqual(['audio-1']);

    player.onended?.();
    await settle();
    player.onended?.();
    await settle();

    expect(player.played).toEqual(['audio-1', 'audio-2', 'audio-3']);
    expect(controller.getState().playedCount).toBe(2);
  });

  it('rejects duplicate deliveries of the same segment', () => {
    const { controller } = createController();

    expect(controller.enqueue(generatedEvent({ sequence: 1 }))).toBe(true);
    expect(controller.enqueue(generatedEvent({ sequence: 1 }))).toBe(false);
    expect(controller.getState().pendingCount).toBe(1);
  });

  it('drops segments from an older revision', () => {
    const { controller } = createController();

    expect(controller.enqueue(generatedEvent({ sequence: 5, mediaRevision: 2 }))).toBe(true);
    expect(controller.enqueue(generatedEvent({ sequence: 1, mediaRevision: 1 }))).toBe(false);

    expect(controller.getState().pendingCount).toBe(1);
    expect(controller.getState().droppedCount).toBe(1);
  });

  it('flushes queued older-revision segments when a newer revision arrives', async () => {
    const { controller, player } = createController();

    controller.enqueue(generatedEvent({ sequence: 5, languageRevision: 1 }));
    controller.enqueue(generatedEvent({ sequence: 6, languageRevision: 1 }));
    controller.enqueue(generatedEvent({ sequence: 1, languageRevision: 2, audioUrl: 'audio-rev2' }));

    expect(controller.getState().pendingCount).toBe(1);
    expect(controller.getState().droppedCount).toBe(2);

    await controller.start();
    await settle();
    expect(player.played).toEqual(['audio-rev2']);
  });

  it('tracks revisions per speaker independently', () => {
    const { controller } = createController();

    controller.enqueue(generatedEvent({ sequence: 5, mediaRevision: 2 }));
    const accepted = controller.enqueue(
      generatedEvent({
        sequence: 1,
        mediaRevision: 1,
        speakerParticipantId: 'participant-b',
        audioUrl: 'audio-b',
      }),
    );

    expect(accepted).toBe(true);
    expect(controller.getState().pendingCount).toBe(2);
  });

  it('applies the volume to current and future playback', async () => {
    const { controller, player } = createController();

    controller.setVolume(0.5);
    controller.enqueue(generatedEvent({ sequence: 1 }));
    await controller.start();
    await settle();

    expect(player.volume).toBe(0.5);

    controller.setVolume(0.3);
    expect(player.volume).toBe(0.3);

    player.onended?.();
    await settle();
    controller.enqueue(generatedEvent({ sequence: 2 }));
    await settle();
    expect(player.volume).toBe(0.3);
  });

  it('does not count a stopped segment as played when the line is reused', async () => {
    // With ONE persistent element the queue can no longer identify a stale
    // `ended` by object identity, because there is only ever one object. That
    // guard moved into the player, which suppresses events for a clip it is no
    // longer holding (see callGeneratedAudioPlayer.test.ts). What the QUEUE
    // must still guarantee is this: a segment cut short is dropped, never
    // counted as played, and the line is free for the next one.
    const { controller, player } = createController();

    controller.enqueue(generatedEvent({ sequence: 1 }));
    await controller.start();
    await settle();
    controller.setEnabled(false);
    controller.setEnabled(true);

    expect(controller.getState()).toMatchObject({ playedCount: 0, droppedCount: 1 });

    controller.enqueue(generatedEvent({ sequence: 2 }));
    await settle();
    player.onended?.();
    await settle();

    expect(controller.getState().playedCount).toBe(1);
    expect(player.played).toEqual(['audio-1', 'audio-2']);
  });
});

/**
 * W4 truthfulness.
 *
 * The generated-playback ledger exists to say when a clip was AUDIBLE. Before
 * this correction the queue announced a clip active before `play()` had
 * resolved, so on Android — where the promise rejects — the gateway recorded an
 * audible interval for a clip nobody heard. A ledger that reports playback for
 * refused audio is worse than no ledger, because the M1 analysis would treat it
 * as measurement.
 */
describe('W4 intervals describe audible playback, not attempted playback', () => {
  it('1. reports NO interval for a clip the browser refused', async () => {
    const { controller, player, speechEvents } = createController((fake) => {
      fake.requiresGesture = true;
      fake.unlockSucceeds = false;
    });

    controller.enqueue(generatedEvent({ sequence: 1 }));
    await controller.start();
    await settle();

    expect(speechEvents).toEqual([]);
    expect(player.played).toEqual([]);
    // Surfaced, never silent: the listener gets the recovery affordance.
    expect(controller.getState().status).toBe('blocked');
    // Still queued — it was never heard, so it is not lost.
    expect(controller.getState().pendingCount).toBe(1);
  });

  it('2. reports exactly one START and one END for a clip that played', async () => {
    const { controller, player, speechEvents } = createController();

    controller.enqueue(generatedEvent({ sequence: 1 }));
    await controller.start();
    await settle();
    expect(speechEvents).toEqual([{ active: true, clipUrl: 'audio-1' }]);

    player.onended?.();
    await settle();

    expect(speechEvents).toEqual([
      { active: true, clipUrl: 'audio-1' },
      { active: false, clipUrl: 'audio-1' },
    ]);
  });

  it('4. a natural end closes the interval and counts the clip as played', async () => {
    const { controller, player } = createController();
    controller.enqueue(generatedEvent({ sequence: 1 }));
    await controller.start();
    await settle();

    player.onended?.();
    await settle();

    expect(controller.getState()).toMatchObject({ status: 'idle', playedCount: 1, error: null });
  });

  it('5. an error AFTER playback began closes the interval and does not replay the clip', async () => {
    // The clip was partly heard. Replaying it would put half a sentence into
    // the call twice, which is a worse outcome than losing its tail.
    const { controller, player, speechEvents } = createController();
    controller.enqueue(generatedEvent({ sequence: 1 }));
    await controller.start();
    await settle();

    player.onerror?.();
    await settle();

    expect(speechEvents.map((event) => event.active)).toEqual([true, false]);
    expect(controller.getState()).toMatchObject({ status: 'error', pendingCount: 0 });
    expect(player.played).toEqual(['audio-1']);
  });

  it('6. a mode switch during playback closes the interval exactly once', async () => {
    const { controller, player, speechEvents } = createController();
    controller.enqueue(generatedEvent({ sequence: 1 }));
    controller.enqueue(generatedEvent({ sequence: 2 }));
    await controller.start();
    await settle();

    controller.setEnabled(false);
    await settle();

    expect(speechEvents).toEqual([
      { active: true, clipUrl: 'audio-1' },
      { active: false, clipUrl: 'audio-1' },
    ]);
    expect(player.paused).toBe(true);
    expect(controller.getState()).toMatchObject({ pendingCount: 0, droppedCount: 2 });
    expect(controller.enqueue(generatedEvent({ sequence: 3 }))).toBe(false);
  });

  it('7. reset during playback closes the interval, so it cannot read as audible forever', async () => {
    const { controller, player, speechEvents } = createController();
    controller.enqueue(generatedEvent({ sequence: 1, mediaRevision: 3 }));
    await controller.start();
    await settle();

    controller.reset();
    await settle();

    expect(speechEvents.at(-1)).toEqual({ active: false, clipUrl: 'audio-1' });
    expect(player.paused).toBe(true);
    expect(controller.getState().pendingCount).toBe(0);
    expect(controller.enqueue(generatedEvent({ sequence: 1, mediaRevision: 1 }))).toBe(true);
  });

  it('does not lock the queue when a clip merely failed to load', async () => {
    // THE Android stall. Every clip failed with MediaError 4 because the URL
    // pointed at the phone's own loopback; treating that as an autoplay block
    // retained the unplayable clip and froze everything behind it, while the UI
    // asked for a tap that could not have helped.
    const { controller, player, speechEvents } = createController((fake) => {
      fake.failWith = 'media-load-error';
    });

    controller.enqueue(generatedEvent({ sequence: 1 }));
    controller.enqueue(generatedEvent({ sequence: 2 }));
    await controller.start();
    await settle();

    // Both were attempted and both dropped — the queue kept moving.
    expect(controller.getState()).toMatchObject({
      status: 'source-error',
      pendingCount: 0,
      droppedCount: 2,
    });
    // And no fake audible interval for either.
    expect(speechEvents).toEqual([]);
    expect(player.played).toEqual([]);
  });

  it('recovers on its own once the source works again', async () => {
    const { controller, player } = createController((fake) => {
      fake.failWith = 'network-source-failure';
    });

    controller.enqueue(generatedEvent({ sequence: 1 }));
    await controller.start();
    await settle();
    expect(controller.getState().status).toBe('source-error');

    // No gesture, no unlock: the next clip simply plays.
    player.failWith = null;
    controller.enqueue(generatedEvent({ sequence: 2 }));
    await settle();

    expect(player.played).toEqual(['audio-2']);
    expect(controller.getState().status).toBe('playing');
  });

  it('still locks and RETAINS the clip for a genuine autoplay refusal', async () => {
    const { controller, player } = createController((fake) => {
      fake.failWith = 'autoplay-policy-blocked';
    });

    controller.enqueue(generatedEvent({ sequence: 1 }));
    await controller.start();
    await settle();

    expect(controller.getState()).toMatchObject({ status: 'blocked', pendingCount: 1 });

    player.failWith = null;
    await controller.unlock();
    await settle();

    // Played once, not lost and not replayed.
    expect(player.played).toEqual(['audio-1']);
  });

  it('closes no interval for a clip stopped before it ever became audible', async () => {
    // Torn down while play() was still pending. A START never happened, so an
    // END must not either — a lone END would leave the ledger with an unmatched
    // close and an interval of negative length.
    // A holder rather than a bare `let`: TypeScript cannot see the callback run
    // and would narrow the variable to `null` at the call below.
    const release: { run: (() => void) | null } = { run: null };
    const { controller, player, speechEvents } = createController();
    player.play = (url: string) =>
      new Promise<void>((resolve) => {
        release.run = () => {
          player.played.push(url);
          resolve();
        };
      });

    controller.enqueue(generatedEvent({ sequence: 1 }));
    await controller.start();
    controller.reset();
    release.run?.();
    await settle();

    expect(speechEvents).toEqual([]);
  });
});

/**
 * The Android defect itself: permission belongs to the ELEMENT, so a per-clip
 * element arrives locked every time and "Enable audio" fixes exactly one clip.
 */
describe('mobile autoplay unlock', () => {
  it('3. one gesture unlocks every subsequent clip', async () => {
    const { controller, player } = createController((fake) => {
      fake.requiresGesture = true;
    });

    // Before the gesture: refused, retained, blocked.
    controller.enqueue(generatedEvent({ sequence: 1 }));
    await settle();
    expect(player.played).toEqual([]);

    await controller.start();
    await settle();
    expect(player.played).toEqual(['audio-1']);

    // Every later clip plays with NO further gesture. This is the assertion the
    // old implementation could not pass: it built a new locked element per clip.
    for (const sequence of [2, 3, 4]) {
      player.onended?.();
      await settle();
      controller.enqueue(generatedEvent({ sequence }));
      await settle();
    }

    expect(player.played).toEqual(['audio-1', 'audio-2', 'audio-3', 'audio-4']);
    expect(player.unlockCount).toBe(1);
    expect(controller.getState().status).toBe('playing');
  });

  it('resumes the refused clip on unlock instead of losing or replaying it', async () => {
    const { controller, player, speechEvents } = createController((fake) => {
      fake.requiresGesture = true;
      fake.unlockSucceeds = false;
    });

    controller.enqueue(generatedEvent({ sequence: 1 }));
    await controller.start();
    await settle();
    expect(controller.getState().status).toBe('blocked');

    // The gesture now succeeds, as it would when the user actually taps.
    player.unlockSucceeds = true;
    await controller.unlock();
    await settle();

    // Played once, not twice: it was retained, never replayed.
    expect(player.played).toEqual(['audio-1']);
    expect(speechEvents).toEqual([{ active: true, clipUrl: 'audio-1' }]);
  });

  it('stays blocked while more clips arrive, rather than retrying into the same wall', async () => {
    const { controller, player } = createController((fake) => {
      fake.requiresGesture = true;
      fake.unlockSucceeds = false;
    });

    controller.enqueue(generatedEvent({ sequence: 1 }));
    await controller.start();
    await settle();
    controller.enqueue(generatedEvent({ sequence: 2 }));
    controller.enqueue(generatedEvent({ sequence: 3 }));
    await settle();

    expect(player.played).toEqual([]);
    expect(controller.getState()).toMatchObject({ status: 'blocked', pendingCount: 3 });
    // One refusal, not one per clip: the browser has not changed its mind.
    expect(player.unlockCount).toBe(1);
  });

  it('8. duplicate and stale-revision handling is unchanged while blocked', async () => {
    const { controller } = createController((fake) => {
      fake.requiresGesture = true;
      fake.unlockSucceeds = false;
    });

    controller.enqueue(generatedEvent({ sequence: 1 }));
    await controller.start();
    await settle();

    expect(controller.enqueue(generatedEvent({ sequence: 1 }))).toBe(false);
    expect(controller.enqueue(generatedEvent({ sequence: 0, mediaRevision: 0 }))).toBe(false);
    expect(controller.getState().pendingCount).toBe(1);
  });

  it('does not start a clip while an unlock is still in flight', async () => {
    // The AbortError seen on the device. The queue and the unlock share ONE
    // element, so a clip arriving mid-unlock set `element.src` and interrupted
    // the unlock's pending play() — the first unlock always failed and a later
    // one had to rescue it.
    const { controller, player } = createController((fake) => {
      fake.holdUnlock = true;
    });

    const started = controller.start();
    controller.enqueue(generatedEvent({ sequence: 1 }));
    await settle();

    // Nothing touched the element while the unlock was pending.
    expect(player.played).toEqual([]);

    player.releaseUnlock?.();
    await started;
    await settle();

    expect(player.played).toEqual(['audio-1']);
    expect(player.unlockCount).toBe(1);
  });

  it('coalesces overlapping unlock requests instead of racing itself', async () => {
    // Two taps in quick succession must not put two unlocks on one element.
    const { controller, player } = createController((fake) => {
      fake.holdUnlock = true;
    });

    const first = controller.start();
    void controller.unlock();
    player.releaseUnlock?.();
    await first;
    await settle();

    expect(player.unlockCount).toBe(1);
  });

  it('disposes the player it was given', async () => {
    const { controller, player } = createController();
    await controller.start();
    controller.dispose();

    expect(player.disposed).toBe(true);
  });
});
