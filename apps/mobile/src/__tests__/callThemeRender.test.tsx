/** @author masterzee001 */
/**
 * THE CALL SURFACE, RENDERED -- the layer that had never been tested at all.
 *
 * THE MEASUREMENT THAT PRODUCED THIS FILE. Twenty-six mutants were planted in
 * the screen, its components and its styles; four died and twenty-two survived
 * a green 513-test suite, each of them also passing `tsc --noEmit`. Among the
 * survivors: the founder's named defect re-cut inside `CaptionCard` (the nested
 * card fed the ORIGINAL sentence, so "TRANSLATION · ENGLISH" sat over the
 * Yoruba words), the hand-drawn quarter-arc re-cut inside `CallRing`, and the
 * previous round's live-pulse regression re-cut inside `AvatarHalo`. The only
 * instrument pointed at any of it matched SOURCE TEXT, and no arrangement of
 * source text can see a prop.
 *
 * So these RENDER. `react-test-renderer` against the react-native stub in
 * ./stubs produces a tree of host components and their props, which is exactly
 * the granularity a mutant works at: a swapped value, a dropped prop, a deleted
 * style. Nothing here asserts that a function was called or that a file
 * contains a string.
 */
import { describe, expect, it } from 'vitest';
import {
  AvatarHalo,
  CALL_COLORS,
  CallRing,
  CallStatePill,
  CaptionCard,
  EndCallButton,
  RoundControl,
  SpeechIndicator,
  SummaryCard,
} from '../ui/callTheme';
import { nodesOfType, nodesWhere, render, styleOf, textOf, textsOf } from './stubs/render';

describe('the caption card: what was said, and what it became', () => {
  const card = (over: Partial<Parameters<typeof CaptionCard>[0]> = {}) =>
    render(
      <CaptionCard
        speaker="Tunde"
        sourceLabel="YORUBA"
        original="Bawo ni, se daadaa ni?"
        translation={{ label: 'ENGLISH', text: 'Hello, how are you?' }}
        {...over}
      />,
    ).tree;

  it('puts the TRANSLATION under the translation label, never the original again', () => {
    /*
     * The founder's named defect, at the last inch: with `{original}` rendered
     * inside the nested card, "TRANSLATION · ENGLISH" sat over the Yoruba
     * sentence and the whole suite stayed green.
     */
    const tree = card();
    const texts = textsOf(tree);
    expect(texts).toContain('TRANSLATION · ENGLISH');
    // The nested card: the innermost VIEW holding the label, which is where
    // the translated sentence has to be and where the original must not be.
    const nested = nodesWhere(
      tree,
      (node) => node.type === 'View' && textsOf(node).includes('TRANSLATION · ENGLISH'),
    ).slice(-1)[0];
    expect(nested).toBeDefined();
    const nestedTexts = textsOf(nested!);
    expect(nestedTexts).toContain('Hello, how are you?');
    expect(nestedTexts).not.toContain('Bawo ni, se daadaa ni?');
  });

  it('labels the nested card with the language it was translated INTO', () => {
    expect(textsOf(card())).toContain('TRANSLATION · ENGLISH');
    expect(textsOf(card())).not.toContain('TRANSLATION · YORUBA');
  });

  it('draws no nested card for an utterance that was never translated', () => {
    const tree = card({ translation: null });
    expect(textsOf(tree)).not.toContain('Hello, how are you?');
    expect(textsOf(tree).some((text) => text.startsWith('TRANSLATION'))).toBe(false);
  });

  it('keeps the LANGUAGE when a long name will not fit', () => {
    /*
     * This was one line, `NAME · LANGUAGE`, under `numberOfLines={1}`: RN
     * ellipsises at the tail, so "OLUWASEUN ADEBAYO-OGUNLESI · NIGERIAN PIDGIN"
     * lost the language -- for exactly the users the whole-word label exists
     * for. Two Texts now, and only one of them may shrink.
     */
    const tree = card({ speaker: 'Oluwaseun Adebayo-Ogunlesi', sourceLabel: 'NIGERIAN PIDGIN' });
    const texts = textsOf(tree);
    expect(texts).toContain('OLUWASEUN ADEBAYO-OGUNLESI');
    expect(texts).toContain('NIGERIAN PIDGIN');
    const language = nodesWhere(tree, (node) => textOf(node) === 'NIGERIAN PIDGIN')[0];
    const name = nodesWhere(tree, (node) => textOf(node) === 'OLUWASEUN ADEBAYO-OGUNLESI')[0];
    expect(styleOf(language!)['flexShrink']).toBe(0);
    expect(styleOf(name!)['flexShrink']).toBe(1);
    expect(language!.props['numberOfLines']).toBe(1);
  });

  it('names the language alone when the gateway sent no speaker', () => {
    const texts = textsOf(card({ speaker: '' }));
    expect(texts).toContain('YORUBA');
    expect(texts.some((text) => text.includes('·') && text.includes('YORUBA'))).toBe(false);
  });

  it('draws a partial a shade back from a settled one', () => {
    const settled = nodesWhere(card(), (node) => textOf(node) === 'Bawo ni, se daadaa ni?')[0];
    expect(styleOf(settled!)['opacity']).toBeUndefined();
    const interim = nodesWhere(card({ interim: true }), (node) => textOf(node) === 'Bawo ni, se daadaa ni?')[0];
    expect(styleOf(interim!)['opacity']).toBeCloseTo(0.7, 5);
  });
});

