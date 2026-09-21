/** @author masterzee001 */
/**
 * WHAT THE CALL SCREEN SHOWS -- every decision behind it, checked here.
 *
 * The decisions behind this screen were proven a commit ago: the phase, the
 * eyebrow, the readiness sentence, the caption card's contents, the ring arc.
 * Twenty-two mutants died on them. Then ten mutants applied to the WIRING --
 * the place a decision becomes a prop -- survived the same green suite, and two
 * were the exact defects the decisions existed to prevent:
 *
 *   the nested translation card was fed the ORIGINAL sentence again, so
 *   "TRANSLATION · ENGLISH" sat over the Yoruba words. The founder's named
 *   defect, reintroduced at the last inch, suite green.
 *
 *   the translation line's `readiness.words !== null` guard was swapped for
 *   `phase !== 'ended'`, putting "Connecting translation service…" on every
 *   call in the product including normal ones. The September defect that
 *   translationReadiness.ts exists to make impossible, suite green.
 *
 * That is why the wiring moved into `callScreenView`, and this file is where
 * those ten mutants die. The ones that live in the JSX -- a prop dropped, a
 * component swapped, a style deleted -- die next door in callScreenRender and
 * callThemeRender, which RENDER the screen rather than reading its source.
 */
import { describe, expect, it } from 'vitest';
import {
  callScreenView,
  type CallScreenViewInput,
  type DockControlId,
} from '../call/callScreenModel';
import type { CaptionCardModel } from '../call/callCaption';

const CAPTION: CaptionCardModel = {
  id: 'seat-a:1:7',
  speaker: 'Tunde',
  sourceLanguage: 'yo',
  original: 'Bawo ni, se daadaa ni?',
  translation: { language: 'en', text: 'Hello, how are you?' },
  isFinal: true,
};

const NOW = 1_700_000_000_000;

function view(over: Partial<CallScreenViewInput> = {}) {
  const input: CallScreenViewInput = {
    kind: 'direct',
    phase: 'live',
    serverState: 'connected',
    role: 'caller',
    peerName: 'Tunde',
    translation: {
      mode: 'translated',
      engine: null,
      playback: 'listening',
      playedAtMs: null,
      refusedAtMs: null,
      captionedAtMs: null,
      playedCoveredMs: 0,
      refusedCoveredMs: 0,
    },
    languages: { from: 'yo', to: 'en' },
    connectedRow: { show: true, words: 'Connected', warn: false },
    caption: CAPTION,
    captionIsSelf: false,
    speaking: false,
    captionsShown: true,
    elapsedMs: 291_000,
    ringElapsed: null,
    nowMs: NOW,
    // The 360x800 Android phone every layout figure in this app was computed
    // against. Tests that care about another screen say so.
    widthDp: 360,
    heightDp: 800,
    muted: false,
    speakerOn: false,
    cameraOn: false,
    cameraStarting: false,
    canCallBack: true,
    canMessage: true,
    ...over,
  };
  return callScreenView(input);
}

const dockIds = (ids: readonly { readonly id: DockControlId }[]): readonly DockControlId[] =>
  ids.map((control) => control.id);

