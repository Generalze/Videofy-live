import { describe, expect, it } from 'vitest';
import {
  createBrowserGeneratedAudioPlayer,
  type GeneratedAudioElementLike,
} from './callGeneratedAudioPlayer';
import { CallAudioOutputController } from './callAudioOutput';

/**
 * The element-level half of the Android fix.
 *
 * Autoplay permission belongs to the ELEMENT, not the page. The previous
 * implementation built `new Audio(url)` per clip, so "Enable audio" unlocked an
 * element that was thrown away when its clip ended and the next clip arrived on
 * a fresh, locked one — which is exactly what the phone showed: tapping fixed
 * one clip and then asked again.
 */
class FakeElement implements GeneratedAudioElementLike {
  volume = 1;
  currentTime = 0;
  preload = '';
  src = '';
  paused = true;
  readyState = 0;
  networkState = 0;
  error: { code: number; message?: string } | null = null;
  readonly attributes: Record<string, string> = {};
  readonly listeners = new Map<string, (() => void)[]>();
  readonly playedSources: string[] = [];
  readonly volumesAtPlay: number[] = [];
  loadCount = 0;
  /**
   * Chrome's actual rule, modelled: a programmatic `play()` is refused until
   * the element has played once, and the only way to get that first play is
   * from inside a user gesture. After that the permission is sticky TO THE
   * ELEMENT — which is why one long-lived element fixes this and a per-clip
   * element cannot.
   */
  requiresGesture = false;
  /** Set for the duration of a simulated tap. */
  gestureActive = false;
  private everPlayed = false;

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  removeAttribute(name: string): void {
    delete this.attributes[name];
  }
  addEventListener(type: string, listener: () => void): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }
  load(): void {
    this.loadCount += 1;
  }
  async play(): Promise<void> {
    if (this.requiresGesture && !this.everPlayed && !this.gestureActive) {
      throw new Error('NotAllowedError');
    }
    this.everPlayed = true;
    this.paused = false;
    this.playedSources.push(this.src);
    this.volumesAtPlay.push(this.volume);
  }
  pause(): void {
    this.paused = true;
  }
  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  /** W8: the platform's routing mechanism, recorded. */
  readonly sinkIds: string[] = [];
  async setSinkId(sinkId: string): Promise<void> {
    this.sinkIds.push(sinkId);
  }
}

function playerWith(configure: (element: FakeElement) => void = () => {}) {
  const element = new FakeElement();
  configure(element);
  const diagnostics: { event: string; reason: string | null; errorName: string | null }[] = [];
  const player = createBrowserGeneratedAudioPlayer({
    createElement: () => element,
    onDiagnostic: (event, detail) =>
      diagnostics.push({
        event,
        reason: detail.reason ?? null,
        errorName: detail.error instanceof Error ? detail.error.name : null,
      }),
  });
  return { player, element, diagnostics };
}

describe('unlocking', () => {
  it('plays a silent tone inside the gesture, then leaves the element ready and quiet', async () => {
    const { player, element } = playerWith();

    await expect(player.unlock()).resolves.toBe(true);

    expect(element.playedSources[0]).toMatch(/^data:audio\/wav;base64,/);
    // Nobody hears the unlock.
    expect(element.volumesAtPlay[0]).toBe(0);
    expect(element.paused).toBe(true);
    // The listener's chosen level is not left at zero afterwards.
    expect(element.volume).toBe(1);
  });

  it('unlocks once and then stops asking', async () => {
    const { player, element } = playerWith();

    await player.unlock();
    await player.unlock();
    await player.unlock();

    expect(element.playedSources).toHaveLength(1);
  });

  it('reports failure rather than throwing when the gesture is refused', async () => {
    const { player } = playerWith((element) => {
      element.play = async () => {
        throw new Error('NotAllowedError');
      };
    });

    await expect(player.unlock()).resolves.toBe(false);
  });

  it('lets every later clip play on the one element the gesture unlocked', async () => {
    // The whole Android defect in one assertion: a single unlock, then four
    // clips, with no further gesture and no new element.
    const { player, element } = playerWith((fake) => {
      fake.requiresGesture = true;
    });

    // Before any tap, a clip arriving on its own is refused.
    await expect(player.play('clip-1')).rejects.toThrow();

    // The tap.
    element.gestureActive = true;
    await expect(player.unlock()).resolves.toBe(true);
    element.gestureActive = false;

    // Everything after it plays with no further gesture and no new element.
    for (const url of ['clip-1', 'clip-2', 'clip-3', 'clip-4']) {
      await player.play(url);
    }

    expect(element.playedSources.slice(1)).toEqual(['clip-1', 'clip-2', 'clip-3', 'clip-4']);
  });
});

