/** @author masterzee001 */
/**
 * THE CALL SCREEN, RENDERED AND DRIVEN -- the seams a pure model cannot reach.
 *
 * WHAT THIS REPLACES. There was a file here that asserted SOURCE TEXT: it
 * checked that `CallScreen.tsx` contained `onCaption: (event...` and four other
 * strings, and its own header admitted this was "the weakest kind of test in
 * this repository". A reviewer then severed the caption seam with ONE line --
 * `if (live) return;` inside the handler, every asserted string left
 * byte-identical -- and the suite stayed green. Twenty-two of twenty-six
 * mutants planted in the screen, its components and its styles survived the
 * same way.
 *
 * So the screen is now MOUNTED, with the socket-side object mocked at the
 * module boundary, and driven the way the gateway drives it: a telephone state,
 * a caption, a translated-audio diagnostic, a remote stream. Every assertion
 * below is about what a person would see, hear read aloud, or be able to press.
 *
 * WHAT IS MOCKED AND WHY. `CallConnection` (it opens a socket), `videofyCall`
 * and `reportRingTimeline` (native module and a POST), `expo-audio` and
 * `react-native-webrtc` (native). `react-native` itself is aliased to a stub of
 * host component names in vitest.config.ts. Nothing about the SCREEN is mocked.
 */
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallCaptionEvent, DirectCallStateSnapshot } from '@videofy-live/call-client-core';
import {
  nodesOfType,
  nodesWhere,
  styleOf,
  textOf,
  textsOf,
  treeOf,
  type TreeNode,
} from './stubs/render';

/** The options the screen handed the connection, captured at construction. */
const held = vi.hoisted(() => ({
  options: null as Record<string, (...args: never[]) => unknown> | null,
  ended: 0,
}));

vi.mock('../call/callConnection', () => ({
  CallConnection: class {
    constructor(options: Record<string, (...args: never[]) => unknown>) {
      held.options = options;
    }
    async openLocalMedia(): Promise<void> {}
    async join(): Promise<{ ok: true }> {
      return { ok: true };
    }
    reportRingResult(): void {}
    leave(): void {}
    async end(): Promise<boolean> {
      held.ended += 1;
      return true;
    }
    async setCameraEnabled(): Promise<null> {
      return null;
    }
    setMicrophoneEnabled(): void {}
  },
}));

vi.mock('../native/videofyCall', () => ({
  videofyCall: {
    available: false,
    reportOutgoingCall: () => false,
    reportMediaConnected: () => {},
    setAudioRoute: () => false,
    timeline: () => ({}),
  },
}));
vi.mock('../call/ringTimeline', () => ({ reportRingTimeline: async () => {} }));
vi.mock('expo-audio', () => ({ setAudioModeAsync: async () => {} }));
vi.mock('react-native-webrtc', () => ({ RTCView: 'RTCView' }));

const { create } = await import('react-test-renderer');
const { CallScreen } = await import('../screens/CallScreen');

const PEER = { accountId: 'peer-1', name: 'Tunde' };

function directState(over: Partial<DirectCallStateSnapshot> = {}): DirectCallStateSnapshot {
  const now = Date.now();
  return {
    callId: 'call-1',
    state: 'connected',
    mode: 'translated',
    callerAccountId: 'me',
    peerAccountId: PEER.accountId,
    callerName: 'Zoe',
    updatedAtMs: now,
    expiresAtMs: 0,
    answeredAtMs: now - 291_000,
    connectedAtMs: now - 291_000,
    endedByAccountId: null,
    ...over,
  };
}

function caption(over: Partial<CallCaptionEvent> = {}): CallCaptionEvent {
  return {
    callId: 'call-1',
    speakerParticipantId: 'seat-peer',
    speakerDisplayName: 'Tunde',
    sourceLanguage: 'yo',
    targetLanguage: 'en',
    originalText: 'Bawo ni, se daadaa ni?',
    translatedText: 'Hello, how are you?',
    sequence: 1,
    mediaRevision: 1,
    languageRevision: 1,
    startMs: 0,
    endMs: 900,
    isFinal: true,
    ...over,
  };
}