describe('the nested card holds the TRANSLATION', () => {
  it('puts the translated sentence under the translation label, never the original', () => {
    const card = view().caption;
    expect(card?.translation?.text).toBe('Hello, how are you?');
    expect(card?.translation?.text).not.toBe(CAPTION.original);
    expect(card?.original).toBe(CAPTION.original);
  });

  it('draws no nested card for an utterance that was never translated', () => {
    const card = view({ caption: { ...CAPTION, translation: null } }).caption;
    expect(card?.translation).toBeNull();
    expect(card?.original).toBe(CAPTION.original);
  });

  it('names the languages in WORDS, because the card has a whole line', () => {
    // "TUNDE · PCM" is not a label a Nigerian Pidgin speaker reads as their
    // language. The codes belong in the pill, where space is tight.
    const card = view().caption;
    expect(card?.sourceLabel).toBe('YORUBA');
    expect(card?.translation?.label).toBe('ENGLISH');
    const pidgin = view({
      caption: { ...CAPTION, sourceLanguage: 'pcm', translation: { language: 'ig', text: 'Ndewo' } },
    }).caption;
    expect(pidgin?.sourceLabel).toBe('NIGERIAN PIDGIN');
    expect(pidgin?.translation?.label).toBe('IGBO');
  });

  it('marks a partial as interim, and a settled one as not', () => {
    expect(view({ caption: { ...CAPTION, isFinal: false } }).caption?.interim).toBe(true);
    expect(view().caption?.interim).toBe(false);
  });

  it('is absent when the person hid it, and on every phase but live', () => {
    expect(view({ captionsShown: false }).caption).toBeNull();
    expect(view({ phase: 'placing' }).caption).toBeNull();
    expect(view({ phase: 'ended' }).caption).toBeNull();
    expect(view({ caption: null }).caption).toBeNull();
  });

  it('makes the column yield to the card, and only while the card is there', () => {
    // The card is the point of the screen: with one on, the avatar, the clock
    // and the name are drawn smaller so it fits above the dock without the
    // person scrolling a live call by hand.
    expect(view().compactIdentity).toBe(true);
    expect(view({ caption: null }).compactIdentity).toBe(false);
    expect(view({ captionsShown: false }).compactIdentity).toBe(false);
    expect(view({ phase: 'ended' }).compactIdentity).toBe(false);
  });
});

describe('the translation line says only what was measured', () => {
  it('says NOTHING on a normal call -- the September defect', () => {
    const normal = view({
      translation: {
        mode: 'normal',
        engine: null,
        playback: 'listening',
        playedAtMs: null,
        refusedAtMs: null,
        captionedAtMs: null,
        playedCoveredMs: 0,
        refusedCoveredMs: 0,
      },
      phase: 'placing',
    });
    expect(normal.readinessLine).toBeNull();
  });

  it('says nothing before the telephone has stated a mode', () => {
    expect(
      view({
        phase: 'placing',
        translation: {
          mode: null,
          engine: null,
          playback: null,
          playedAtMs: null,
          refusedAtMs: null,
          captionedAtMs: null,
          playedCoveredMs: 0,
          refusedCoveredMs: 0,
        },
      }).readinessLine,
    ).toBeNull();
  });

  it('survives onto the ENDED screen when it is a fault', () => {
    /*
     * It was gated `phase !== 'ended'`, which removed the one sentence that
     * contradicted the ended line exactly one frame before that line appeared.
     * A verdict about the whole call is not placing-phase decoration.
     */
    const ended = view({
      phase: 'ended',
      serverState: 'ended',
      translation: {
        mode: 'translated',
        engine: false,
        playback: 'listening',
        playedAtMs: null,
        refusedAtMs: null,
        captionedAtMs: null,
        playedCoveredMs: 0,
        refusedCoveredMs: 0,
      },
    });
    expect(ended.readinessLine?.warn).toBe(true);
    expect(ended.readinessLine?.words).toMatch(/server cannot translate/iu);
  });

  it('does not carry a merely hopeful line onto the ended screen', () => {
    const ended = view({
      phase: 'ended',
      serverState: 'ended',
      translation: {
        mode: 'translated',
        engine: null,
        playback: null,
        playedAtMs: null,
        refusedAtMs: null,
        captionedAtMs: null,
        playedCoveredMs: 0,
        refusedCoveredMs: 0,
      },
    });
    expect(ended.readinessLine).toBeNull();
  });
});

