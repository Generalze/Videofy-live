/** @author masterzee001 */
/**
 * THE INCOMING CALL SCREEN, RENDERED -- the screen the regressions shipped on.
 *
 * WHY THIS FILE EXISTS. Every other surface in this wave ended up with a
 * rendered test and this one did not, and it is the worst place for that gap:
 * it is where the live-pulse regression actually shipped (the halo went still,
 * so a ringing phone looked frozen) and where "Translated call" was printed
 * twice, 200dp apart. A reviewer planted three mutants here and all three
 * survived a green 580-test suite with `tsc --noEmit` clean:
 *
 *   1. `<C7Mark />` -> `<C7Mark caption={...} />`, restoring the duplicated
 *      words word for word.
 *   2. dropping `pulsing` from the halo, restoring the frozen screen.
 *   3. `{mode === 'translated' && (` -> `{false && (`, removing the only
 *      statement on the screen that the call will be translated.
 *
 * Two of those are now compile errors rather than test failures -- `pulsing`
 * and `ring` are required props on AvatarHalo -- and all three are measured
 * here. Every assertion below is about what a person would see or hear read
 * aloud.
 */
import { describe, expect, it } from 'vitest';
import { IncomingCallScreen } from '../screens/IncomingCallScreen';
import { nodesOfType, nodesWhere, render, styleOf, textOf, textsOf } from './stubs/render';

const CALLER = { accountId: 'peer-1', name: 'Tunde' };

const screen = (over: Partial<Parameters<typeof IncomingCallScreen>[0]> = {}) =>
  render(
    <IncomingCallScreen
      caller={CALLER}
      mode="translated"
      onAnswer={() => {}}
      onDecline={() => {}}
      {...over}
    />,
  ).tree;

/** Everything a screen reader would be offered, in order. */
const labels = (tree: ReturnType<typeof screen>): string[] =>
  nodesWhere(tree, (node) => typeof node.props['accessibilityLabel'] === 'string').map(
    (node) => node.props['accessibilityLabel'] as string,
  );

describe('what kind of call this is, the screen says ONCE', () => {
  it('does not print "Translated call" twice, 200dp apart', () => {
    /*
     * R11, which was argued away once before it was checked. The C7 mark at the
     * top read "Translated call" and the teal pill in the middle read
     * "Translated call": the same two words, on the same screen, with a face
     * between them.
     */
    const printed = textsOf(screen()).filter((text) => text.toLowerCase() === 'translated call');
    expect(printed).toHaveLength(1);
  });

  it('does not print "Incoming call" twice either', () => {
    const printed = textsOf(screen({ mode: 'normal' })).filter(
      (text) => text.toLowerCase() === 'incoming call',
    );
    expect(printed).toHaveLength(1);
  });

  it('leaves the mark saying whose app this is', () => {
    expect(textsOf(screen())).toContain('Videofy');
    expect(textsOf(screen())).toContain('C7');
  });
});

describe('the call will be translated, and the screen says so', () => {
  it('draws the mode pill on a translated call', () => {
    // The pre-join wire carries the MODE and no language of any kind, so this
    // is the honest half of the board's language pill and does not pretend to
    // be the rest of it.
    expect(textsOf(screen())).toContain('Translated call');
  });

  it('draws nothing of the sort on a normal call', () => {
    const texts = textsOf(screen({ mode: 'normal' }));
    expect(texts.some((text) => /translat/iu.test(text))).toBe(false);
  });

  it('draws no language pair, because this phone is not in the call yet', () => {
    // `YO → EN` needs both seats' languages and they live on `call:state`,
    // which only exists after joining. A pair here would be a decoration
    // shaped like a fact.
    const texts = textsOf(screen());
    expect(texts.some((text) => text.includes('→'))).toBe(false);
  });
});

describe('a ringing phone is not a still one', () => {
  it('BREATHES: the halo pulse is running while the call rings', () => {
    /*
     * The F5 regression at the exact call site where it shipped. The pulse is
     * the only animated thing on this screen; when it stopped, a phone that
     * was ringing looked frozen. `pulsing` is a required prop now, so dropping
     * it does not compile -- and this measures that it is still asked for.
     */
    const animated = nodesOfType(screen(), 'Animated.View');
    expect(animated).toHaveLength(1);
    const style = styleOf(animated[0]!);
    // An animating value is an interpolation; a still one is a number.
    expect(style['opacity']).toMatchObject({ __interpolated: true });
    expect(style['transform']).toBeDefined();
  });

  it('draws the dashed ring and NO measured arc', () => {
    // Nothing has measured a deadline before this phone is in the call, and an
    // arc is a measurement or it is absent.
    const circles = nodesOfType(screen(), 'Circle');
    expect(circles).toHaveLength(1);
    expect(circles[0]?.props['strokeDasharray']).toBe('3 9');
    const svg = nodesOfType(screen(), 'Svg')[0]!;
    expect(svg.props['accessibilityRole']).toBeUndefined();
  });
});

