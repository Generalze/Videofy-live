/** @author masterzee001 */
/**
 * WHAT THE CALL SCREEN SHOWS -- the half that had never been tested.
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
 * Nothing in the repository imported a component, and there is no
 * react-test-renderer here to import one with. So the wiring moved into
 * `callScreenView`, and this file is the test that the ten mutants now die on.
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

function view(over: Partial<CallScreenViewInput> = {}) {
  const input: CallScreenViewInput = {
    kind: 'direct',
    phase: 'live',
    serverState: 'connected',
    role: 'caller',
    peerName: 'Tunde',
    translation: { mode: 'translated', engine: null, playback: 'listening', proof: null, refused: false },
    languages: { from: 'yo', to: 'en' },
    connectedRow: { show: true, words: 'Connected', warn: false },
    caption: CAPTION,
    captionIsSelf: false,
    speaking: false,
    captionsShown: true,
    elapsedMs: 291_000,
    ringElapsed: null,
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
});

describe('the translation line says only what was measured', () => {
  it('says NOTHING on a normal call -- the September defect', () => {
    const normal = view({
      translation: { mode: 'normal', engine: null, playback: 'listening', proof: null, refused: false },
      phase: 'placing',
    });
    expect(normal.readinessLine).toBeNull();
  });

  it('says nothing before the telephone has stated a mode', () => {
    expect(
      view({
        phase: 'placing',
        translation: { mode: null, engine: null, playback: null, proof: null, refused: false },
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
      translation: { mode: 'translated', engine: false, playback: 'listening', proof: null, refused: false },
    });
    expect(ended.readinessLine?.warn).toBe(true);
    expect(ended.readinessLine?.words).toMatch(/server cannot translate/iu);
  });

  it('does not carry a merely hopeful line onto the ended screen', () => {
    const ended = view({
      phase: 'ended',
      serverState: 'ended',
      translation: { mode: 'translated', engine: null, playback: null, proof: null, refused: false },
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
        proof: null,
        refused: false,
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

  it('says "translated" once something actually played', () => {
    const ended = endedWith({ proof: 'audio' });
    expect(ended.endedLine).toBe('4 min 51 s · translated');
    expect(ended.summary?.rows).toEqual([
      { label: 'Duration', value: '4 min 51 s' },
      { label: 'Languages', value: 'Yoruba → English' },
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
});

describe('the speech indicator names the right mouth', () => {
  it('moves for the peer, and says who is speaking', () => {
    const speaking = view({ speaking: true, captionIsSelf: false });
    expect(speaking.speech?.active).toBe(true);
    expect(speaking.speech?.accessibilityLabel).toBe('Tunde is speaking');
  });

  it('rests while the caption on screen is THIS phone’s own words', () => {
    /*
     * `routeCaption` deliberately delivers a speaker their OWN transcript, and
     * the slot accepts a caption from anybody -- so the bars, which sit above
     * the PEER's face, animated while this phone's user talked.
     */
    const mine = view({ speaking: true, captionIsSelf: true });
    expect(mine.speech?.active).toBe(false);
    expect(mine.speech?.accessibilityLabel).toBe('Tunde is quiet');
  });

  it('is absent before any caption has arrived, and off a live call', () => {
    expect(view({ caption: null }).speech).toBeNull();
    expect(view({ phase: 'placing' }).speech).toBeNull();
    expect(view({ phase: 'ended' }).speech).toBeNull();
  });
});

describe('one pill, and it never says Translating about a call that is not', () => {
  it('shows the pair on a translated call between two languages', () => {
    const pill = view().pill;
    expect(pill?.kind).toBe('languages');
    expect(pill?.label).toBe('YO → EN');
    // An arrow is not a word: the spoken label is a sentence, not the print.
    expect(pill?.accessibilityLabel).toBe('Translating Yoruba to English');
  });

  it('never announces Translating on a NORMAL call', () => {
    const pill = view({
      translation: { mode: 'normal', engine: null, playback: null, proof: null, refused: false },
    }).pill;
    expect(pill?.kind).toBe('mode');
    expect(pill?.label).toBe('Normal call');
    expect(pill?.accessibilityLabel).not.toMatch(/translating/iu);
  });

  it('never announces Translating English to English', () => {
    const pill = view({ languages: { from: 'en', to: 'en-GB' } }).pill;
    expect(pill?.kind).toBe('mode');
    expect(pill?.accessibilityLabel).not.toMatch(/translating/iu);
  });

  it('falls back to the mode the server stated when no pair was measured', () => {
    expect(view({ languages: null }).pill).toEqual({
      kind: 'mode',
      label: 'Translated call',
      accessibilityLabel: 'Translated call',
    });
    expect(
      view({
        languages: null,
        translation: { mode: null, engine: null, playback: null, proof: null, refused: false },
      }).pill?.label,
    ).toBe('Direct call');
  });
});

describe('the ring arc is a measurement, drained', () => {
  it('is full at the start of the ring window and empty at the deadline', () => {
    expect(view({ phase: 'placing', ringElapsed: 0 }).halo.remaining).toBe(1);
    expect(view({ phase: 'placing', ringElapsed: 1 }).halo.remaining).toBe(0);
    expect(view({ phase: 'placing', ringElapsed: 0.25 }).halo.remaining).toBeCloseTo(0.75, 6);
  });

  it('draws no arc, and breathes instead, when no deadline was measured', () => {
    const halo = view({ phase: 'placing', ringElapsed: null }).halo;
    expect(halo.remaining).toBeNull();
    expect(halo.pulsing).toBe(true);
    expect(halo.ring).toBe(true);
  });

  it('stands the pulse down wherever there is a window to draw', () => {
    expect(view({ phase: 'placing', ringElapsed: 0.5 }).halo.pulsing).toBe(false);
  });

  it('carries no arc into a live or ended call', () => {
    expect(view({ phase: 'live', ringElapsed: 0.5 }).halo.remaining).toBeNull();
    expect(view({ phase: 'live' }).halo.ring).toBe(false);
    expect(view({ phase: 'ended', ringElapsed: 0.5 }).halo.remaining).toBeNull();
    expect(view({ phase: 'ended' }).halo.dim).toBe(true);
  });
});

describe('the dock is a fixed set for the whole of a phase', () => {
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

  it('is one red button while a call is being placed', () => {
    const placing = view({ phase: 'placing' });
    expect(placing.dock).toEqual([]);
    expect(placing.endLabel).toBe('Cancel');
  });

  it('offers no live controls on a call that has ended', () => {
    // Mute, Speaker and Camera acting on a dead call: the old guard let all
    // three through the ended phase.
    const ended = view({ phase: 'ended', serverState: 'ended' });
    expect(ended.dock).toEqual([]);
    expect(ended.endLabel).toBe('Close');
  });

  it('reflects what each control is currently doing', () => {
    const on = view({ muted: true, speakerOn: true, cameraOn: true, cameraStarting: true });
    expect(on.dock.map((control) => [control.label, control.active])).toEqual([
      ['Unmute', true],
      ['Speaker', true],
      ['Camera on', true],
      ['Captions', true],
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

describe('the ended screen offers the two things a person does next', () => {
  it('draws Call back and Message as controls', () => {
    const ended = view({ phase: 'ended', serverState: 'no_answer' });
    expect(ended.endedActions).toEqual(['call-back', 'message']);
    // And does not ALSO print the grey sentence that stood in for them.
    expect(ended.hint).toBeNull();
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