describe('the ended screen cannot certify what the phone measured as untranslated', () => {
  const endedWith = (over: Partial<CallScreenViewInput['translation']>) =>
    view({
      phase: 'ended',
      serverState: 'ended',
      connectedRow: { show: false, words: '', warn: false },
      translation: {
        mode: 'translated',
        engine: null,
        playback: 'listening',
        playedAtMs: null,
        refusedAtMs: null,
        captionedAtMs: null,
        playedCoveredMs: 0,
        refusedCoveredMs: 0,
        ...over,
      },
    });

  it('says "not translated" when the gateway said it has no engine', () => {
    const ended = endedWith({ engine: false });
    expect(ended.endedLine).toBe('4 min 51 s · not translated');
    // And the card does not quietly restate the pair as though it had been used.
    expect(ended.summary?.rows).toEqual([
      { label: 'Duration', value: '4 min 51 s' },
      { label: 'Translation', value: 'Not available' },
    ]);
  });

  it('says "not translated" when THIS phone could not play it', () => {
    expect(endedWith({ playback: 'unavailable' }).endedLine).toBe('4 min 51 s · not translated');
  });

  it('says "translated" once audio covered MOST of the call', () => {
    const ended = endedWith({ playedAtMs: NOW - 5_000, playedCoveredMs: 280_000 });
    expect(ended.endedLine).toBe('4 min 51 s · translated');
    expect(ended.summary?.rows).toEqual([
      { label: 'Duration', value: '4 min 51 s' },
      { label: 'Languages', value: 'Yoruba → English' },
    ]);
  });

  it('WILL NOT say "translated" on the strength of one frame in 291 seconds', () => {
    /*
     * The headline inversion of the round before this one. `playedAtMs` was
     * enough on its own, so a frame at second three ended "4 min 51 s ·
     * translated" with the language pair printed as a fact -- and the pill, the
     * Languages row and the silent readiness line all agreed with it.
     */
    const ended = endedWith({ playedAtMs: NOW - 288_000, playedCoveredMs: 4_000 });
    expect(ended.endedLine).toBe('4 min 51 s · translated for about 1% of the call');
    expect(ended.summary?.rows).toEqual([
      { label: 'Duration', value: '4 min 51 s' },
      { label: 'Translation', value: 'Audio for about 1% of the call' },
    ]);
    // And nothing else on the screen says the flattering thing either.
    expect(ended.pill).toBeNull();
  });

  it('will NOT say "translated" for a call that only ever produced text', () => {
    /*
     * The headline defect of this round. A translated caption arrives within a
     * sentence of every working translated call, so this state is reached on
     * the exact call the 19 Sep post-mortem is about: text fine, audio dead.
     */
    const ended = endedWith({ captionedAtMs: NOW - 5_000 });
    expect(ended.endedLine).toBe('4 min 51 s · translated text only');
    expect(ended.endedLine).not.toBe('4 min 51 s · translated');
    expect(ended.summary?.rows).toEqual([
      { label: 'Duration', value: '4 min 51 s' },
      { label: 'Translation', value: 'Text only — no audio played' },
    ]);
  });

  it('says it stopped when it played and then every frame was refused, and how much played', () => {
    const ended = endedWith({
      playedAtMs: NOW - 200_000,
      playedCoveredMs: 91_000,
      refusedAtMs: NOW - 5_000,
      refusedCoveredMs: 195_000,
    });
    expect(ended.endedLine).toBe('4 min 51 s · translated for about 31% of the call, then stopped');
    expect(ended.summary?.rows).toEqual([
      { label: 'Duration', value: '4 min 51 s' },
      { label: 'Translation', value: 'Audio for about 31% of the call, then stopped' },
    ]);
  });

  it('claims nothing about translation when nothing was measured either way', () => {
    const ended = endedWith({});
    expect(ended.endedLine).toBe('4 min 51 s');
    expect(ended.summary?.rows).toEqual([{ label: 'Duration', value: '4 min 51 s' }]);
  });

  it('says "original voices" for a normal call, which is what it was', () => {
    expect(endedWith({ mode: 'normal' }).endedLine).toBe('4 min 51 s · original voices');
  });

  it('does not print "Call ended" twice under an eyebrow that already says it', () => {
    const ended = endedWith({});
    expect(ended.eyebrow).toBe('Call ended');
    expect(ended.stateLine).toBeNull();
    // A state with its own words still says them.
    const declined = view({
      phase: 'ended',
      serverState: 'declined',
      connectedRow: { show: false, words: '', warn: false },
    });
    expect(declined.stateLine).not.toBeNull();
    expect(declined.stateLine).not.toBe(declined.eyebrow);
  });

  it('writes no summary of a call that never ran', () => {
    /*
     * Gated on the phase alone, a call nobody answered got a card headed "Call
     * summary" whose single row was a translation verdict about a call that did
     * not happen -- which a caller reads as "it ran and the translation broke".
     */
    const unanswered = view({
      phase: 'ended',
      serverState: 'no_answer',
      elapsedMs: null,
      connectedRow: { show: false, words: '', warn: false },
      translation: {
        mode: 'translated',
        engine: false,
        playback: null,
        playedAtMs: null,
        refusedAtMs: null,
        captionedAtMs: null,
        playedCoveredMs: 0,
        refusedCoveredMs: 0,
      },
    });
    expect(unanswered.summary).toBeNull();
    expect(unanswered.endedLine).toBeNull();
  });
});

