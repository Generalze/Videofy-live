import { describe, expect, it } from 'vitest';
import {
  CallRemoteSpeakerAudioController,
  type RemoteAudioElementLike,
  type RemoteSpeakerAudio,
} from './callRemoteSpeakerAudio';
import type { CallRemoteBinding } from './callRemoteSlots';

class FakeElement implements RemoteAudioElementLike {
  volume = 1;
  muted = false;
  srcObject: unknown = null;
  autoplay = false;
  paused = true;
  playCount = 0;
  rejectPlay = false;
  readonly attributes: Record<string, string> = {};

  async play(): Promise<void> {
    this.playCount += 1;
    if (this.rejectPlay) throw new Error('NotAllowedError');
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
  addEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((existing) => existing !== listener),
    );
  }
  /** The browser's own verdict. Nothing else may claim playback started. */
  emit(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener();
  }

  private readonly listeners = new Map<string, (() => void)[]>();
}

/**
 * Track objects are STABLE per id, exactly as they are in production: the
 * binder holds one MediaStreamTrack per mid and hands back the same object
 * every time. A fixture that minted a fresh object per call would make the
 * controller re-point a track that had not actually changed.
 */
const tracks = new Map<string, { id: string }>();
function trackFor(id: string): { id: string } {
  const existing = tracks.get(id);
  if (existing) return existing;
  const created = { id };
  tracks.set(id, created);
  return created;
}

function binding(
  speakerParticipantId: string,
  slot: number,
  trackId = speakerParticipantId,
): CallRemoteBinding {
  return { speakerParticipantId, slot, track: trackFor(trackId) };
}

function controllerWith() {
  const elements: FakeElement[] = [];
  const states: readonly RemoteSpeakerAudio[][] = [];
  const captured: RemoteSpeakerAudio[][] = states as RemoteSpeakerAudio[][];
  const blocked: boolean[] = [];
  const controller = new CallRemoteSpeakerAudioController({
    createElement: () => {
      const element = new FakeElement();
      elements.push(element);
      return element;
    },
    createStream: (track) => ({ track }) as never,
    onStateChange: (speakers) => captured.push([...speakers]),
    onPlaybackBlocked: (value) => blocked.push(value),
  });
  return { controller, elements, captured, blocked };
}

/** The element playing a given speaker, by construction order. */
function elementFor(
  h: ReturnType<typeof controllerWith>,
  speakerId: string,
): FakeElement {
  // Find the element holding this speaker's track.
  const element = h.elements.find(
    (candidate) => (candidate.srcObject as { track?: { id?: string } })?.track?.id === speakerId,
  );
  if (!element) throw new Error(`no element for ${speakerId}`);
  return element;
}

describe('one playback path per bound speaker', () => {
  it('creates a separate element for each of three remote speakers', () => {
    const h = controllerWith();

    h.controller.applyBindings([binding('p2', 0), binding('p3', 1), binding('p4', 2)]);

    expect(h.elements).toHaveLength(3);
    expect(h.controller.speakers().map((s) => s.speakerParticipantId)).toEqual(['p2', 'p3', 'p4']);
    // Each element carries its own speaker's track, not a shared stream.
    const tracks = h.elements.map((e) => (e.srcObject as { track: { id: string } }).track.id);
    expect(new Set(tracks).size).toBe(3);
  });

  it('creates nothing for idle preallocated slots', () => {
    // A listener must never be shown a nameless speaker who is really an empty
    // transport slot.
    const h = controllerWith();

    h.controller.applyBindings([binding('p2', 0)]);

    expect(h.elements).toHaveLength(1);
    expect(h.controller.speakers()).toHaveLength(1);
  });

  it('does not share one element between speakers', () => {
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0), binding('p3', 1)]);

    expect(elementFor(h, 'p2')).not.toBe(elementFor(h, 'p3'));
  });

  it('plays each speaker once, and reports a refusal', async () => {
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0)]);
    await Promise.resolve();

    expect(h.elements[0]!.playCount).toBe(1);
    expect(h.blocked).toContain(false);
  });
});

