// owner: masterzee001
/**
 * The session engine, against fakes: joining, the bounded token-refresh
 * rejoin loop with its planned delays, per-speaker passthroughs, and a
 * clean leave. Every dependency is injected; no network, no timers.
 */
import { describe, expect, it, vi } from 'vitest';
import type { VideofyCall, VideofyClient } from '@videofy/connect';
import { REJOIN_MAX_ATTEMPTS } from '../rejoinPlan';
import { RoomSession, type SessionView } from '../roomSession';
import { snapshot } from './fixtures';

type Emitting = VideofyCall & { emit(event: string, payload?: unknown): void };

function fakeCall(transcript = 'Ana: hola'): Emitting {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const call = {
    on(event: string, listener: (payload: unknown) => void) {
      const bucket = listeners.get(event) ?? new Set();
      bucket.add(listener);
      listeners.set(event, bucket);
    },
    off(event: string, listener: (payload: unknown) => void) {
      listeners.get(event)?.delete(listener);
    },
    emit(event: string, payload?: unknown) {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
    getSnapshot: () => snapshot(),
    enableAudio: vi.fn(async () => {}),
    setMicrophone: vi.fn(async () => {}),
    setCamera: vi.fn(async () => {}),
    setAudioMode: vi.fn(),
    setHearLanguage: vi.fn(async () => {}),
    setCaptions: vi.fn(),
    setAudioOutput: vi.fn(async () => {}),
    getAudioOutputCapabilities: vi.fn(async () => ({ audioOutput: 'selectable', outputs: [] })),
    setCallMode: vi.fn(async () => {}),
    getTranscript: vi.fn(() => transcript),
    attachVideo: vi.fn(),
    detachVideo: vi.fn(),
    leave: vi.fn(),
    dispose: vi.fn(),
  };
  return call as unknown as Emitting;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition never became true');
}

interface Harness {
  session: RoomSession;
  views: SessionView[];
  delays: number[];
  calls: Emitting[];
  mint: ReturnType<typeof vi.fn>;
  join: ReturnType<typeof vi.fn>;
  /** Lets a gated join proceed — the race window the blocker fix closes. */
  releaseJoin(): void;
}

interface HarnessOptions {
  terminal?(failure: unknown): boolean;
  /** 1-based index of the join call to park until releaseJoin(). */
  gateJoinAt?: number;
  /** Transcript each successive fake call reports. */
  transcripts?: string[];
}

function harness(mintResults: Array<'ok' | 'fail'>, options: HarnessOptions = {}): Harness {
  const calls: Emitting[] = [];
  const delays: number[] = [];
  const views: SessionView[] = [];
  let mintIndex = 0;
  let release: (() => void) | null = null;
  const mint = vi.fn(async () => {
    const outcome = mintResults[mintIndex] ?? 'ok';
    mintIndex += 1;
    if (outcome === 'fail') throw new Error('The room service is not reachable right now.');
    return 'tok_' + mintIndex;
  });
  const join = vi.fn(async () => {
    if (options.gateJoinAt !== undefined && join.mock.calls.length === options.gateJoinAt) {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    const call = fakeCall(options.transcripts?.[calls.length]);
    calls.push(call);
    return call;
  });
  const client = { join } as unknown as VideofyClient;
  const session = new RoomSession({
    client,
    mintToken: mint,
    delay: async (ms) => {
      delays.push(ms);
    },
    ...(options.terminal ? { isTerminalRejoinFailure: options.terminal } : {}),
  });
  session.subscribe((view) => views.push(view));
  return { session, views, delays, calls, mint, join, releaseJoin: () => release?.() };
}

describe('RoomSession recovery hardening (adversarial review)', () => {
  it('BLOCKER pin: a rejoin join resolving after leave() surrenders the seat', async () => {
    const h = harness(['ok', 'ok'], { gateJoinAt: 2 });
    await h.session.start({ microphone: true, camera: false });
    h.calls[0]?.emit('needsNewJoinToken');
    await until(() => h.mint.mock.calls.length === 2);
    // The recovery join is parked in flight; the member hangs up NOW.
    h.session.leave();
    h.releaseJoin();
    await until(() => h.calls.length === 2 && vi.mocked(h.calls[1]!.leave).mock.calls.length > 0);
    expect(h.calls[1]!.dispose).toHaveBeenCalled();
    // No resurrection: the session stays ended, never live again.
    expect(h.session.getView().phase).toBe('ended');
    expect(h.views.filter((v) => v.phase === 'live').length).toBe(1);
  });

  it('BLOCKER pin: leave() during the FIRST join surrenders the seat too', async () => {
    const h = harness(['ok'], { gateJoinAt: 1 });
    const starting = h.session.start({ microphone: true, camera: true });
    await until(() => h.mint.mock.calls.length === 1);
    h.session.leave();
    h.releaseJoin();
    await starting;
    expect(h.calls[0]!.leave).toHaveBeenCalled();
    expect(h.calls[0]!.dispose).toHaveBeenCalled();
    expect(h.session.getView().phase).toBe('ended');
  });

  it('replays video attachments onto the recovered call', async () => {
    const h = harness(['ok', 'ok']);
    await h.session.start({ microphone: true, camera: false });
    const element = { srcObject: null };
    h.session.attachVideo('participant_2', element);
    h.calls[0]?.emit('needsNewJoinToken');
    await until(() => h.session.getView().phase === 'live' && h.calls.length === 2);
    expect(h.calls[1]!.attachVideo).toHaveBeenCalledWith('participant_2', element);
  });

  it('carries the transcript across a rejoin with exactly one header', async () => {
    const h = harness(['ok', 'ok'], {
      transcripts: [
        'Videofy transcript \u2014 first\n\n[0:01] Ada: One.',
        'Videofy transcript \u2014 second\n\n[0:02] Ada: Two.',
      ],
    });
    await h.session.start({ microphone: true, camera: false });
    h.calls[0]?.emit('needsNewJoinToken');
    await until(() => h.session.getView().phase === 'live' && h.calls.length === 2);
    const transcript = h.session.getTranscript();
    expect(transcript).toContain('[0:01] Ada: One.');
    expect(transcript).toContain('[0:02] Ada: Two.');
    expect(transcript.split('Videofy transcript').length - 1).toBe(1);
  });

  it('stops immediately on a terminal mint failure and shows the closed room', async () => {
    const h = harness(['ok', 'fail'], {
      terminal: (failure) => failure instanceof Error && failure.message.includes('not reachable'),
    });
    await h.session.start({ microphone: true, camera: false });
    h.calls[0]?.emit('needsNewJoinToken');
    await until(() => h.session.getView().phase === 'ended');
    // One recovery mint only — no hammering a room that is over.
    expect(h.mint).toHaveBeenCalledTimes(2);
    expect(h.delays).toEqual([0]);
    expect(h.session.getView().notice).toBeNull();
  });

  it('replays every mid-call choice and mints with the CURRENT hearing language', async () => {
    const h = harness(['ok', 'ok']);
    await h.session.start({ microphone: true, camera: false });
    h.session.setAudioMode('interpretation');
    void h.session.setHearLanguage('fr');
    h.session.setCaptions(false);
    h.calls[0]?.emit('needsNewJoinToken');
    await until(() => h.session.getView().phase === 'live' && h.calls.length === 2);
    expect(h.mint).toHaveBeenLastCalledWith({ hearLanguage: 'fr' });
    expect(h.calls[1]!.setAudioMode).toHaveBeenCalledWith('interpretation');
    expect(h.calls[1]!.setHearLanguage).toHaveBeenCalledWith('fr');
    expect(h.calls[1]!.setCaptions).toHaveBeenCalledWith(false);
  });
});

describe('RoomSession', () => {
  it('joins and goes live with the media it was asked for', async () => {
    const h = harness(['ok']);
    await h.session.start({ microphone: true, camera: true });
    const view = h.session.getView();
    expect(view.phase).toBe('live');
    expect(view.micOn).toBe(true);
    expect(view.cameraOn).toBe(true);
    expect(view.snapshot).not.toBeNull();
    expect(h.join).toHaveBeenCalledWith({
      token: 'tok_1',
      media: { microphone: true, camera: true },
    });
  });

  it('on a finished credential: mints fresh tokens, retries on the plan, and recovers', async () => {
    const h = harness(['ok', 'fail', 'fail', 'ok']);
    await h.session.start({ microphone: true, camera: false });
    const firstCall = h.calls[0];
    firstCall?.emit('needsNewJoinToken');
    await until(() => h.session.getView().phase === 'live' && h.calls.length === 2);

    expect(firstCall?.dispose).toHaveBeenCalled();
    expect(h.delays).toEqual([0, 600, 1500]);
    expect(h.mint).toHaveBeenCalledTimes(4);
    const attempts = [
      ...new Set(
        h.views.filter((view) => view.phase === 'rejoining').map((view) => view.rejoinAttempt),
      ),
    ];
    expect(attempts).toEqual([1, 2, 3]);
    expect(h.session.getView().rejoinAttempt).toBe(0);
  });

  it('gives up after the bounded attempts and says so', async () => {
    const h = harness(['ok', 'fail', 'fail', 'fail', 'fail']);
    await h.session.start({ microphone: true, camera: false });
    h.calls[0]?.emit('needsNewJoinToken');
    await until(() => h.session.getView().phase === 'rejoin-failed');

    expect(h.delays).toEqual([0, 600, 1500, 3000]);
    expect(h.session.getView().rejoinAttempt).toBe(REJOIN_MAX_ATTEMPTS);
    expect(h.session.getView().notice).not.toBeNull();
  });

  it('reports the room closing, and leaves cleanly', async () => {
    const h = harness(['ok']);
    await h.session.start({ microphone: true, camera: false });
    h.calls[0]?.emit('connectionChanged', { connection: 'ended' });
    expect(h.session.getView().phase).toBe('ended');

    const again = harness(['ok']);
    await again.session.start({ microphone: true, camera: false });
    again.session.leave();
    expect(again.calls[0]?.leave).toHaveBeenCalled();
    expect(again.calls[0]?.dispose).toHaveBeenCalled();
    expect(again.session.getView().phase).toBe('ended');
  });

  it('flags blocked audio and clears it after enableAudio', async () => {
    const h = harness(['ok']);
    await h.session.start({ microphone: true, camera: false });
    h.calls[0]?.emit('audioBlocked');
    expect(h.session.getView().audioBlocked).toBe(true);
    await h.session.enableAudio();
    expect(h.calls[0]?.enableAudio).toHaveBeenCalled();
    expect(h.session.getView().audioBlocked).toBe(false);
  });
});