interface Mounted {
  tree(): TreeNode;
  texts(): string[];
  readonly onLeave: ReturnType<typeof vi.fn>;
  fire(name: string, ...args: unknown[]): Promise<void>;
  press(label: string): Promise<void>;
  unmount(): Promise<void>;
}

async function mount(
  props: {
    readonly onCallBack?: (() => void) | undefined;
    readonly onMessagePeer?: (() => void) | undefined;
    readonly onRing?: ((callId: string) => Promise<number | null>) | undefined;
  } = {},
): Promise<Mounted> {
  const onLeave = vi.fn();
  let renderer: ReturnType<typeof create> | null = null;
  await act(async () => {
    renderer = create(
      <CallScreen
        call={{ kind: 'direct', callId: 'call-1', peer: PEER }}
        displayName="Zoe"
        sessionToken="session"
        onRing={props.onRing ?? (async () => 1)}
        onLeave={onLeave}
        onCallBack={props.onCallBack}
        onMessagePeer={props.onMessagePeer}
      />,
    );
  });
  // The join runs as a promise chain off the mount effect; one more turn of
  // the loop inside `act` lets it settle before anything is asserted.
  await act(async () => {
    await Promise.resolve();
  });
  const made = renderer as unknown as ReturnType<typeof create>;
  const tree = (): TreeNode => treeOf(made);
  return {
    tree,
    texts: () => textsOf(tree()),
    onLeave,
    async fire(name: string, ...args: unknown[]): Promise<void> {
      const handler = held.options?.[name];
      if (handler === undefined) throw new Error(`the screen never subscribed to ${name}`);
      await act(async () => {
        (handler as (...rest: unknown[]) => unknown)(...args);
      });
    },
    async press(label: string): Promise<void> {
      const control = nodesWhere(tree(), (node) => node.props['accessibilityLabel'] === label)[0];
      if (control === undefined) throw new Error(`no control labelled ${label}`);
      const onPress = control.props['onPress'] as (() => void) | undefined;
      if (onPress === undefined) throw new Error(`${label} cannot be pressed`);
      await act(async () => {
        onPress();
      });
    },
    async unmount(): Promise<void> {
      // The teardown releases the camera, the router and the seat, and those
      // are state changes like any other.
      await act(async () => {
        made.unmount();
      });
    },
  };
}

/** Everything a screen reader would be offered, in order. */
const labels = (tree: TreeNode): string[] =>
  nodesWhere(tree, (node) => typeof node.props['accessibilityLabel'] === 'string').map(
    (node) => node.props['accessibilityLabel'] as string,
  );