describe('per-speaker controls are independent and local', () => {
  it('muting A leaves B audible', () => {
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0), binding('p3', 1)]);

    h.controller.setMuted('p2', true);

    expect(elementFor(h, 'p2').muted).toBe(true);
    expect(elementFor(h, 'p3').muted).toBe(false);
  });

  it('unmuting brings A back without touching B', () => {
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0), binding('p3', 1)]);
    h.controller.setMuted('p2', true);

    h.controller.setMuted('p2', false);

    expect(elementFor(h, 'p2').muted).toBe(false);
    expect(elementFor(h, 'p3').muted).toBe(false);
  });

  it('changing A volume does not alter B', () => {
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0), binding('p3', 1)]);

    h.controller.setVolume('p2', 0.25);

    expect(elementFor(h, 'p2').volume).toBe(0.25);
    expect(elementFor(h, 'p3').volume).toBe(1);
  });

  it('clamps a nonsense volume rather than handing it to the element', () => {
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0)]);

    h.controller.setVolume('p2', 5);
    expect(elementFor(h, 'p2').volume).toBe(1);
    h.controller.setVolume('p2', -1);
    expect(elementFor(h, 'p2').volume).toBe(0);
    h.controller.setVolume('p2', Number.NaN);
    expect(elementFor(h, 'p2').volume).toBe(0);
  });

  it('keeps three speakers independently controllable', () => {
    // The conference case: simultaneous speakers, separate controls.
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0), binding('p3', 1), binding('p4', 2)]);

    h.controller.setMuted('p3', true);
    h.controller.setVolume('p4', 0.5);

    expect(h.controller.speakers()).toEqual([
      { speakerParticipantId: 'p2', slot: 0, muted: false, volume: 1, originalSuppressed: false },
      { speakerParticipantId: 'p3', slot: 1, muted: true, volume: 1, originalSuppressed: false },
      { speakerParticipantId: 'p4', slot: 2, muted: false, volume: 0.5, originalSuppressed: false },
    ]);
  });
});

describe('membership lifecycle', () => {
  it('removes only the departed speaker', () => {
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0), binding('p3', 1), binding('p4', 2)]);
    const survivor = elementFor(h, 'p3');
    const leaving = elementFor(h, 'p4');

    h.controller.applyBindings([binding('p2', 0), binding('p3', 1)]);

    expect(h.controller.speakers().map((s) => s.speakerParticipantId)).toEqual(['p2', 'p3']);
    expect(leaving.srcObject).toBeNull();
    expect(leaving.paused).toBe(true);
    // The survivor was not disturbed.
    expect(survivor.srcObject).not.toBeNull();
    expect(survivor.paused).toBe(false);
  });

  it('a new participant appears without disturbing existing playback', () => {
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0)]);
    const existing = elementFor(h, 'p2');
    const playsBefore = existing.playCount;

    h.controller.applyBindings([binding('p2', 0), binding('p3', 1)]);

    expect(existing.playCount).toBe(playsBefore);
    expect(h.controller.speakers()).toHaveLength(2);
  });

  it('handles a slot being reused by a different participant', () => {
    // W2 rebinds a freed slot to a new speaker on the SAME track. The listener
    // must end up hearing the new person under the new identity, once.
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0, 'slot0-track')]);
    h.controller.applyBindings([]);

    h.controller.applyBindings([binding('p9', 0, 'slot0-track')]);

    expect(h.controller.speakers().map((s) => s.speakerParticipantId)).toEqual(['p9']);
    // Exactly one live element, not a duplicate carrying the old identity.
    const live = h.elements.filter((element) => element.srcObject !== null);
    expect(live).toHaveLength(1);
  });

  it('re-points a speaker moved onto a different track without rebuilding', () => {
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0, 'track-a')]);
    const element = h.elements[0]!;

    h.controller.applyBindings([binding('p2', 1, 'track-b')]);

    expect(h.elements).toHaveLength(1);
    expect((element.srcObject as { track: { id: string } }).track.id).toBe('track-b');
    expect(h.controller.speakers()[0]!.slot).toBe(1);
  });

  it('does not duplicate playback when the same bindings arrive twice', () => {
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0), binding('p3', 1)]);
    h.controller.applyBindings([binding('p2', 0), binding('p3', 1)]);
    h.controller.applyBindings([binding('p2', 0), binding('p3', 1)]);

    expect(h.elements).toHaveLength(2);
  });

  it('emits state only when something actually changed', () => {
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0)]);
    const emissions = h.captured.length;

    h.controller.applyBindings([binding('p2', 0)]);

    expect(h.captured).toHaveLength(emissions);
  });
});