describe('the speech indicator names the right mouth, or none', () => {
  it('moves for the peer, and says who is speaking', () => {
    const speaking = view({ speaking: true, captionIsSelf: false });
    expect(speaking.speech?.active).toBe(true);
    expect(speaking.speech?.accessibilityLabel).toBe('Tunde is speaking');
  });

  it('says NOTHING about the peer while the caption on screen is this phone’s own', () => {
    /*
     * `routeCaption` deliberately delivers a speaker their OWN transcript, and
     * the slot accepts a caption from anybody -- so the bars, which sit above
     * the PEER's face, animated while this phone's user talked. The bars now
     * rest, and the label does not trade an unattributed claim for an
     * attributed false one: at that instant the phone holds no measurement of
     * the peer at all, and "Tunde is quiet" was certified by a test.
     */
    const mine = view({ speaking: true, captionIsSelf: true });
    expect(mine.speech?.active).toBe(false);
    expect(mine.speech?.accessibilityLabel).toBeNull();
    const mineSettled = view({ speaking: false, captionIsSelf: true });
    expect(mineSettled.speech?.accessibilityLabel).toBeNull();
  });

  it('says the peer is quiet only when the caption on screen is THEIRS', () => {
    const theirs = view({ speaking: false, captionIsSelf: false });
    expect(theirs.speech?.accessibilityLabel).toBe('Tunde is quiet');
  });

  it('is absent before any caption has arrived, and off a live call', () => {
    expect(view({ caption: null }).speech).toBeNull();
    expect(view({ phase: 'placing' }).speech).toBeNull();
    expect(view({ phase: 'ended' }).speech).toBeNull();
  });
});