beforeEach(() => {
  held.options = null;
  held.ended = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the seams: the screen is plugged into the decisions, and stays plugged in', () => {
  it('shows a caption that arrives on the socket', async () => {
    /*
     * The mutant this exists for: `stamp('caption_received'); if (live) return;`
     * inside the handler. Every source-text assertion the old test made still
     * passed; the caption never reached the screen.
     */
    const call = await mount();
    await call.fire('onDirectState', directState());
    expect(call.texts()).not.toContain('Bawo ni, se daadaa ni?');
    await call.fire('onCaption', caption(), { self: false });
    const texts = call.texts();
    expect(texts).toContain('Bawo ni, se daadaa ni?');
    expect(texts).toContain('Hello, how are you?');
    expect(texts).toContain('TRANSLATION · ENGLISH');
    await call.unmount();
  });

  it('asks the shared merge what to show, rather than taking whatever arrives', async () => {
    /*
     * A straggler -- an earlier sequence from the same speaker at the same
     * media revision -- must not replace the utterance on screen. The slot took
     * whatever arrived once, and a stuck stream could then re-paint the card
     * with an older sentence.
     */
    const call = await mount();
    await call.fire('onDirectState', directState());
    await call.fire(
      'onCaption',
      caption({ sequence: 4, originalText: 'Mo wa nibi', translatedText: 'I am here' }),
      { self: false },
    );
    await call.fire('onCaption', caption({ sequence: 2 }), { self: false });
    expect(call.texts()).toContain('Mo wa nibi');
    expect(call.texts()).not.toContain('Bawo ni, se daadaa ni?');
    await call.unmount();
  });

  it('folds a REFUSED diagnostic into what the screen says', async () => {
    // The other severed seam: the diagnostics no longer folded into the
    // signals, so refusals and the audible proof were lost again.
    const call = await mount();
    await call.fire('onDirectState', directState());
    await call.fire('onTranslatedAudio', { kind: 'listening' });
    expect(call.texts()).toContain('Listening for translated speech');
    await call.fire('onTranslatedAudio', { kind: 'refused', reason: 'language-not-mine' });
    expect(call.texts()).toContain('Translated speech is arriving but this phone is not playing it');
    await call.unmount();
  });

  it('repeats what the GATEWAY said about its own engine', async () => {
    const call = await mount();
    await call.fire('onDirectState', directState());
    await call.fire('onTranslationEngine');
    expect(call.texts()).toContain('This server cannot translate — you will hear original voices');
    await call.unmount();
  });
});

describe('a caption is not proof of audio, on the screen itself', () => {
  it('keeps warning about refusals through a stream of perfect captions', async () => {
    /*
     * THE HEADLINE DEFECT, end to end. A translated call whose captions arrive
     * normally and whose audio frames are all turned away: the caption used to
     * be promoted to proof, silencing this warning permanently and certifying
     * the ended screen as "· translated". The person heard original voices for
     * the whole call.
     */
    const call = await mount();
    await call.fire('onDirectState', directState());
    await call.fire('onLanguages', { from: 'yo', to: 'en' });
    await call.fire('onTranslatedAudio', { kind: 'listening' });
    await call.fire('onCaption', caption(), { self: false });
    await call.fire('onTranslatedAudio', { kind: 'refused', reason: 'language-not-mine' });
    expect(call.texts()).toContain('Translated speech is arriving but this phone is not playing it');
    expect(call.texts()).not.toContain('Playing translated speech');

    await call.fire('onDirectState', directState({ state: 'ended' }));
    const ended = call.texts();
    expect(ended.some((text) => text.endsWith('· translated'))).toBe(false);
    expect(ended.some((text) => text.endsWith('· not translated'))).toBe(true);
    // And the warning is still there beside the verdict, not removed one frame
    // before the line that would have contradicted it.
    expect(ended).toContain('Translated speech is arriving but this phone is not playing it');
    await call.unmount();
  });

  it('says that text is arriving when that is all that is', async () => {
    const call = await mount();
    await call.fire('onDirectState', directState());
    await call.fire('onTranslatedAudio', { kind: 'listening' });
    await call.fire('onCaption', caption(), { self: false });
    expect(call.texts()).toContain('Translated text is arriving');
    expect(call.texts()).not.toContain('Playing translated speech');
    await call.fire('onDirectState', directState({ state: 'ended' }));
    expect(call.texts().some((text) => text.endsWith('· translated text only'))).toBe(true);
    await call.unmount();
  });

  it('says somebody is hearing it only while frames are actually playing', async () => {
    const call = await mount();
    await call.fire('onDirectState', directState());
    await call.fire('onTranslatedAudio', { kind: 'listening' });
    await call.fire('onTranslatedAudio', { kind: 'played', playedMs: 20 });
    expect(call.texts()).toContain('Playing translated speech');
    await call.fire('onDirectState', directState({ state: 'ended' }));
    expect(call.texts().some((text) => text.endsWith('· translated'))).toBe(true);
    await call.unmount();
  });
});