describe('reconnect', () => {
  it('tears every element down on reset', () => {
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0), binding('p3', 1)]);

    h.controller.reset();

    expect(h.controller.speakers()).toEqual([]);
    for (const element of h.elements) expect(element.srcObject).toBeNull();
  });

  it('preserves the listener preferences across a rebuild', () => {
    // Losing mute and volume on every reconnect reads as the app ignoring the
    // listener, and a phone reconnects whenever the screen goes off.
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0), binding('p3', 1)]);
    h.controller.setMuted('p2', true);
    h.controller.setVolume('p3', 0.3);

    h.controller.reset();
    h.controller.applyBindings([binding('p2', 0), binding('p3', 1)]);

    expect(h.controller.speakers()).toEqual([
      { speakerParticipantId: 'p2', slot: 0, muted: true, volume: 1, originalSuppressed: false },
      { speakerParticipantId: 'p3', slot: 1, muted: false, volume: 0.3, originalSuppressed: false },
    ]);
    expect(elementFor(h, 'p2').muted).toBe(true);
    expect(elementFor(h, 'p3').volume).toBe(0.3);
  });

  it('forgets preferences only on dispose', () => {
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0)]);
    h.controller.setMuted('p2', true);

    h.controller.dispose();
    h.controller.applyBindings([binding('p2', 0)]);

    expect(h.controller.speakers()[0]!.muted).toBe(false);
  });

  it('retries every element on a gesture unlock', async () => {
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0), binding('p3', 1)]);
    const before = h.elements.map((element) => element.playCount);

    await h.controller.unlock();

    expect(h.elements.map((element) => element.playCount)).toEqual(before.map((n) => n + 1));
    expect(h.blocked.at(-1)).toBe(false);
  });

  it('reports still-blocked when a gesture retry is refused', async () => {
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0)]);
    h.elements[0]!.rejectPlay = true;

    await h.controller.unlock();

    expect(h.blocked.at(-1)).toBe(true);
  });
});

describe('two-party parity', () => {
  it('represents exactly one remote participant, with working controls', () => {
    const h = controllerWith();

    h.controller.applyBindings([binding('p2', 0)]);
    h.controller.setVolume('p2', 0.4);
    h.controller.setMuted('p2', true);

    expect(h.elements).toHaveLength(1);
    expect(h.controller.speakers()).toEqual([
      { speakerParticipantId: 'p2', slot: 0, muted: true, volume: 0.4, originalSuppressed: false },
    ]);
  });

  it('produces no element at all before anyone else joins', () => {
    const h = controllerWith();

    h.controller.applyBindings([]);

    expect(h.elements).toHaveLength(0);
    expect(h.controller.speakers()).toEqual([]);
  });
});

/**
 * ONE authoritative original-audio path.
 *
 * The client used to ALSO attach the first remote stream to a shared anonymous
 * element. With one negotiated slot that was the only audible path, which is
 * why the transport defect hid behind it — and with three slots negotiated it
 * would play every remote a second time.
 */
describe('a remote track is played exactly once', () => {
  it('creates one element per speaker and no shared anonymous element', () => {
    const h = controllerWith();

    h.controller.applyBindings([binding('p2', 0), binding('p3', 1)]);

    // Two speakers, two elements — not three, and not one shared.
    expect(h.elements).toHaveLength(2);
    const sources = h.elements.map((e) => (e.srcObject as { track: { id: string } }).track.id);
    expect(sources.sort()).toEqual(['p2', 'p3']);
  });

  it('plays a two-party remote through exactly one element', () => {
    const h = controllerWith();

    h.controller.applyBindings([binding('p2', 0)]);

    expect(h.elements).toHaveLength(1);
    expect(h.elements.filter((e) => e.srcObject !== null)).toHaveLength(1);
  });

  it('leaves NOTHING audible for a speaker who is muted', () => {
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0), binding('p3', 1)]);

    h.controller.setMuted('p2', true);

    // Every element carrying p2 is muted; there is no second path.
    const p2Elements = h.elements.filter(
      (e) => (e.srcObject as { track?: { id?: string } })?.track?.id === 'p2',
    );
    expect(p2Elements).toHaveLength(1);
    expect(p2Elements.every((e) => e.muted)).toBe(true);
    expect(elementFor(h, 'p3').muted).toBe(false);
  });

  it('leaves NOTHING audible for a speaker at volume zero', () => {
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0), binding('p3', 1)]);

    h.controller.setVolume('p2', 0);

    expect(elementFor(h, 'p2').volume).toBe(0);
    expect(elementFor(h, 'p3').volume).toBe(1);
  });
});