describe('the ring arc is a measurement or it is absent', () => {
  /** The arc is the second Circle; the first is the dashed texture. */
  const circles = (remaining: number | null, label: string | null = null) =>
    nodesOfType(render(<CallRing size={188} remaining={remaining} remainingLabel={label} />).tree, 'Circle');

  it('draws NO arc when nothing was measured', () => {
    /*
     * The component used to substitute a hand-drawn `remaining ?? 0.25` in the
     * same colour and weight as a real measurement. An unmeasured thing drawn
     * in the language of a measured one is the same lie as a status line over
     * silence.
     */
    const drawn = circles(null);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.props['strokeDasharray']).toBe('3 9');
  });

  it('draws the arc, and its head, from the figure it was given', () => {
    const drawn = circles(0.5);
    expect(drawn).toHaveLength(3);
    const arc = drawn[1]!;
    const radius = arc.props['radius'] ?? arc.props['r'];
    const circumference = 2 * Math.PI * Number(radius);
    const [drawnRun] = String(arc.props['strokeDasharray']).split(' ');
    // Half the window left is half the circle drawn -- computed here rather
    // than imported, so the component and the arithmetic are two witnesses.
    expect(Number(drawnRun)).toBeCloseTo(circumference / 2, 3);
    expect(arc.props['stroke']).toBe(CALL_COLORS.teal);
  });

  it('is emptier as the window drains, and never the other way round', () => {
    const run = (remaining: number): number =>
      Number(String(nodesOfType(render(<CallRing size={188} remaining={remaining} />).tree, 'Circle')[1]?.props['strokeDasharray']).split(' ')[0]);
    expect(run(1)).toBeGreaterThan(run(0.5));
    expect(run(0.5)).toBeGreaterThan(run(0.05));
  });

  it('SAYS WHAT IT MEASURES, for somebody who cannot see it', () => {
    // Nothing on the screen said what the arc was a share of, and the Svg
    // carried no label at all: a shrinking teal arc under "Calling…" reads as
    // falling signal as readily as it reads as a deadline.
    const labelled = render(
      <CallRing size={188} remaining={0.75} remainingLabel="Time left for them to answer: 75%" />,
    ).tree;
    const svg = nodesOfType(labelled, 'Svg')[0]!;
    expect(svg.props['accessibilityLabel']).toBe('Time left for them to answer: 75%');
    expect(svg.props['accessibilityRole']).toBe('progressbar');
    expect(svg.props['accessibilityValue']).toEqual({ min: 0, max: 100, now: 75 });
    // Texture is not announced.
    const bare = nodesOfType(render(<CallRing size={188} />).tree, 'Svg')[0]!;
    expect(bare.props['accessibilityLabel']).toBeUndefined();
  });
});

describe('the halo breathes when it is asked to, ring or no ring', () => {
  const halo = (props: Partial<Parameters<typeof AvatarHalo>[0]>) =>
    render(<AvatarHalo accountId="a1" name="Tunde" {...props} />).tree;

  it('breathes on the incoming screen, which passes BOTH pulsing and ring', () => {
    /*
     * The F5 regression, verbatim: the pulsing view was rendered only inside
     * `{pulsing && !ring}` while every caller in the app passes both, so the
     * animation drove a value no view consumed and the incoming-call screen --
     * which had breathed since it was built -- went still.
     */
    expect(nodesOfType(halo({ pulsing: true, ring: true }), 'Animated.View')).toHaveLength(1);
    expect(nodesOfType(halo({ pulsing: true, ring: false }), 'Animated.View')).toHaveLength(1);
    expect(nodesOfType(halo({ pulsing: false, ring: true }), 'Animated.View')).toHaveLength(0);
  });

  it('carries the measured arc and its label through to the ring', () => {
    const tree = halo({ ring: true, remaining: 0.25, remainingLabel: 'Time left for them to answer: 25%' });
    const svg = nodesOfType(tree, 'Svg')[0]!;
    expect(svg.props['accessibilityLabel']).toBe('Time left for them to answer: 25%');
    expect(nodesOfType(tree, 'Circle')).toHaveLength(3);
    // No ring asked for, no ring drawn.
    expect(nodesOfType(halo({ ring: false, remaining: 0.25 }), 'Svg')).toHaveLength(0);
  });
});

