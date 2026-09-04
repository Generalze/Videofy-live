/** @author masterzee001 */
/**
 * Playing a programme that is deliberately behind the studio.
 *
 * The property every assertion here serves is one sentence: a protected
 * programme reaches its audience through the cursor or it does not reach them
 * at all. Everything that could quietly break that -- a fallback on error, a
 * lingering client from the previous run, a manifest that offers the studio's
 * position -- has a test whose failure would be the leak itself.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  RESUME_BEHIND_SECONDS,
  chooseDelayedPlaybackStrategy,
  mayFallBackToRealtime,
  nextPlaybackState,
  probePlaybackCapabilities,
  readPublicWindow,
  resumeOffsetSeconds,
  type DelayedPlaybackState,
} from './delayedProgrammePlayback';
import {
  DelayedProgrammePlayer,
  type HlsClientLike,
  type MediaElementLike,
} from './delayedProgrammePlayer';

/** A media element that records what was done to it. */
function element(): MediaElementLike & {
  fire: (type: string) => void;
  readonly listeners: Map<string, Set<() => void>>;
  readonly played: () => number;
} {
  const listeners = new Map<string, Set<() => void>>();
  let plays = 0;
  return {
    src: '',
    listeners,
    addEventListener(type, listener) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    removeAttribute() {
      /* nothing to record */
    },
    play() {
      plays += 1;
    },
    played: () => plays,
    fire(type) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
  };
}

function hlsClient(): HlsClientLike & {
  readonly loaded: string[];
  readonly destroyed: () => number;
  fail: (fatal: boolean) => void;
  readonly attachedTo: () => MediaElementLike | null;
} {
  const loaded: string[] = [];
  let destroyed = 0;
  let attachedTo: MediaElementLike | null = null;
  let onError: ((fatal: boolean) => void) | null = null;
  return {
    loaded,
    loadSource(url) {
      loaded.push(url);
    },
    attachMedia(media) {
      attachedTo = media;
    },
    onError(listener) {
      onError = listener;
    },
    destroy() {
      destroyed += 1;
    },
    destroyed: () => destroyed,
    attachedTo: () => attachedTo,
    fail: (fatal) => onError?.(fatal),
  };
}

const MANIFEST = [
  '#EXTM3U',
  '#EXT-X-VERSION:7',
  '#EXT-X-TARGETDURATION:2',
  '#EXT-X-MAP:URI="/programmes/run_1/segments/run_1.init.0"',
  '#EXTINF:2.000000,',
  '/programmes/run_1/segments/run_1.00000',
  '#EXTINF:2.000000,',
  '/programmes/run_1/segments/run_1.00001',
  '',
].join('\n');