describe('one pill, and it states a pair rather than an activity', () => {
  it('shows the pair on a translated call between two languages', () => {
    const pill = view().pill;
    expect(pill?.kind).toBe('languages');
    expect(pill?.label).toBe('YO → EN');
    // An arrow is not a word -- but neither is this a claim that anything is
    // happening. "Translating Yoruba to English" was announced on ended calls,
    // on calls the server could not translate, and on calls nobody answered.
    expect(pill?.accessibilityLabel).toBe('Yoruba to English');
    expect(pill?.accessibilityLabel).not.toMatch(/translating/iu);
  });

  it('never announces a pair on a NORMAL call', () => {
    const pill = view({
      translation: {
        mode: 'normal',
        engine: null,
        playback: null,
        playedAtMs: null,
        refusedAtMs: null,
        captionedAtMs: null,
        playedCoveredMs: 0,
        refusedCoveredMs: 0,
      },
    }).pill;
    expect(pill?.kind).toBe('mode');
    expect(pill?.label).toBe('Normal call');
    expect(pill?.accessibilityLabel).not.toMatch(/translating/iu);
  });

  it('never announces English to English', () => {
    const pill = view({ languages: { from: 'en', to: 'en-GB' } }).pill;
    expect(pill?.kind).toBe('mode');
    expect(pill?.label).toBe('Translated call');
  });

  it('is NOT DRAWN before the server has stated a mode -- the C7 mark says that much', () => {
    /*
     * The mark at the top of the screen reads DIRECT CALL. The pill's fallback
     * read "Direct call" too, for the whole of every outgoing ring: the same
     * two words twice, 300dp apart, on the screen a person stares at while a
     * call rings.
     */
    expect(
      view({
        languages: null,
        phase: 'placing',
        translation: {
          mode: null,
          engine: null,
          playback: null,
          playedAtMs: null,
          refusedAtMs: null,
          captionedAtMs: null,
          playedCoveredMs: 0,
          refusedCoveredMs: 0,
        },
      }).pill,
    ).toBeNull();
    // With a mode stated it says the mode, which the mark does not.
    expect(view({ languages: null }).pill).toEqual({
      kind: 'mode',
      label: 'Translated call',
      accessibilityLabel: 'Translated call',
    });
  });

  it('is not drawn where the phone has measured that translation is not happening', () => {
    const noEngine = view({
      phase: 'placing',
      translation: {
        mode: 'translated',
        engine: false,
        playback: 'listening',
        playedAtMs: null,
        refusedAtMs: null,
        captionedAtMs: null,
        playedCoveredMs: 0,
        refusedCoveredMs: 0,
      },
    });
    expect(noEngine.pill).toBeNull();
    expect(noEngine.readinessLine?.warn).toBe(true);
    const noPlayback = view({
      translation: {
        mode: 'translated',
        engine: null,
        playback: 'unavailable',
        playedAtMs: null,
        refusedAtMs: null,
        captionedAtMs: null,
        playedCoveredMs: 0,
        refusedCoveredMs: 0,
      },
    });
    expect(noPlayback.pill).toBeNull();
  });

  it('agrees with the ended verdict, or is not drawn at all', () => {
    const ended = (over: Partial<CallScreenViewInput['translation']>) =>
      view({
        phase: 'ended',
        serverState: 'ended',
        connectedRow: { show: false, words: '', warn: false },
        translation: {
          mode: 'translated',
          engine: null,
          playback: 'listening',
          playedAtMs: null,
          refusedAtMs: null,
          captionedAtMs: null,
          playedCoveredMs: 0,
          refusedCoveredMs: 0,
          ...over,
        },
      });
    // Unproven: every honest element goes quiet, and the pill does not become
    // the one thing on the screen still claiming a translation.
    expect(ended({}).pill).toBeNull();
    expect(ended({ captionedAtMs: NOW }).pill).toBeNull();
    expect(
      ended({
        playedAtMs: NOW - 1_000,
        playedCoveredMs: 20_000,
        refusedAtMs: NOW,
        refusedCoveredMs: 200_000,
      }).pill,
    ).toBeNull();
    // A call translated for a fraction of its length is not a call that wears
    // its language pair either: the pill agrees with the verdict or is absent.
    expect(ended({ playedAtMs: NOW, playedCoveredMs: 4_000 }).pill).toBeNull();
    // Proven: the pair is exactly what the summary card also says.
    expect(ended({ playedAtMs: NOW, playedCoveredMs: 280_000 }).pill?.label).toBe('YO → EN');
  });

  it('belongs to a direct call; a conference has no pair to state', () => {
    expect(view({ kind: 'conference' }).pill).toBeNull();
  });
});