describe('the ended screen waits for the person', () => {
  it('does not delete itself while Call back and Message are on it', async () => {
    /*
     * `setTimeout(() => onLeave(), 2500)` on the terminal state, unchanged from
     * the commit that built these two buttons: they appeared and vanished
     * before a hand could reach them, and the summary card could not be read.
     */
    vi.useFakeTimers();
    const called: string[] = [];
    const call = await mount({
      onCallBack: () => called.push('call-back'),
      onMessagePeer: () => called.push('message'),
    });
    await call.fire('onDirectState', directState());
    await call.fire('onDirectState', directState({ state: 'ended' }));
    expect(call.texts()).toContain('Call ended');
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(call.onLeave).not.toHaveBeenCalled();
    expect(call.texts()).toContain('Call ended');
    expect(labels(call.tree())).toEqual(expect.arrayContaining(['Call back', 'Message', 'Close']));
    // And they still do what they were built to do.
    await call.press('Call back');
    await call.press('Message');
    expect(called).toEqual(['call-back', 'message']);
    // The person dismisses it.
    await call.press('Close');
    expect(call.onLeave).toHaveBeenCalled();
    await call.unmount();
  });

  it('leaves on its own only when there is nothing to act on', async () => {
    vi.useFakeTimers();
    const call = await mount();
    await call.fire('onDirectState', directState({ state: 'no_answer', connectedAtMs: null }));
    expect(call.onLeave).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(2_600);
    });
    expect(call.onLeave).toHaveBeenCalled();
    await call.unmount();
  });

  it('does not throw away the ended screen 600 ms after End is pressed', async () => {
    vi.useFakeTimers();
    const call = await mount({ onCallBack: () => {}, onMessagePeer: () => {} });
    await call.fire('onDirectState', directState());
    await call.press('End call');
    expect(held.ended).toBe(1);
    // The server answers the request: this is now a screen with buttons on it.
    await call.fire('onDirectState', directState({ state: 'ended' }));
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(call.onLeave).not.toHaveBeenCalled();
    await call.unmount();
  });

  it('still leaves when the End request settles and the telephone never answers', async () => {
    // A lost acknowledgement must never hold somebody on a call screen.
    vi.useFakeTimers();
    const call = await mount({ onCallBack: () => {} });
    await call.fire('onDirectState', directState());
    await call.press('End call');
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(call.onLeave).toHaveBeenCalled();
    await call.unmount();
  });
});