function playerOver(options: {
  native?: boolean;
  mse?: boolean;
  client?: HlsClientLike;
  manifest?: () => Promise<string | null>;
}): { player: DelayedProgrammePlayer; tick: () => Promise<void> } {
  let scheduled: (() => void) | null = null;
  const player = new DelayedProgrammePlayer({
    capabilities: {
      canPlayNativeHls: options.native ?? false,
      mediaSourceSupported: options.mse ?? false,
    },
    ...(options.client === undefined ? {} : { createHlsClient: () => options.client as HlsClientLike }),
    fetchManifest: options.manifest ?? (async () => MANIFEST),
    setInterval: (handler) => {
      scheduled = handler;
      return 1;
    },
    clearInterval: () => {
      scheduled = null;
    },
  });
  return {
    player,
    tick: async () => {
      scheduled?.();
      // Let the manifest read settle before the assertion looks at the state.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe('choosing how this browser will play it', () => {
  it('uses the platform own pipeline where it exists', () => {
    // On iPhone this is the only option that works at all; where both exist
    // it is hardware-accelerated and kinder to a battery.
    expect(
      chooseDelayedPlaybackStrategy({ canPlayNativeHls: true, mediaSourceSupported: true }),
    ).toBe('native');
  });

  it('uses Media Source Extensions where native playback is absent', () => {
    expect(
      chooseDelayedPlaybackStrategy({ canPlayNativeHls: false, mediaSourceSupported: true }),
    ).toBe('mse');
  });

  it('says unsupported rather than pretending', () => {
    expect(
      chooseDelayedPlaybackStrategy({ canPlayNativeHls: false, mediaSourceSupported: false }),
    ).toBe('unsupported');
  });

  it('treats a "maybe" from the browser as yes, because Safari says maybe', () => {
    const capabilities = probePlaybackCapabilities(
      () => ({ canPlayType: () => 'maybe' }),
      undefined,
    );
    expect(capabilities.canPlayNativeHls).toBe(true);
  });

  it('asks about the codecs we actually produce, not about MSE in the abstract', () => {
    const asked: string[] = [];
    probePlaybackCapabilities(() => ({ canPlayType: () => '' }), {
      isTypeSupported: (type: string) => {
        asked.push(type);
        return true;
      },
    });
    expect(asked[0]).toContain('avc1');
    expect(asked[0]).toContain('mp4a');
  });

  it('survives a browser that throws when asked', () => {
    const capabilities = probePlaybackCapabilities(() => {
      throw new Error('no media element here');
    }, undefined);
    expect(capabilities.canPlayNativeHls).toBe(false);
  });

  it('will not claim MSE without a client to drive it', () => {
    // Claiming the strategy with no factory fails later, in the dark.
    const { player } = playerOver({ mse: true });
    expect(player.playbackStrategy).toBe('unsupported');
  });
});

describe('the states a viewer is owed', () => {
  const walk = (from: DelayedPlaybackState, ...signals: Parameters<typeof nextPlaybackState>[1][]) =>
    signals.reduce(nextPlaybackState, from);

  it('goes idle, loading, playing', () => {
    expect(walk('idle', 'load-requested', 'first-media')).toBe('playing');
  });

  it('calls a stall rebuffering, not playing and not failed', () => {
    expect(walk('idle', 'load-requested', 'first-media', 'stalled')).toBe('rebuffering');
    expect(walk('idle', 'load-requested', 'first-media', 'stalled', 'resumed')).toBe('playing');
  });

  it('keeps draining separate from playing to the end of the tail', () => {
    /*
     * The studio stopping is not the programme ending: the audience still has
     * the whole delay left to watch. Showing "ended" there would cut off the
     * last forty-five seconds of every protected programme.
     */
    const draining = walk('idle', 'load-requested', 'first-media', 'drain-began');
    expect(draining).toBe('draining');
    expect(nextPlaybackState(draining, 'resumed')).toBe('draining');
    expect(nextPlaybackState(draining, 'exhausted')).toBe('ended');
  });

  it('treats a fatal error as terminal and visible', () => {
    expect(walk('idle', 'load-requested', 'first-media', 'fatal')).toBe('failed');
    // And it does not recover on its own into something that looks fine.
    expect(nextPlaybackState('failed', 'first-media')).toBe('failed');
  });

  it('never reports a network failure as live', () => {
    const failed = walk('idle', 'load-requested', 'fatal');
    expect(failed).not.toBe('playing');
    expect(failed).toBe('failed');
  });
});

describe('the rule that must never acquire an exception', () => {
  it('offers no realtime fallback for a protected programme', () => {
    expect(mayFallBackToRealtime('delayed')).toBe(false);
    expect(mayFallBackToRealtime('live')).toBe(true);
  });

  it('refuses to play at all on a browser that cannot, rather than falling back', async () => {
    const { player } = playerOver({ native: false, mse: false });
    const state = await player.attach({
      element: element(),
      manifestUrl: '/programmes/run_1/playlist.m3u8',
      programmeRunId: 'run_1',
    });
    /*
     * A viewer on a browser that cannot play the protected path is a viewer
     * who does not watch this programme. The alternative is delivering the
     * material the delay exists to withhold.
     */
    expect(state).toBe('failed');
  });

  it('builds no client at all when the browser cannot play the protected path', async () => {
    /*
     * The distinguishing case, and the reason the previous assertion is not
     * enough on its own: a client factory can be present on a browser with
     * neither native HLS nor Media Source Extensions. Attempting playback
     * there fails somewhere deep in a library instead of here, and a failure
     * that is not attributed is a failure somebody eventually "fixes" with a
     * fallback to the realtime feed.
     */
    const client = hlsClient();
    const { player } = playerOver({ native: false, mse: false, client });
    const state = await player.attach({
      element: element(),
      manifestUrl: '/programmes/run_1/playlist.m3u8',
      programmeRunId: 'run_1',
    });
    expect(state).toBe('failed');
    expect(client.loaded).toEqual([]);
    expect(client.attachedTo()).toBeNull();
  });

  it('ends a fatal client error in failed, with nothing else attempted', async () => {
    const client = hlsClient();
    const { player } = playerOver({ mse: true, client });
    await player.attach({
      element: element(),
      manifestUrl: '/programmes/run_1/playlist.m3u8',
      programmeRunId: 'run_1',
    });
    client.fail(true);
    expect(player.playbackState).toBe('failed');
  });

  it('treats a non-fatal client error as a stall, not a failure', async () => {
    const client = hlsClient();
    const { player } = playerOver({ mse: true, client });
    const media = element();
    await player.attach({
      element: media,
      manifestUrl: '/programmes/run_1/playlist.m3u8',
      programmeRunId: 'run_1',
    });
    media.fire('playing');
    client.fail(false);
    expect(player.playbackState).toBe('rebuffering');
  });
});

describe('what each strategy actually does', () => {
  it('hands the manifest to the element for native playback', async () => {
    const { player } = playerOver({ native: true });
    const media = element();
    await player.attach({
      element: media,
      manifestUrl: '/programmes/run_1/playlist.m3u8',
      programmeRunId: 'run_1',
    });
    expect(player.playbackStrategy).toBe('native');
    expect(media.src).toBe('/programmes/run_1/playlist.m3u8');
    expect(media.played()).toBe(1);
  });

  it('hands it to the client for MSE playback', async () => {
    const client = hlsClient();
    const { player } = playerOver({ mse: true, client });
    const media = element();
    await player.attach({
      element: media,
      manifestUrl: '/programmes/run_1/playlist.m3u8',
      programmeRunId: 'run_1',
    });
    expect(player.playbackStrategy).toBe('mse');
    expect(client.loaded).toEqual(['/programmes/run_1/playlist.m3u8']);
    expect(client.attachedTo()).toBe(media);
    // The element is never pointed at the manifest itself on this path.
    expect(media.src).toBe('');
  });
});

describe('changing programme leaves nothing behind', () => {
  it('destroys the previous client before building the next', async () => {
    const first = hlsClient();
    const clients = [first, hlsClient()];
    let issued = 0;
    const player = new DelayedProgrammePlayer({
      capabilities: { canPlayNativeHls: false, mediaSourceSupported: true },
      createHlsClient: () => clients[issued++] as HlsClientLike,
      fetchManifest: async () => MANIFEST,
    });

    const media = element();
    await player.attach({ element: media, manifestUrl: '/a.m3u8', programmeRunId: 'run_1' });
    await player.attach({ element: media, manifestUrl: '/b.m3u8', programmeRunId: 'run_2' });

    /*
     * Two clients appending to one element is two buffers, two error streams
     * and two ideas of where the audience is -- impossible A/V behaviour that
     * no single component can be blamed for.
     */
    expect(first.destroyed()).toBe(1);
    expect(player.attachedRunId).toBe('run_2');
  });

  it('removes its media listeners, so an old element cannot drive the new state', async () => {
    const { player } = playerOver({ native: true });
    const media = element();
    await player.attach({ element: media, manifestUrl: '/a.m3u8', programmeRunId: 'run_1' });
    player.detach();

    media.fire('playing');
    // A stray event from a torn-down programme must not report playback.
    expect(player.playbackState).toBe('idle');
  });

  it('stops the drain check when it lets go', async () => {
    const cleared = vi.fn();
    const player = new DelayedProgrammePlayer({
      capabilities: { canPlayNativeHls: true, mediaSourceSupported: false },
      fetchManifest: async () => MANIFEST,
      setInterval: () => 7,
      clearInterval: cleared,
    });
    await player.attach({ element: element(), manifestUrl: '/a.m3u8', programmeRunId: 'run_1' });
    player.detach();
    expect(cleared).toHaveBeenCalledWith(7);
  });

  it('clears the element source, so it stops fetching the old programme', async () => {
    const { player } = playerOver({ native: true });
    const media = element();
    await player.attach({ element: media, manifestUrl: '/a.m3u8', programmeRunId: 'run_1' });
    player.detach();
    expect(media.src).toBe('');
  });
});

describe('the end of a protected broadcast', () => {
  it('reports draining for both strategies, from the manifest itself', async () => {
    const ended = `${MANIFEST}#EXT-X-ENDLIST\n`;
    for (const strategy of [{ native: true }, { mse: true, client: hlsClient() }]) {
      const { player, tick } = playerOver({ ...strategy, manifest: async () => ended });
      const media = element();
      await player.attach({ element: media, manifestUrl: '/a.m3u8', programmeRunId: 'run_1' });
      media.fire('playing');
      await tick();
      /*
       * Native playback gives no event for "the playlist gained an ENDLIST".
       * If only the MSE path reported this, iPhone viewers would be told a
       * protected programme had ended with the whole tail still to come.
       */
      expect(player.playbackState).toBe('draining');
    }
  });

  it('plays the tail before it says ended', async () => {
    const ended = `${MANIFEST}#EXT-X-ENDLIST\n`;
    const { player, tick } = playerOver({ native: true, manifest: async () => ended });
    const media = element();
    await player.attach({ element: media, manifestUrl: '/a.m3u8', programmeRunId: 'run_1' });
    media.fire('playing');
    await tick();
    expect(player.playbackState).toBe('draining');

    media.fire('ended');
    expect(player.playbackState).toBe('ended');
  });

  it('fails when the manifest is withdrawn rather than replaying what it holds', async () => {
    const { player, tick } = playerOver({ native: true, manifest: async () => null });
    const media = element();
    await player.attach({ element: media, manifestUrl: '/a.m3u8', programmeRunId: 'run_1' });
    media.fire('playing');
    await tick();
    // A pulled broadcast must stop. Continuing on the client's own copy is
    // how an audience keeps watching something that was withdrawn.
    expect(player.playbackState).toBe('failed');
  });
});

describe('where a returning viewer belongs', () => {
  it('reads only what the cursor has published', () => {
    const window = readPublicWindow(MANIFEST);
    expect(window.segmentUris).toHaveLength(2);
    expect(window.durationSeconds).toBeCloseTo(4, 5);
    expect(window.initUri).toBe('/programmes/run_1/segments/run_1.init.0');
    expect(window.complete).toBe(false);
  });

  it('resumes inside the public window and never at the studio position', () => {
    /*
     * The directive's case: live is 660 s, the audience is at 615 s. The
     * manifest a client is given ENDS at 615 s -- the studio's position is
     * not in the document -- so there is no arithmetic here to get wrong.
     */
    const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:2'];
    for (let at = 0; at < 614; at += 2) {
      lines.push('#EXTINF:2.000000,', `/programmes/run_1/segments/run_1.${at}`);
    }
    const window = readPublicWindow(`${lines.join('\n')}\n`);

    expect(window.durationSeconds).toBeCloseTo(614, 0);
    const resume = resumeOffsetSeconds(window);
    expect(resume).toBeLessThan(615);
    expect(resume).toBeGreaterThan(600);
    // A few seconds in hand, so playback does not begin at the exact edge
    // with nothing buffered and stall immediately.
    expect(window.durationSeconds - resume).toBeCloseTo(RESUME_BEHIND_SECONDS, 5);
  });

  it('starts at the beginning when the window is empty rather than seeking nowhere', () => {
    expect(resumeOffsetSeconds(readPublicWindow('#EXTM3U\n'))).toBe(0);
  });

  it('re-reads the manifest on re-attach instead of trusting what it held', async () => {
    let served = 0;
    const { player } = playerOver({
      native: true,
      manifest: async () => {
        served += 1;
        return MANIFEST;
      },
    });
    const media = element();
    await player.attach({ element: media, manifestUrl: '/a.m3u8', programmeRunId: 'run_1' });
    await player.checkForDrain('/a.m3u8');
    await player.attach({ element: media, manifestUrl: '/a.m3u8', programmeRunId: 'run_1' });
    await player.checkForDrain('/a.m3u8');
    // The authoritative window is asked for again; a cached one is a claim
    // about a moment that has passed.
    expect(served).toBe(2);
  });
});