describe('the ring arc is a measurement, drained, and it says what of', () => {
  it('is full at the start of the ring window and empty at the deadline', () => {
    expect(view({ phase: 'placing', ringElapsed: 0 }).halo.measure?.remaining).toBe(1);
    expect(view({ phase: 'placing', ringElapsed: 1 }).halo.measure?.remaining).toBe(0);
    expect(view({ phase: 'placing', ringElapsed: 0.25 }).halo.measure?.remaining).toBeCloseTo(
      0.75,
      6,
    );
  });

  it('names what it is a share of, in the SAME value as the figure', () => {
    /*
     * A teal arc shrinking under "Calling…" reads as falling signal as readily
     * as it reads as time left, and it carried no label of any kind. The figure
     * and the sentence are one value now, so the screen cannot pass one and
     * drop the other -- `remainingLabel={null}` left the arc drawn and silent,
     * and the whole suite stayed green.
     */
    const halo = view({ phase: 'placing', ringElapsed: 0.25 }).halo;
    expect(halo.measure).toEqual({ remaining: 0.75, label: 'Time left for them to answer: 75%' });
    expect(view({ phase: 'placing', ringElapsed: null }).halo.measure).toBeNull();
  });

  it('draws no arc, and breathes instead, when no deadline was measured', () => {
    const halo = view({ phase: 'placing', ringElapsed: null }).halo;
    expect(halo.measure).toBeNull();
    expect(halo.pulsing).toBe(true);
    expect(halo.ring).toBe(true);
  });

  it('stands the pulse down wherever there is a window to draw', () => {
    expect(view({ phase: 'placing', ringElapsed: 0.5 }).halo.pulsing).toBe(false);
  });

  it('carries no arc into a live or ended call', () => {
    expect(view({ phase: 'live', ringElapsed: 0.5 }).halo.measure).toBeNull();
    expect(view({ phase: 'live' }).halo.ring).toBe(false);
    expect(view({ phase: 'ended', ringElapsed: 0.5 }).halo.measure).toBeNull();
    expect(view({ phase: 'ended' }).halo.dim).toBe(true);
  });
});

describe('the dock is a fixed set for the whole of a phase, on ONE row', () => {
  it('is the same four controls all through a live call', () => {
    const early = view({ caption: null });
    const later = view();
    expect(dockIds(early.dock)).toEqual(['mute', 'speaker', 'camera', 'captions']);
    expect(dockIds(later.dock)).toEqual(dockIds(early.dock));
    // The captions control cannot be pressed before there is a caption to hide,
    // and it does not ARRIVE mid-call and shift the hand reaching for End.
    expect(early.dock[3]?.disabled).toBe(true);
    expect(later.dock[3]?.disabled).toBe(false);
  });

  it('names what the caption control DOES, and never claims to switch translation off', () => {
    // It renders a captions glyph for the same reason: this client has never
    // sent `call:mode:set` and cannot turn translation off, and a teal
    // translate glyph going dark told people it had.
    expect(view().dock[3]?.label).toBe('Hide captions');
    expect(view({ captionsShown: false }).dock[3]?.label).toBe('Show captions');
    expect(view().dock[3]?.label).not.toMatch(/translat/iu);
  });

  it('drops the words when five controls have to share one row', () => {
    /*
     * Five labelled controls need 458dp and no portrait phone has it, so the
     * row wrapped, the dock grew to a third of the screen and the caption card
     * went off the bottom. The label survives as the accessibility name.
     */
    expect(view().dockLabels).toBe(false);
    expect(view().dock).toHaveLength(4);
    // Conference: three controls and End -- the words fit.
    expect(view({ kind: 'conference' }).dockLabels).toBe(true);
    // Ended: Call back, Message and Close.
    expect(view({ phase: 'ended', serverState: 'no_answer' }).dockLabels).toBe(true);
    // Placing: one red button.
    expect(view({ phase: 'placing' }).dockLabels).toBe(true);
  });

  it('is one red button while a call is being placed', () => {
    const placing = view({ phase: 'placing' });
    expect(placing.dock).toEqual([]);
    expect(placing.endLabel).toBe('Cancel');
  });

  it('offers no live controls on a call that has ended -- conferences included', () => {
    // Mute, Speaker and Camera acting on a dead call: the old guard let all
    // three through the ended phase, and the guard after it exempted
    // conferences, so a finished conference still showed all three.
    const ended = view({ phase: 'ended', serverState: 'ended' });
    expect(ended.dock).toEqual([]);
    expect(ended.endLabel).toBe('Close');
    const conference = view({ kind: 'conference', phase: 'ended', serverState: 'ended' });
    expect(conference.dock).toEqual([]);
    expect(conference.endLabel).toBe('Leave');
  });

  it('reflects what each control is currently doing', () => {
    const on = view({ muted: true, speakerOn: true, cameraOn: true, cameraStarting: true });
    expect(on.dock.map((control) => [control.label, control.active])).toEqual([
      ['Unmute', true],
      ['Speaker', true],
      ['Camera on', true],
      ['Hide captions', true],
    ]);
    expect(on.dock[2]?.disabled).toBe(true);
  });

  it('keeps a conference on its own dock, which is joined rather than placed', () => {
    const conference = view({ kind: 'conference', phase: 'placing' });
    expect(dockIds(conference.dock)).toEqual(['mute', 'speaker', 'camera']);
    expect(conference.endLabel).toBe('Leave');
    expect(conference.pill).toBeNull();
    expect(conference.caption).toBeNull();
  });
});