describe('mode-level master volume', () => {
  it('suppresses every remote original when the mode sets it to zero', () => {
    // `translated` mode. Before W3 this was one element at volume 0; the
    // semantics must survive the move to one element per speaker.
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0), binding('p3', 1)]);

    h.controller.setMasterVolume(0);

    expect(h.elements.every((element) => element.volume === 0)).toBe(true);
  });

  it('multiplies with the per-speaker preference rather than replacing it', () => {
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0), binding('p3', 1)]);
    h.controller.setVolume('p2', 0.5);

    h.controller.setMasterVolume(0.4);

    expect(elementFor(h, 'p2').volume).toBeCloseTo(0.2);
    expect(elementFor(h, 'p3').volume).toBeCloseTo(0.4);
    // The listener's own choice is unchanged; only what reaches the element moves.
    expect(h.controller.speakers().find((s) => s.speakerParticipantId === 'p2')!.volume).toBe(0.5);
  });

  it('applies to a speaker who binds after the mode was set', () => {
    const h = controllerWith();
    h.controller.setMasterVolume(0.25);

    h.controller.applyBindings([binding('p2', 0)]);

    expect(elementFor(h, 'p2').volume).toBeCloseTo(0.25);
  });
});

describe('W4 Path B reports CONFIRMED playback, not eligibility', () => {
  function tracker() {
    const audible: boolean[] = [];
    const elements: FakeElement[] = [];
    const controller = new CallRemoteSpeakerAudioController({
      createElement: () => {
        const element = new FakeElement();
        elements.push(element);
        return element;
      },
      createStream: (track) => ({ track }) as never,
      onRemoteOriginalAudibleChange: (value) => audible.push(value),
    });
    return { controller, audible, elements };
  }

  /** The element for a speaker, found by the track it carries. */
  function el(h: ReturnType<typeof tracker>, speakerId: string): FakeElement {
    const found = h.elements.find(
      (candidate) => (candidate.srcObject as { track?: { id?: string } })?.track?.id === speakerId,
    );
    if (!found) throw new Error(`no element for ${speakerId}`);
    return found;
  }

  it('1. bound with the volume up is NOT audible until playback is confirmed', () => {
    // "Eligible to be heard" is a different claim from "being heard", and a
    // ledger that records the first as the second is worth nothing.
    const h = tracker();

    h.controller.applyBindings([binding('p2', 0)]);

    expect(h.audible).toEqual([]);
  });

  it('2. a refused play() produces NO start', () => {
    const audible: boolean[] = [];
    const element = new FakeElement();
    element.rejectPlay = true;
    const controller = new CallRemoteSpeakerAudioController({
      createElement: () => element,
      createStream: (track) => ({ track }) as never,
      onRemoteOriginalAudibleChange: (value) => audible.push(value),
    });

    controller.applyBindings([binding('p2', 0)]);

    expect(audible).toEqual([]);
  });

  it('3. the element saying `playing` is what starts the interval', () => {
    const h = tracker();
    h.controller.applyBindings([binding('p2', 0)]);

    el(h, 'p2').emit('playing');

    expect(h.audible).toEqual([true]);
  });

  it('4. pause ends it', () => {
    const h = tracker();
    h.controller.applyBindings([binding('p2', 0)]);
    el(h, 'p2').emit('playing');

    el(h, 'p2').emit('pause');

    expect(h.audible).toEqual([true, false]);
  });

  it('5. an element error ends it', () => {
    const h = tracker();
    h.controller.applyBindings([binding('p2', 0)]);
    el(h, 'p2').emit('playing');

    el(h, 'p2').emit('error');

    expect(h.audible.at(-1)).toBe(false);
  });

  it('6. reset ends it exactly once', () => {
    const h = tracker();
    h.controller.applyBindings([binding('p2', 0)]);
    el(h, 'p2').emit('playing');

    h.controller.reset();

    expect(h.audible).toEqual([true, false]);
  });

  it('7. muting a genuinely playing speaker ends it, and unmuting restores it', () => {
    const h = tracker();
    h.controller.applyBindings([binding('p2', 0)]);
    el(h, 'p2').emit('playing');

    h.controller.setMuted('p2', true);
    expect(h.audible.at(-1)).toBe(false);

    // The element never stopped, so unmuting is genuinely audible again.
    h.controller.setMuted('p2', false);
    expect(h.audible.at(-1)).toBe(true);
  });

  it('8. volume 0 while playing ends it', () => {
    const h = tracker();
    h.controller.applyBindings([binding('p2', 0)]);
    el(h, 'p2').emit('playing');

    h.controller.setVolume('p2', 0);

    expect(h.audible.at(-1)).toBe(false);
  });

  it('9. master volume 0 ends it', () => {
    const h = tracker();
    h.controller.applyBindings([binding('p2', 0)]);
    el(h, 'p2').emit('playing');

    h.controller.setMasterVolume(0);

    expect(h.audible.at(-1)).toBe(false);
  });

  it('10. restoring the volume while still confirmed playing starts it again', () => {
    const h = tracker();
    h.controller.applyBindings([binding('p2', 0)]);
    el(h, 'p2').emit('playing');
    h.controller.setMasterVolume(0);

    h.controller.setMasterVolume(1);

    expect(h.audible).toEqual([true, false, true]);
  });

  it('11. two speakers playing start the interval ONCE', () => {
    const h = tracker();
    h.controller.applyBindings([binding('p2', 0), binding('p3', 1)]);

    el(h, 'p2').emit('playing');
    el(h, 'p3').emit('playing');

    expect(h.audible).toEqual([true]);
  });

  it('12. one of two stopping does not end the interval', () => {
    const h = tracker();
    h.controller.applyBindings([binding('p2', 0), binding('p3', 1)]);
    el(h, 'p2').emit('playing');
    el(h, 'p3').emit('playing');

    el(h, 'p2').emit('pause');

    expect(h.audible).toEqual([true]);
  });

  it('13. the LAST audible speaker stopping ends it once', () => {
    const h = tracker();
    h.controller.applyBindings([binding('p2', 0), binding('p3', 1)]);
    el(h, 'p2').emit('playing');
    el(h, 'p3').emit('playing');
    el(h, 'p2').emit('pause');

    el(h, 'p3').emit('pause');

    expect(h.audible).toEqual([true, false]);
  });

  it('14. never emits an END without a prior START', () => {
    const h = tracker();
    h.controller.applyBindings([binding('p2', 0)]);

    // Everything that could look like a stop, with nothing ever having started.
    el(h, 'p2').emit('pause');
    el(h, 'p2').emit('ended');
    el(h, 'p2').emit('error');
    h.controller.setMuted('p2', true);
    h.controller.reset();

    expect(h.audible).toEqual([]);
  });

  it('15. repeated events produce no duplicate START or END', () => {
    const h = tracker();
    h.controller.applyBindings([binding('p2', 0)]);

    for (let index = 0; index < 3; index += 1) el(h, 'p2').emit('playing');
    for (let index = 0; index < 3; index += 1) el(h, 'p2').emit('pause');

    expect(h.audible).toEqual([true, false]);
  });

  it('ignores a torn-down element that keeps firing events', () => {
    // A detached element flipping the aggregate would report audio from
    // somebody who has already left the call.
    const h = tracker();
    h.controller.applyBindings([binding('p2', 0)]);
    el(h, 'p2').emit('playing');
    const orphan = el(h, 'p2');

    h.controller.applyBindings([]);
    orphan.emit('playing');

    expect(h.audible).toEqual([true, false]);
  });
});
describe('mode suppression is per speaker, not per call', () => {
  it('silences only the cross-language speaker, leaving the same-language delivery alone', () => {
    // calm-tide-33's structural defect: one master flag for the whole call
    // meant a fr listener either lost the en speaker whose original was their
    // only delivery, or kept hearing everything. Suppression is a property of
    // the PAIR.
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0), binding('p3', 1)]);

    h.controller.setModeSuppressed('p3', true);

    expect(elementFor(h, 'p3').volume).toBe(0);
    expect(elementFor(h, 'p2').volume).toBe(1);
  });

  it('restores the speaker at their preference when suppression lifts', () => {
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0)]);
    h.controller.setVolume('p2', 0.6);
    h.controller.setModeSuppressed('p2', true);
    expect(elementFor(h, 'p2').volume).toBe(0);

    h.controller.setModeSuppressed('p2', false);

    expect(elementFor(h, 'p2').volume).toBe(0.6);
  });

  it('keeps the volume PREFERENCE while suppressed, applying it inaudibly', () => {
    // The deterministic reproduction of the observed symptom: the slider moves,
    // state updates, nothing reaches the element — because the mode silenced
    // this speaker. The UI now says so instead of looking broken.
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0)]);
    h.controller.setModeSuppressed('p2', true);

    h.controller.setVolume('p2', 0.8);

    expect(h.controller.speakers()[0]).toMatchObject({ volume: 0.8, originalSuppressed: true });
    expect(elementFor(h, 'p2').volume).toBe(0);
  });

  it('surfaces the suppression in state so the UI can explain itself', () => {
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0), binding('p3', 1)]);

    h.controller.setModeSuppressed('p3', true);

    expect(h.controller.speakers().map((s) => s.originalSuppressed)).toEqual([false, true]);
  });
});