describe('the caption card has space of its own, above the dock', () => {
  it('is drawn OUTSIDE the scrolling identity column', async () => {
    /*
     * Computed from the styles as written, a reviewer found the card started
     * 17dp below the bottom of a 360x800 screen: at rest not one pixel of it
     * showed, and the ScrollView had turned "clipped" into "invisible unless
     * you scroll a live call by hand".
     */
    const call = await mount();
    await call.fire('onDirectState', directState());
    await call.fire('onCaption', caption(), { self: false });
    const tree = call.tree();
    const column = nodesOfType(tree, 'ScrollView')[0]!;
    expect(textsOf(column)).toContain('Tunde');
    expect(textsOf(column)).not.toContain('Bawo ni, se daadaa ni?');
    // It sits in a slot with a bounded height and a scroll of its own.
    const slot = nodesWhere(
      tree,
      (node) => typeof styleOf(node)['maxHeight'] === 'number' && textsOf(node).includes('Bawo ni, se daadaa ni?'),
    )[0];
    expect(slot).toBeDefined();
    expect(Number(styleOf(slot!)['maxHeight'])).toBeLessThanOrEqual(240);
    expect(nodesOfType(slot!, 'ScrollView')).toHaveLength(1);
    // And the slot is the thing that does NOT give way: with `flexShrink: 1`
    // the column would win the argument again and the card would be squeezed.
    expect(styleOf(slot!)['flexShrink']).toBe(0);
    await call.unmount();
  });

  it('makes the face and the clock yield to it, and gives them back afterwards', async () => {
    /** The halo's own box is the avatar's size plus its two rings. */
    const haloWidth = (): number => {
      const halo = nodesWhere(call.tree(), (node) => {
        const style = styleOf(node);
        return (
          typeof style['width'] === 'number' &&
          style['width'] === style['height'] &&
          style['alignItems'] === 'center' &&
          style['justifyContent'] === 'center'
        );
      }).map((node) => Number(styleOf(node)['width']));
      // The biggest centred square on the screen is the halo; the small one is
      // the C7 mark's ring.
      expect(halo.length).toBeGreaterThan(0);
      return Math.max(...halo);
    };
    const clockSize = (): number => {
      const clock = nodesWhere(call.tree(), (node) => /^\d\d:\d\d$/u.test(textOf(node)))[0];
      return Number(styleOf(clock!)['fontSize']);
    };
    const call = await mount();
    await call.fire('onDirectState', directState());
    const wholeFace = haloWidth();
    const wholeClock = clockSize();
    await call.fire('onCaption', caption(), { self: false });
    expect(haloWidth()).toBeLessThan(wholeFace);
    expect(clockSize()).toBeLessThan(wholeClock);
    // Hidden card, no reason to compress: the face and the clock come back.
    await call.press('Hide captions');
    expect(haloWidth()).toBe(wholeFace);
    expect(clockSize()).toBe(wholeClock);
    await call.unmount();
  });

  it('goes away when the person hides it, and the control says which way it goes', async () => {
    const call = await mount();
    await call.fire('onDirectState', directState());
    await call.fire('onCaption', caption(), { self: false });
    expect(call.texts()).toContain('Bawo ni, se daadaa ni?');
    await call.press('Hide captions');
    expect(call.texts()).not.toContain('Bawo ni, se daadaa ni?');
    expect(labels(call.tree())).toContain('Show captions');
    // Hiding the card never hides a fault.
    await call.fire('onTranslationEngine');
    expect(call.texts()).toContain('This server cannot translate — you will hear original voices');
    await call.unmount();
  });
});