describe('the speech bars move only for a measured voice', () => {
  it('rest, grey, when nobody the phone can measure is speaking', () => {
    const tree = render(<SpeechIndicator active={false} accessibilityLabel="Tunde is quiet" />).tree;
    const bars = nodesOfType(tree, 'Animated.View');
    expect(bars).toHaveLength(5);
    for (const bar of bars) expect(styleOf(bar)['backgroundColor']).toBe(CALL_COLORS.faint);
    // A rest height is a number; an animating one is an interpolation.
    expect(typeof styleOf(bars[0]!)['height']).toBe('number');
  });

  it('move, teal, when they are', () => {
    const bars = nodesOfType(
      render(<SpeechIndicator active accessibilityLabel="Tunde is speaking" />).tree,
      'Animated.View',
    );
    for (const bar of bars) expect(styleOf(bar)['backgroundColor']).toBe(CALL_COLORS.teal);
    expect(styleOf(bars[0]!)['height']).toMatchObject({ __interpolated: true });
  });

  it('say NOTHING about the peer when the phone has no measurement of them', () => {
    // The caption on screen is this phone's own speech: "Tunde is quiet" was a
    // fact stated about somebody who may have been talking over the user.
    const row = nodesOfType(render(<SpeechIndicator active={false} accessibilityLabel={null} />).tree, 'View')[0]!;
    expect(row.props['accessibilityLabel']).toBeUndefined();
    expect(row.props['accessibilityElementsHidden']).toBe(true);
  });
});

describe('the dock controls', () => {
  it('drop the word without dropping the name a screen reader reads', () => {
    const withWord = render(
      <RoundControl label="Hide captions" onPress={() => {}} mark="CC" />,
    ).tree;
    expect(textsOf(withWord)).toContain('Hide captions');
    const without = render(
      <RoundControl label="Hide captions" onPress={() => {}} mark="CC" showLabel={false} />,
    ).tree;
    expect(textsOf(without)).not.toContain('Hide captions');
    expect(without.props['accessibilityLabel']).toBe('Hide captions');
    expect(without.props['accessibilityRole']).toBe('button');
  });

  it('fill teal when they are ON, and say so to a screen reader', () => {
    const on = render(<RoundControl label="Mute" active onPress={() => {}} mark="M" />).tree;
    const circle = nodesOfType(on, 'View')[0]!;
    expect(styleOf(circle)['backgroundColor']).toBe(CALL_COLORS.teal);
    expect(on.props['accessibilityState']).toEqual({ selected: true, disabled: false });
    const off = render(<RoundControl label="Mute" onPress={() => {}} mark="M" />).tree;
    expect(styleOf(nodesOfType(off, 'View')[0]!)['backgroundColor']).not.toBe(CALL_COLORS.teal);
  });

  it('cannot be pressed when the model disabled them', () => {
    let pressed = 0;
    const tree = render(
      <RoundControl label="Show captions" disabled onPress={() => (pressed += 1)} mark="CC" />,
    ).tree;
    expect(tree.props['disabled']).toBe(true);
    expect(tree.props['accessibilityState']).toEqual({ selected: false, disabled: true });
    expect(pressed).toBe(0);
  });

  it('keep the red button red, and its second press harmless', () => {
    const tree = render(<EndCallButton label="End call" disabled onPress={() => {}} />).tree;
    const circle = nodesOfType(tree, 'View')[0]!;
    expect(styleOf(circle)['backgroundColor']).toBe(CALL_COLORS.red);
    expect(tree.props['onPress']).toBeUndefined();
    expect(tree.props['accessibilityLabel']).toBe('End call');
  });
});

describe('the summary card and the pill', () => {
  it('prints every row it was given, label and value', () => {
    const tree = render(
      <SummaryCard
        title="Call summary"
        rows={[
          { label: 'Duration', value: '4 min 51 s' },
          { label: 'Translation', value: 'Not available' },
        ]}
      />,
    ).tree;
    const texts = textsOf(tree);
    expect(texts).toEqual(
      expect.arrayContaining(['Call summary', 'Duration', '4 min 51 s', 'Translation', 'Not available']),
    );
  });

  it('never assembles the spoken sentence out of the printed one', () => {
    // `YO → EN` read aloud is not a sentence, and the pill used to hard-code
    // "Translating <from> to <to>" regardless of what the call was doing.
    const tree = render(
      <CallStatePill kind="languages" label="YO → EN" accessibilityLabel="Yoruba to English" />,
    ).tree;
    const text = nodesOfType(tree, 'Text')[0]!;
    expect(textOf(text)).toBe('YO → EN');
    expect(text.props['accessibilityLabel']).toBe('Yoruba to English');
  });
});