describe('clip lifecycle events', () => {
  it('reports the end of a clip it is holding', async () => {
    const { player, element } = playerWith();
    let ended = 0;
    player.onended = () => {
      ended += 1;
    };

    await player.play('clip-1');
    element.emit('ended');

    expect(ended).toBe(1);
  });

  it('suppresses a stale end after the clip was stopped', async () => {
    // This is the protection that moved here from the queue when per-clip
    // elements were replaced by one. With a single element there is no object
    // identity to compare, so the element itself must know it is no longer
    // holding a clip — otherwise a late `ended` closes the NEXT clip's W4
    // interval, or one that was never opened.
    const { player, element } = playerWith();
    let ended = 0;
    player.onended = () => {
      ended += 1;
    };

    await player.play('clip-1');
    player.pause();
    element.emit('ended');

    expect(ended).toBe(0);
  });

  it('never reports the unlock tone as a clip', async () => {
    const { player, element } = playerWith();
    let ended = 0;
    let errored = 0;
    player.onended = () => {
      ended += 1;
    };
    player.onerror = () => {
      errored += 1;
    };

    await player.unlock();
    element.emit('ended');
    element.emit('error');

    expect({ ended, errored }).toEqual({ ended: 0, errored: 0 });
  });

  it('reports an error only while a clip is loaded', async () => {
    const { player, element } = playerWith();
    let errored = 0;
    player.onerror = () => {
      errored += 1;
    };

    element.emit('error');
    expect(errored).toBe(0);

    await player.play('clip-1');
    element.emit('error');
    expect(errored).toBe(1);

    // The error released the clip; a second event must not double-report it.
    element.emit('error');
    expect(errored).toBe(1);
  });
});

/**
 * The forensics wave. "Enable audio" currently appears for a play() rejection
 * AND for a media error, and those are unrelated faults with unrelated fixes —
 * which is how the first attempt targeted an unestablished cause.
 */
describe('failure classification', () => {
  it('separates an autoplay refusal from a media load failure', async () => {
    const { player, element, diagnostics } = playerWith((fake) => {
      fake.play = async () => {
        throw Object.assign(new Error('play() blocked'), { name: 'NotAllowedError' });
      };
    });

    await expect(player.play('clip-1')).rejects.toThrow();
    expect(diagnostics.at(-1)).toMatchObject({
      event: 'play-rejected',
      reason: 'autoplay-policy-blocked',
      errorName: 'NotAllowedError',
    });

    // The other class entirely: the element itself reports a fault.
    element.error = { code: 4, message: 'SRC_NOT_SUPPORTED' };
    element.emit('error');
    expect(diagnostics.at(-1)).toMatchObject({
      event: 'media-error',
      reason: 'media-load-error',
    });
  });

  it('maps each MediaError code to its own class', () => {
    const cases: [number, string][] = [
      [2, 'network-source-failure'],
      [3, 'decode-not-supported'],
      [4, 'media-load-error'],
      [1, 'unknown-playback-failure'],
    ];
    for (const [code, reason] of cases) {
      const { element, diagnostics } = playerWith();
      element.error = { code };
      element.emit('error');
      expect(diagnostics.at(-1), `code ${code}`).toMatchObject({ event: 'media-error', reason });
    }
  });

  it('prefers a latched media error over an opaque play() rejection', async () => {
    // A bare rejection says almost nothing. If the element has already recorded
    // why, that is the better answer and the one worth reporting.
    const { player, element, diagnostics } = playerWith((fake) => {
      fake.error = { code: 2, message: 'network' };
      fake.play = async () => {
        throw new Error('play failed');
      };
    });
    void element;

    await expect(player.play('clip-1')).rejects.toThrow();

    expect(diagnostics.at(-1)).toMatchObject({
      event: 'play-rejected',
      reason: 'network-source-failure',
    });
  });

  it('records the whole sequence a clip goes through', async () => {
    const { player, element, diagnostics } = playerWith();

    await player.unlock();
    await player.play('clip-1');
    element.emit('canplay');
    element.emit('playing');
    element.emit('ended');

    expect(diagnostics.map((entry) => entry.event)).toEqual([
      'unlock-start',
      'unlock-success',
      'play-called',
      'play-resolved',
      'canplay',
      'playing',
      'ended',
    ]);
  });

  it('records a media error during the unlock tone, which nothing else would notice', async () => {
    const { player, element, diagnostics } = playerWith();
    await player.unlock();

    element.error = { code: 4 };
    element.emit('error');

    // No clip is loaded, so no clip callback fires — but the event is recorded,
    // because an unlock that silently fails this way would look exactly like a
    // policy block from the outside.
    expect(diagnostics.at(-1)).toMatchObject({ event: 'media-error', reason: 'media-load-error' });
  });

  it('never lets a throwing diagnostic sink break playback', async () => {
    const element = new FakeElement();
    const player = createBrowserGeneratedAudioPlayer({
      createElement: () => element,
      onDiagnostic: () => {
        throw new Error('diagnostics exploded');
      },
    });

    await expect(player.play('clip-1')).resolves.toBeUndefined();
  });
});