describe('the two buttons, and the person behind them', () => {
  it('offers Answer and Decline, each named and pressable', () => {
    let answered = 0;
    let declined = 0;
    const tree = render(
      <IncomingCallScreen
        caller={CALLER}
        mode="translated"
        onAnswer={() => (answered += 1)}
        onDecline={() => (declined += 1)}
      />,
    ).tree;
    expect(labels(tree)).toEqual(expect.arrayContaining(['Answer', 'Decline']));
    for (const name of ['Answer', 'Decline']) {
      const control = nodesWhere(tree, (node) => node.props['accessibilityLabel'] === name)[0]!;
      expect(control.props['accessibilityRole']).toBe('button');
      (control.props['onPress'] as () => void)();
    }
    expect([answered, declined]).toEqual([1, 1]);
  });

  it('keeps both targets well over the 44dp floor, on BOTH axes', () => {
    // A directional assertion passes when a control yields one point; this one
    // reads the height as well, which is where a 52x36 mis-hit hides.
    const tree = screen();
    for (const name of ['Answer', 'Decline']) {
      const control = nodesWhere(tree, (node) => node.props['accessibilityLabel'] === name)[0]!;
      // The circle IS the Pressable on this screen; it carries its own size.
      const circle = styleOf(control);
      expect(Number(circle['width'])).toBeGreaterThanOrEqual(44);
      expect(Number(circle['height'])).toBeGreaterThanOrEqual(44);
      expect(Number(circle['borderRadius'])).toBeGreaterThan(0);
    }
  });

  it('names the caller once, on one line, without cutting the word in half twice', () => {
    const tree = screen({ caller: { accountId: 'p2', name: 'Oluwaseun Adebayo-Ogunlesi' } });
    expect(textsOf(tree)).toContain('Oluwaseun Adebayo-Ogunlesi');
    const name = nodesWhere(tree, (node) => textOf(node) === 'Oluwaseun Adebayo-Ogunlesi')[0]!;
    expect(name.props['numberOfLines']).toBe(1);
    expect(textsOf(tree)).toContain('is calling you on C7');
  });
});

/**
 * THE LANGUAGE PAIR, BEFORE ANYBODY ANSWERS.
 *
 * The board puts the pill on every call screen including this one, and for
 * three rounds it could not be drawn here: the pre-join wire carried ring,
 * state, mode, caller account and caller name and no language of any kind,
 * while `call:state` -- the only other record of a seat's languages -- does not
 * exist until somebody has joined, one moment after the screen that asks you
 * to decide. The gateway now sends the caller's spoken language with the ring.
 *
 * A pair needs BOTH halves, so most of these tests are about its absence.
 */
describe('the pill says the most the phone has actually measured', () => {
  it('draws the pair when the gateway and the profile both answered', () => {
    const tree = screen({ callerSpeaks: 'yo', selfHears: 'en' });
    expect(textsOf(tree)).toContain('YO → EN');
    // Spoken as words, because "Y O arrow E N" is not a sentence -- and
    // WITHOUT the present tense, since nothing is translating yet.
    expect(labels(tree)).toContain('Yoruba to English');
    for (const label of labels(tree)) expect(label).not.toMatch(/Translating/u);
  });

  it('falls back to the MODE when the caller’s language is not on the wire', () => {
    /*
     * Every gateway older than the field, and the first frame of every call,
     * because the push that wakes this phone carries no language. The honest
     * weaker fact is that the call will be translated, not which way round.
     */
    const tree = screen({ callerSpeaks: null, selfHears: 'en' });
    expect(textsOf(tree)).toContain('Translated call');
    expect(textsOf(tree).some((text) => text.includes('→'))).toBe(false);
  });

  it('falls back to the MODE when this phone has not resolved its own profile', () => {
    const tree = screen({ callerSpeaks: 'yo', selfHears: null });
    expect(textsOf(tree)).toContain('Translated call');
    expect(textsOf(tree).some((text) => text.includes('→'))).toBe(false);
  });

  it('DRAWS NO PILL AT ALL on a normal call, whatever the languages say', () => {
    // The pair is a fact about the seats; the claim is about the service. A
    // normal call has no translation, so it has nothing to state.
    const tree = screen({ mode: 'normal', callerSpeaks: 'yo', selfHears: 'en' });
    expect(textsOf(tree).some((text) => text.includes('→'))).toBe(false);
    expect(textsOf(tree)).not.toContain('Translated call');
  });

  it('DRAWS NO PAIR when both sides are the same language', () => {
    /*
     * "EN → EN" is not a translation, and a screen reader hearing "English to
     * English" is being told something is happening that is not. The regional
     * subtag is not a difference: en and en-GB are one language here.
     */
    for (const hears of ['en', 'en-GB']) {
      const tree = screen({ callerSpeaks: 'en', selfHears: hears });
      expect(textsOf(tree).some((text) => text.includes('→'))).toBe(false);
      expect(textsOf(tree)).toContain('Translated call');
    }
  });

  it('says it ONCE: the pair replaces the mode, never sits beside it', () => {
    const tree = screen({ callerSpeaks: 'yo', selfHears: 'en' });
    expect(textsOf(tree)).not.toContain('Translated call');
    expect(textsOf(tree).filter((text) => text.includes('→'))).toHaveLength(1);
  });
});