describe('the ended screen offers the two things a person does next, and waits', () => {
  it('draws Call back and Message as controls', () => {
    const ended = view({ phase: 'ended', serverState: 'no_answer' });
    expect(ended.endedActions).toEqual(['call-back', 'message']);
    // And does not ALSO print the grey sentence that stood in for them.
    expect(ended.hint).toBeNull();
  });

  it('does NOT dismiss itself while there is something to press', () => {
    /*
     * The screen called `onLeave()` 2500 ms after the terminal state, so the
     * two buttons the board exists to offer appeared and vanished before a hand
     * reached them, and the summary card could not be read.
     */
    expect(view({ phase: 'ended', serverState: 'no_answer' }).autoDismissMs).toBeNull();
    expect(view({ phase: 'ended', serverState: 'ended' }).autoDismissMs).toBeNull();
  });

  it('dismisses itself only where there is nothing to act on', () => {
    const nothing = view({
      phase: 'ended',
      serverState: 'no_answer',
      elapsedMs: null,
      canCallBack: false,
      canMessage: false,
    });
    expect(nothing.endedActions).toEqual([]);
    expect(nothing.summary).toBeNull();
    expect(nothing.autoDismissMs).toBe(2_500);
    // A conference that ends has no actions of its own and still goes.
    expect(
      view({ kind: 'conference', phase: 'ended', serverState: 'ended' }).autoDismissMs,
    ).toBe(2_500);
  });

  it('never dismisses a call that is still running', () => {
    expect(view({ phase: 'live' }).autoDismissMs).toBeNull();
    expect(view({ phase: 'placing' }).autoDismissMs).toBeNull();
  });

  it('falls back to the sentence only where the screen was given nowhere to go', () => {
    const ended = view({
      phase: 'ended',
      serverState: 'no_answer',
      canCallBack: false,
      canMessage: false,
    });
    expect(ended.endedActions).toEqual([]);
    expect(ended.hint).toMatch(/message them instead/iu);
  });

  it('offers nothing while the call is still running', () => {
    expect(view({ phase: 'live' }).endedActions).toEqual([]);
    expect(view({ phase: 'placing' }).endedActions).toEqual([]);
  });
});

describe('the live screen', () => {
  it('shows a zero-padded clock and the server’s own current sentence', () => {
    const live = view({ elapsedMs: 228_000 });
    expect(live.timer).toBe('03:48');
    expect(live.connected).toEqual({ words: 'Connected', warn: false });
    expect(live.eyebrow).toBeNull();
    expect(live.stateLine).toBeNull();
  });

  it('follows the connected row rather than forming a second opinion', () => {
    expect(view({ connectedRow: { show: false, words: '', warn: false } }).connected).toBeNull();
    expect(
      view({ connectedRow: { show: true, words: 'Reconnecting…', warn: true } }).connected,
    ).toEqual({ words: 'Reconnecting…', warn: true });
  });

  it('offers the camera notice only on an audio call with nothing else in the column', () => {
    expect(view({ caption: null }).cameraNotice).toBe(true);
    expect(view().cameraNotice).toBe(false);
    expect(view({ caption: null, cameraOn: true }).cameraNotice).toBe(false);
  });
});