describe('element setup', () => {
  it('asks for inline playback, so iOS does not take the clip fullscreen', () => {
    const { element } = playerWith();

    expect(element.attributes['playsinline']).toBe('');
    expect(element.preload).toBe('auto');
  });

  it('releases the source on dispose', async () => {
    const { player, element } = playerWith();
    await player.play('clip-1');

    player.dispose();

    expect(element.paused).toBe(true);
    expect(element.attributes['src']).toBeUndefined();
  });
});

/**
 * P6.4-W8 — generated playback follows the same selected output.
 *
 * The player owns exactly one persistent element, so following the selection
 * means registering that one element for the player's whole lifetime. The
 * unlock behaviour is untouched by routing — permission belongs to the
 * element, and the element does not change when its sink does.
 */
describe('W8 output routing', () => {
  it('registers its one persistent element with the output controller on creation', () => {
    const element = new FakeElement();
    const registered: unknown[] = [];
    const unregistered: unknown[] = [];

    const player = createBrowserGeneratedAudioPlayer({
      createElement: () => element,
      outputController: {
        registerElement: (el) => registered.push(el),
        unregisterElement: (el) => unregistered.push(el),
      },
    });

    expect(registered).toEqual([element]);
    expect(unregistered).toEqual([]);
    void player;
  });

  it('unregisters the element on dispose', () => {
    const element = new FakeElement();
    const unregistered: unknown[] = [];
    const player = createBrowserGeneratedAudioPlayer({
      createElement: () => element,
      outputController: {
        registerElement: () => {},
        unregisterElement: (el) => unregistered.push(el),
      },
    });

    player.dispose();

    expect(unregistered).toEqual([element]);
  });

  it('a standing selection reaches the element before the first clip plays', async () => {
    const output = new CallAudioOutputController();
    await output.setOutput('out-1');
    const element = new FakeElement();

    const player = createBrowserGeneratedAudioPlayer({
      createElement: () => element,
      outputController: output,
    });
    await player.play('clip-1');

    expect(element.sinkIds).toEqual(['out-1']);
    expect(element.playedSources).toEqual(['clip-1']);
  });

  it('a later selection follows the persistent element', async () => {
    const output = new CallAudioOutputController();
    const element = new FakeElement();
    createBrowserGeneratedAudioPlayer({
      createElement: () => element,
      outputController: output,
    });

    await output.setOutput('out-2');
    await output.setOutput(null);

    expect(element.sinkIds).toEqual(['out-2', '']);
  });

  it('unlock behaviour is untouched by routing (still one silent tone, still quiet)', async () => {
    const output = new CallAudioOutputController();
    await output.setOutput('out-1');
    const element = new FakeElement();
    const player = createBrowserGeneratedAudioPlayer({
      createElement: () => element,
      outputController: output,
    });

    await expect(player.unlock()).resolves.toBe(true);

    expect(element.playedSources[0]).toMatch(/^data:audio\/wav;base64,/);
    expect(element.volumesAtPlay[0]).toBe(0);
    expect(element.volume).toBe(1);
  });
});