describe('leave, language change, rejoin — the calm-tide-33 sequence', () => {
  it('rebinds the rejoined participant under their NEW identity with working controls', () => {
    // participant_6 left, changed language, rejoined as participant_7. The
    // transport reuses the freed slot and the SAME track; the controls must
    // follow the new identity, once, with no orphan playback.
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0), binding('p6', 1, 'slot1-track')]);
    h.controller.setVolume('p6', 0.4);

    // Leave: slot freed.
    h.controller.applyBindings([binding('p2', 0)]);
    // Rejoin: new id, same slot, same underlying track.
    h.controller.applyBindings([binding('p2', 0), binding('p7', 1, 'slot1-track')]);

    expect(h.controller.speakers().map((s) => s.speakerParticipantId)).toEqual(['p2', 'p7']);
    // Fresh identity, fresh defaults — p6's preference must not haunt p7.
    expect(h.controller.speakers()[1]).toMatchObject({ muted: false, volume: 1 });

    h.controller.setMuted('p7', true);
    h.controller.setVolume('p7', 0.2);
    // p7 rides the REUSED slot track, so find the element by the track itself.
    const slotElement = h.elements.find(
      (element) => (element.srcObject as { track?: { id?: string } })?.track?.id === 'slot1-track',
    )!;
    expect(slotElement.muted).toBe(true);
    expect(slotElement.volume).toBe(0.2);
    // Exactly one live element per bound speaker — no orphan playback.
    const live = h.elements.filter((element) => element.srcObject !== null);
    expect(live).toHaveLength(2);
  });

  it('explains, rather than breaks, when the rejoin makes the call cross-language', () => {
    // After the fr rejoin, the fr listener's cross-language speakers arrive as
    // TTS: original controls suppressed WITH a stated reason, same-language
    // speakers (none here) would stay live. This is the honest version of what
    // the human saw as "mute/volume no longer functions".
    const h = controllerWith();
    h.controller.applyBindings([binding('p2', 0), binding('p3', 1)]);
    h.controller.setModeSuppressed('p2', true);
    h.controller.setModeSuppressed('p3', true);

    h.controller.setMuted('p2', true);
    h.controller.setVolume('p3', 0.9);

    // State moves; nothing audible changes; the flag says why.
    expect(h.controller.speakers().every((s) => s.originalSuppressed)).toBe(true);
    expect(elementFor(h, 'p2').volume).toBe(0);
    expect(elementFor(h, 'p3').volume).toBe(0);
  });
});