describe('the dock is one row that fits a 360dp phone', () => {
  it('draws five icon-only controls, each still named for a screen reader', async () => {
    const call = await mount();
    await call.fire('onDirectState', directState());
    await call.fire('onCaption', caption(), { self: false });
    const tree = call.tree();
    const pressables = nodesOfType(tree, 'Pressable');
    const dockLabels = pressables.map((node) => node.props['accessibilityLabel']);
    expect(dockLabels).toEqual(['Mute', 'Speaker', 'Camera off', 'Hide captions', 'End call']);
    // The words are not DRAWN -- five labelled controls need 458dp.
    const texts = call.texts();
    for (const label of ['Mute', 'Speaker', 'Camera off', 'Hide captions']) {
      expect(texts).not.toContain(label);
    }
    await call.unmount();
  });

  it('gives the caption control a SUBTITLES glyph, not the translate one', async () => {
    /*
     * A teal translate glyph that went dark when pressed told people they had
     * turned the translation off. They had hidden a card: this client has never
     * sent `call:mode:set` and cannot turn translation off. The subtitle box is
     * a Rect; the translate glyph is two Paths and no Rect.
     */
    const call = await mount();
    await call.fire('onDirectState', directState());
    await call.fire('onCaption', caption(), { self: false });
    const control = nodesWhere(
      call.tree(),
      (node) => node.props['accessibilityLabel'] === 'Hide captions',
    )[0]!;
    const box = nodesOfType(control, 'Rect');
    expect(box).toHaveLength(1);
    // The subtitle frame, wider than it is tall, with the lines of text inside.
    expect(Number(box[0]?.props['width'])).toBeGreaterThan(Number(box[0]?.props['height']));
    await call.unmount();
  });

  it('measures, from the styles as rendered, under 360dp', async () => {
    /*
     * The arithmetic that was wrong: five children pinned to minWidth 72 plus
     * gaps and padding needed 458dp, so the row wrapped to two and the dock
     * took a third of the screen -- which is where the caption card's space
     * went. Every figure below is read off the rendered tree.
     */
    const call = await mount();
    await call.fire('onDirectState', directState());
    await call.fire('onCaption', caption(), { self: false });
    const tree = call.tree();
    const pressables = nodesOfType(tree, 'Pressable');
    const widths = pressables.map((node) => {
      const wrap = styleOf(node);
      const circle = styleOf(nodesOfType(node, 'View')[0]!);
      return Math.max(Number(wrap['minWidth'] ?? 0), Number(circle['width'] ?? 0));
    });
    const row = nodesWhere(tree, (node) => typeof styleOf(node)['columnGap'] === 'number')[0]!;
    const gap = Number(styleOf(row)['columnGap']);
    const dock = nodesWhere(tree, (node) => styleOf(node)['borderRadius'] === 28 && nodesOfType(node, 'Pressable').length === 5)[0]!;
    const dockPadding = Number(styleOf(dock)['paddingHorizontal']) * 2 + 2;
    const wrapNode = nodesWhere(tree, (node) => nodesOfType(node, 'Pressable').length === 5 && typeof styleOf(node)['paddingBottom'] === 'number')[0]!;
    const wrapPadding = Number(styleOf(wrapNode)['paddingHorizontal'] ?? 0) * 2;
    const total =
      widths.reduce((sum, width) => sum + width, 0) +
      gap * (widths.length - 1) +
      dockPadding +
      wrapPadding;
    expect(widths).toHaveLength(5);
    // And every target is at or above the 44dp floor.
    for (const width of widths) expect(width).toBeGreaterThanOrEqual(44);
    expect(total).toBeLessThanOrEqual(360);
    await call.unmount();
  });

  it('offers no live controls on a call that has ended', async () => {
    const call = await mount({ onCallBack: () => {}, onMessagePeer: () => {} });
    await call.fire('onDirectState', directState());
    await call.fire('onDirectState', directState({ state: 'ended' }));
    const dockLabels = nodesOfType(call.tree(), 'Pressable').map(
      (node) => node.props['accessibilityLabel'],
    );
    expect(dockLabels).toEqual(['Call back', 'Message', 'Close']);
    await call.unmount();
  });
});

describe('the ring arc on the placing screen', () => {
  /** How much of the arc is drawn: the first figure of the dash pattern. */
  const arcDrawn = (call: Mounted): number => {
    const arcs = nodesOfType(call.tree(), 'Circle').filter(
      (node) => typeof node.props['strokeDasharray'] === 'string' && node.props['strokeDasharray'] !== '3 9',
    );
    if (arcs.length === 0) return 0;
    return Number(String(arcs[0]?.props['strokeDasharray']).split(' ')[0]);
  };

  it('NEVER GROWS when the server moves the deadline', async () => {
    /*
     * The documented Answer grace. The denominator is frozen at the first
     * window seen, so an extension used to snap the arc from a fifth left back
     * to FULL in one frame and hold it there for six seconds -- which reads as
     * a ring that restarted, then as a display that has stopped measuring.
     */
    vi.useFakeTimers();
    const call = await mount();
    const start = Date.now();
    await call.fire(
      'onDirectState',
      directState({ state: 'ringing', connectedAtMs: null, answeredAtMs: null, expiresAtMs: start + 30_000 }),
    );
    const full = arcDrawn(call);
    expect(full).toBeGreaterThan(0);
    await act(async () => {
      vi.advanceTimersByTime(24_000);
    });
    const nearlyGone = arcDrawn(call);
    expect(nearlyGone).toBeLessThan(full / 2);
    // The grace lands: thirty more seconds, on a window captured as thirty.
    await call.fire(
      'onDirectState',
      directState({
        state: 'ringing',
        connectedAtMs: null,
        answeredAtMs: null,
        expiresAtMs: Date.now() + 30_000,
      }),
    );
    expect(arcDrawn(call)).toBeLessThanOrEqual(nearlyGone + 0.001);
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(arcDrawn(call)).toBeLessThanOrEqual(nearlyGone + 0.001);
    await call.unmount();
  });
});

describe('what the screen says about the kind of call, it says once', () => {
  it('does not print "Direct call" twice through the whole of the ring', async () => {
    /*
     * The C7 mark reads DIRECT CALL and the pill's fallback read "Direct call"
     * -- word for word, 300dp apart, for every outgoing call from the tap until
     * the gateway answers.
     */
    const call = await mount();
    const printed = call.texts().filter((text) => text.toLowerCase() === 'direct call');
    expect(printed).toHaveLength(1);
    await call.unmount();
  });

  it('states the pair without claiming an activity, and drops it when the call ends unproven', async () => {
    const call = await mount();
    await call.fire('onDirectState', directState());
    await call.fire('onLanguages', { from: 'yo', to: 'en' });
    expect(call.texts()).toContain('YO → EN');
    expect(labels(call.tree())).toContain('Yoruba to English');
    expect(labels(call.tree()).some((label) => /translating/iu.test(label))).toBe(false);
    await call.fire('onDirectState', directState({ state: 'ended' }));
    expect(call.texts()).not.toContain('YO → EN');
    await call.unmount();
  });
});

describe('a camera coming on does not take the measured state away', () => {
  it('keeps the translation fault and the ended verdict on a video call', async () => {
    /*
     * The video branch rendered NOTHING from the view model: no readiness
     * warning, no ended verdict, no summary. Every honest-state fix in three
     * rounds was silently bounded to audio-only calls, on a product whose pitch
     * is translated video calling.
     */
    const call = await mount();
    await call.fire('onDirectState', directState());
    await call.fire('onTranslationEngine');
    await call.fire('onRemoteStream', 'seat-peer', { toURL: () => 'stream://peer' });
    const tree = call.tree();
    expect(nodesOfType(tree, 'RTCView')).toHaveLength(1);
    expect(textsOf(tree)).toContain('This server cannot translate — you will hear original voices');
    await call.fire('onDirectState', directState({ state: 'ended' }));
    const ended = call.texts();
    expect(ended.some((text) => text.endsWith('· not translated'))).toBe(true);
    expect(ended).toContain('This server cannot translate — you will hear original voices');
    await call.unmount();
  });

  it('says nothing extra over the video when there is nothing to say', async () => {
    const call = await mount();
    await call.fire('onDirectState', directState({ mode: 'normal' }));
    await call.fire('onRemoteStream', 'seat-peer', { toURL: () => 'stream://peer' });
    const texts = call.texts();
    expect(texts.some((text) => /cannot translate|not playing it|translated/iu.test(text))).toBe(false);
    await call.unmount();
  });
});

describe('the speech bars, whose mouth', () => {
  it('rest grey on the screen itself until the peer is measured speaking', async () => {
    /*
     * `active={true}` at this call site is an indicator that animates through a
     * silent call -- an app telling somebody their call is working while it is
     * not, which this product has already done for one night.
     */
    const call = await mount();
    await call.fire('onDirectState', directState());
    await call.fire('onCaption', caption({ isFinal: true }), { self: false });
    const resting = nodesOfType(call.tree(), 'Animated.View').filter(
      (node) => typeof styleOf(node)['backgroundColor'] === 'string',
    );
    expect(resting.length).toBeGreaterThan(0);
    for (const bar of resting) expect(styleOf(bar)['backgroundColor']).toBe('#5d6874');
    await call.unmount();
  });

  it('rest and say nothing while the caption on screen is this phone’s own', async () => {
    const call = await mount();
    await call.fire('onDirectState', directState());
    await call.fire('onCaption', caption({ isFinal: false }), { self: true });
    expect(labels(call.tree()).some((label) => /Tunde is/u.test(label))).toBe(false);
    // The peer's caption comes back and the attribution returns with it.
    await call.fire('onCaption', caption({ sequence: 2, isFinal: true }), { self: false });
    expect(labels(call.tree())).toContain('Tunde is quiet');
    await call.unmount();
  });
});
