/** @author masterzee001 */
/**
 * The C7 call surface: the pieces every call screen is built from.
 *
 * ONE VISUAL WORLD FOR EVERY CALL STATE. Ringing, connected, reconnecting and
 * ended all sit on the same navy-black ground with the same quiet teal
 * orbit, so a state change reads as words changing -- not as the app
 * switching to a different screen. Nothing here is a library: the backdrop
 * is layered views, the halo is concentric borders, the "glass" dock is a
 * translucent panel. It renders identically on every Android build the APK
 * has shipped on, which is the point of not adding a native dependency to
 * fix a look.
 */
import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { AvatarView } from '../media/AvatarView';
import { ringGeometry, type RingMeasure } from '../call/callRingGeometry';

export const CALL_COLORS = {
  ground: '#070c14',
  navy: '#0b1220',
  teal: '#3ec9c0',
  text: '#e8eef5',
  muted: '#8d99a6',
  faint: '#5d6874',
  red: '#e0453a',
  glass: 'rgba(255,255,255,0.06)',
  glassEdge: 'rgba(255,255,255,0.10)',
} as const;

/** Navy-black ground with a soft teal radial and three orbital rings. */
export function CallBackdrop(): JSX.Element {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={styles.ground} />
      <View style={styles.radial} />
      <View style={[styles.orbit, styles.orbitOne]} />
      <View style={[styles.orbit, styles.orbitTwo]} />
      <View style={[styles.orbit, styles.orbitThree]} />
    </View>
  );
}

/** The small C7 mark: a ring with the letters, and the product name beside it. */
export function C7Mark({ caption }: { readonly caption?: string }): JSX.Element {
  return (
    <View style={styles.markRow}>
      <View style={styles.markRing}>
        <Text style={styles.markText}>C7</Text>
      </View>
      <Text style={styles.markCaption}>{caption ?? 'Videofy'}</Text>
    </View>
  );
}

/**
 * THE EYEBROW: three or four letter-spaced capitals naming the moment --
 * INCOMING CALL, CALLING…, CALL ENDED. One per screen, above everything.
 */
export function Eyebrow({ children }: { readonly children: string }): JSX.Element {
  return (
    <Text accessibilityRole="header" style={styles.eyebrow}>
      {children}
    </Text>
  );
}

/**
 * THE ONE PILL, whichever of the two it is: `YO → EN`, or `Translated call`.
 *
 * The board draws ONE. The screen drew two side by side in the same teal
 * treatment -- the mode and the pair -- which reads as a duplicated control and
 * wrapped to a second row on a narrow phone.
 *
 * NEITHER THE LABEL NOR THE SPOKEN SENTENCE IS DECIDED HERE. The pill used to
 * hard-code the screen-reader label `Translating <from> to <to>` and render on
 * the pair alone, so a normal-mode call announced "Translating Yoruba to
 * English" and a same-language pair announced "Translating English to English".
 * Both are now decided in ../call/callScreenModel.ts, where the mode and the
 * pair are both in hand and the decision can be tested.
 */
export function CallStatePill({
  label,
  accessibilityLabel,
  kind,
}: {
  readonly label: string;
  /** What a screen reader says. Never assembled from the label. */
  readonly accessibilityLabel: string;
  readonly kind: 'mode' | 'languages';
}): JSX.Element {
  return (
    <View style={kind === 'languages' ? styles.langPill : styles.modePill}>
      <Text
        accessibilityLabel={accessibilityLabel}
        numberOfLines={1}
        style={kind === 'languages' ? styles.langPillLabel : styles.modePillLabel}
      >
        {label}
      </Text>
    </View>
  );
}

/**
 * THE RING MOTIF behind the avatar: a dashed ring, and an arc inside it.
 *
 * `remaining` is the arc, and it is a MEASUREMENT or it is absent. It is the
 * share of the server's ring window still LEFT, so the arc DRAINS -- full when
 * the ring starts, empty at the deadline the gateway will declare no_answer at.
 * Given null there is no arc at all: the quarter-arc this used to substitute
 * was a hand-drawn stand-in wearing the colour and weight of a measurement.
 *
 * Every number comes from `ringGeometry`, which is where all three of those
 * decisions can be read and tested. There is deliberately no spinning variant.
 */
export function CallRing({
  size,
  measure,
  dim = false,
}: {
  readonly size: number;
  /**
   * THE ARC, OR NULL. Required and undefaulted: see {@link RingMeasure} for
   * why the figure and its spoken label are one value and why neither of them
   * has a default to restore a hand-drawn quarter-arc into.
   */
  readonly measure: RingMeasure | null;
  readonly dim?: boolean;
}): JSX.Element {
  const stroke = 2;
  const geometry = ringGeometry({ size, stroke, remaining: measure === null ? null : measure.remaining });
  const opacity = dim ? 0.35 : 1;
  return (
    <Svg
      width={size}
      height={size}
      style={{ position: 'absolute', opacity }}
      // A ring with no arc is texture and is not announced at all.
      {...(measure === null
        ? {}
        : {
            accessible: true,
            accessibilityRole: 'progressbar' as const,
            accessibilityLabel: measure.label,
            accessibilityValue: { min: 0, max: 100, now: Math.round(measure.remaining * 100) },
          })}
    >
      {/* The dashed outer ring: texture, never a value. */}
      <Circle
        cx={geometry.centre}
        cy={geometry.centre}
        r={geometry.radius}
        stroke="rgba(62,201,192,0.28)"
        strokeWidth={stroke}
        strokeDasharray="3 9"
        fill="none"
      />
      {geometry.arc !== null && (
        <>
          <Circle
            cx={geometry.centre}
            cy={geometry.centre}
            r={geometry.arc.radius}
            stroke={CALL_COLORS.teal}
            strokeWidth={stroke + 1}
            strokeLinecap="round"
            strokeDasharray={geometry.arc.dash}
            // -90deg puts the start of the arc at the top of the circle.
            transform={`rotate(-90 ${geometry.centre} ${geometry.centre})`}
            fill="none"
          />
          <Circle cx={geometry.arc.head.cx} cy={geometry.arc.head.cy} r={4} fill="#ffffff" />
        </>
      )}
    </Svg>
  );
}

/**
 * The person, in a halo. `pulsing` breathes the outer ring while a call is
 * being placed -- the one animated thing on the screen, so it means
 * something: "still trying".
 *
 * `ring` puts the board's dashed ring around it; `remaining` draws the draining
 * arc from a real figure. `dim` is the ended screen: the same person, greyed,
 * rather than a different picture of them.
 *
 * THE BREATH AND THE RING ARE NOT ALTERNATIVES, and for one commit they were:
 * the pulsing view was rendered only inside `{!ring && ...}` while every caller
 * in the app passed both, so the animation drove a value no view consumed and
 * the incoming-call screen -- which had breathed since it was built -- went
 * still. The pulse now renders whenever it is asked for. It expands OUTWARD
 * from the dashed ring and fades, which is a wave rather than the pair of
 * static concentric circles the original guard was written to avoid.
 */
export function AvatarHalo({
  accountId,
  name,
  size = 120,
  pulsing,
  ring,
  measure,
  dim = false,
}: {
  readonly accountId: string;
  readonly name: string;
  readonly size?: number;
  /**
   * REQUIRED AND UNDEFAULTED, all three of these, because each of them is a
   * behaviour that a DROPPED prop turns off silently. `pulsing` defaulted to
   * false is how the incoming-call screen went still and shipped: the prop was
   * removed at the one call site and nothing -- not the type checker, not the
   * suite -- had an opinion. An omission is now a compile error.
   */
  readonly pulsing: boolean;
  readonly ring: boolean;
  /** The draining arc and what it measures, or null for none. See {@link CallRing}. */
  readonly measure: RingMeasure | null;
  readonly dim?: boolean;
}): JSX.Element {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!pulsing) {
      pulse.setValue(0);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1400,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, pulsing]);

  const outer = size + 64;
  const inner = size + 28;
  return (
    <View style={{ width: outer, height: outer, alignItems: 'center', justifyContent: 'center' }}>
      {ring && <CallRing size={outer} measure={measure} dim={dim} />}
      {pulsing ? (
        <Animated.View
          style={[
            styles.haloRing,
            {
              width: outer,
              height: outer,
              borderRadius: outer / 2,
              borderColor: 'rgba(62,201,192,0.16)',
              opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0] }),
              transform: [
                { scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1.12] }) },
              ],
            },
          ]}
        />
      ) : (
        /* A still outer ring only where there is no dashed one: two concentric
           circles a hair apart read as a rendering fault, not a motif. */
        !ring && (
          <View
            style={[
              styles.haloRing,
              {
                width: outer,
                height: outer,
                borderRadius: outer / 2,
                borderColor: 'rgba(62,201,192,0.16)',
              },
            ]}
          />
        )
      )}
      <View
        style={[
          styles.haloRing,
          {
            width: inner,
            height: inner,
            borderRadius: inner / 2,
            borderColor: dim ? 'rgba(141,153,166,0.22)' : 'rgba(62,201,192,0.38)',
          },
        ]}
      />
      <View style={dim ? styles.dimmed : undefined}>
        <AvatarView accountId={accountId} name={name} size={size} />
      </View>
    </View>
  );
}

/**
 * SOMEBODY IS SPEAKING -- five bars, and they move only when that is true.
 *
 * `active` comes from `captionSpeaking` in ../call/callCaption.ts, which is a
 * measurement of the caption stream: a partial caption that arrived recently
 * and has not been finalised. It is NOT a loop, and that is the whole point of
 * the component taking a boolean it cannot fake: an indicator that animates
 * regardless is an app telling somebody their call is working while it is not,
 * which this product has already done for one night.
 *
 * At rest the bars stay, short and grey. Removing them entirely would make the
 * name jump up the screen every time a sentence ended.
 */
export function SpeechIndicator({
  active,
  accessibilityLabel,
}: {
  readonly active: boolean;
  /**
   * WHOSE. The bare word "Speaking" named no mouth, and these bars sit above
   * one particular person's face; the caller says who, because only the caller
   * knows whether the caption behind the measurement was theirs.
   *
   * NULL IS A REAL ANSWER and the bars are then not announced at all: when the
   * caption on screen is this phone's own speech there is no measurement of the
   * peer to report, and "Tunde is quiet" was a fact stated about somebody who
   * may have been talking. See ../call/callScreenModel.ts.
   */
  readonly accessibilityLabel: string | null;
}): JSX.Element {
  const wave = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) {
      wave.stopAnimation(() => wave.setValue(0));
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(wave, {
          toValue: 1,
          duration: 420,
          easing: Easing.inOut(Easing.quad),
          // Heights are a layout property; the native driver cannot carry them.
          useNativeDriver: false,
        }),
        Animated.timing(wave, {
          toValue: 0,
          duration: 420,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: false,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, wave]);

  // Staggered so the bars do not pump in unison, which reads as a progress bar.
  const bars = [
    { rest: 4, peak: 16 },
    { rest: 7, peak: 24 },
    { rest: 5, peak: 11 },
    { rest: 8, peak: 21 },
    { rest: 4, peak: 14 },
  ];
  return (
    <View
      {...(accessibilityLabel === null
        ? { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' as const }
        : { accessibilityLabel, accessibilityRole: 'image' as const })}
      style={styles.waveRow}
    >
      {bars.map((bar, index) => (
        <Animated.View
          key={`${bar.rest}-${index}`}
          style={[
            styles.waveBar,
            {
              backgroundColor: active ? CALL_COLORS.teal : CALL_COLORS.faint,
              height: active
                ? wave.interpolate({
                    inputRange: [0, 1],
                    outputRange: index % 2 === 0 ? [bar.rest, bar.peak] : [bar.peak, bar.rest],
                  })
                : bar.rest,
            },
          ]}
        />
      ))}
    </View>
  );
}

/**
 * THE CAPTION CARD: what was said, and -- nested and inset -- what it became.
 *
 * `translation` is null for an utterance that was never translated, and the
 * nested card is then simply not drawn. There is no placeholder and no
 * "translating…": the caller decides from the wire whether a translation
 * exists (see ../call/callCaption.ts), and a card that promised one while none
 * had arrived would be the same claim as a status line over silence.
 */
export function CaptionCard({
  speaker,
  sourceLabel,
  original,
  translation,
  interim = false,
}: {
  readonly speaker: string;
  /** The spoken language, as a short code for the speaker line. */
  readonly sourceLabel: string;
  readonly original: string;
  readonly translation: { readonly label: string; readonly text: string } | null;
  /** The engine is still revising this utterance. */
  readonly interim?: boolean;
}): JSX.Element {
  return (
    <View style={styles.caption}>
      {/*
        * THE LANGUAGE IS THE PART THAT MUST SURVIVE. This was one line reading
        * `NAME · LANGUAGE` under `numberOfLines={1}`, and RN ellipsises at the
        * tail: "OLUWASEUN ADEBAYO-OGUNLESI · NIGERIAN PIDGIN" is 44 characters
        * against the 35 that fit, so what got cut was the language -- for
        * exactly the users the whole-word label was written for. They are two
        * Texts now: the NAME shrinks and the language does not.
        */}
      <View style={styles.captionSpeakerRow}>
        <View style={styles.captionDot} />
        {speaker.length > 0 && (
          <Text style={styles.captionSpeaker} numberOfLines={1}>
            {speaker.toUpperCase()}
          </Text>
        )}
        <Text style={styles.captionLanguage} numberOfLines={1}>
          {sourceLabel}
        </Text>
      </View>
      <Text style={[styles.captionOriginal, interim && styles.captionInterim]}>{original}</Text>
      {translation !== null && (
        <View style={styles.captionNested}>
          <Text style={styles.captionNestedLabel}>{`TRANSLATION · ${translation.label}`}</Text>
          <Text style={[styles.captionTranslated, interim && styles.captionInterim]}>
            {translation.text}
          </Text>
        </View>
      )}
    </View>
  );
}

/** The ended screen's summary: a small glyph, then a row of facts. */
export function SummaryCard({
  title,
  rows,
}: {
  readonly title: string;
  readonly rows: readonly { readonly label: string; readonly value: string }[];
}): JSX.Element {
  return (
    <View style={styles.summary}>
      <View style={styles.summaryHead}>
        {/* Three ascending strokes: a chart, drawn rather than imported. */}
        <View style={styles.summaryGlyph}>
          <View style={[styles.summaryGlyphBar, { height: 6 }]} />
          <View style={[styles.summaryGlyphBar, { height: 11 }]} />
          <View style={[styles.summaryGlyphBar, { height: 16 }]} />
        </View>
        <Text style={styles.summaryTitle}>{title}</Text>
      </View>
      {rows.map((row) => (
        <View key={row.label} style={styles.summaryRow}>
          <Text style={styles.summaryLabel}>{row.label}</Text>
          <Text style={styles.summaryValue} numberOfLines={1}>
            {row.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** The translucent control panel at the bottom of a call. */
export function GlassDock({ children }: { readonly children: ReactNode }): JSX.Element {
  return <View style={styles.dock}>{children}</View>;
}

/**
 * A round control with a short mark inside and a word beneath. `active` is
 * the ON state (muted, speaker on, camera on) and fills teal.
 */
export function RoundControl({
  mark,
  icon,
  label,
  active = false,
  disabled = false,
  showLabel = true,
  compact = false,
  onPress,
}: {
  /** A short text mark; used when no icon is given. */
  readonly mark?: string;
  /** The glyph, drawn by the caller in the right colour for `active`. */
  readonly icon?: ReactNode;
  readonly label: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  /**
   * WHETHER THE WORD IS DRAWN, decided by how many controls share the row (see
   * `dockLabels` in ../call/callScreenModel.ts). Five labelled controls need
   * 458dp and no portrait phone has it, so the dock wrapped to two rows and
   * took a third of the screen. The label is ALWAYS the accessibility name,
   * drawn or not: this hides a word, never a meaning.
   */
  readonly showLabel?: boolean;
  /**
   * THE NARROW-SCREEN ROW, chosen deliberately rather than fallen into. See
   * `dockCompact` in ../call/callScreenModel.ts: below about 350dp of usable
   * width the five circles no longer fit, and the alternative to shrinking them
   * is `flexWrap` silently making the dock two rows tall again -- which is what
   * took the caption card off the bottom of the screen in the first place. The
   * compact circle is 44dp, which is the touch-target floor and not a point
   * under it.
   */
  readonly compact?: boolean;
  readonly onPress: () => void;
}): JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled }}
      style={({ pressed }) => [
        styles.roundWrap,
        compact && styles.roundWrapCompact,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <View style={[styles.round, compact && styles.roundCompact, active && styles.roundActive]}>
        {icon ?? <Text style={[styles.roundMark, active && styles.roundMarkActive]}>{mark ?? ''}</Text>}
      </View>
      {/* One line, and a bounded one: a long label used to widen its control
          and push the red End button off the right edge of a 360dp screen. */}
      {showLabel && (
        <Text numberOfLines={1} style={styles.roundLabel}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/** The one red control: a round hang-up in the dock, labelled beneath (canon). */
export function EndCallButton({
  label,
  onPress,
  icon,
  disabled = false,
  showLabel = true,
  compact = false,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly icon?: ReactNode;
  /** The request is already in flight; a second press would send a second end. */
  readonly disabled?: boolean;
  /** See {@link RoundControl}. The red circle is never in doubt; the word can go. */
  readonly showLabel?: boolean;
  /** See {@link RoundControl}. Still the biggest circle in the row, and still over 44dp. */
  readonly compact?: boolean;
}): JSX.Element {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.roundWrap,
        compact && styles.roundWrapCompact,
        (pressed || disabled) && styles.pressed,
      ]}
    >
      <View style={[styles.round, styles.end, compact && styles.endCompact]}>
        {icon ?? <Text style={styles.endLabel}>End</Text>}
      </View>
      {showLabel && (
        <Text numberOfLines={1} style={styles.roundLabel}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  ground: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: CALL_COLORS.ground },
  radial: {
    position: 'absolute',
    top: -160,
    alignSelf: 'center',
    width: 560,
    height: 560,
    borderRadius: 280,
    backgroundColor: 'rgba(62,201,192,0.06)',
  },
  orbit: {
    position: 'absolute',
    alignSelf: 'center',
    borderWidth: 1,
  },
  orbitOne: {
    top: 60,
    width: 340,
    height: 340,
    borderRadius: 170,
    borderColor: 'rgba(62,201,192,0.10)',
  },
  orbitTwo: {
    top: -10,
    width: 480,
    height: 480,
    borderRadius: 240,
    borderColor: 'rgba(62,201,192,0.07)',
  },
  orbitThree: {
    top: -90,
    width: 640,
    height: 640,
    borderRadius: 320,
    borderColor: 'rgba(62,201,192,0.045)',
  },

  markRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  markRing: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1.5,
    borderColor: CALL_COLORS.teal,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markText: { color: CALL_COLORS.teal, fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },
  markCaption: { color: CALL_COLORS.muted, fontSize: 12, letterSpacing: 1.2, textTransform: 'uppercase' },

  haloRing: { position: 'absolute', borderWidth: 1 },
  dimmed: { opacity: 0.42 },

  eyebrow: {
    color: CALL_COLORS.muted,
    fontSize: 12,
    letterSpacing: 2.4,
    textTransform: 'uppercase',
    fontWeight: '600',
    textAlign: 'center',
  },

  modePill: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(62,201,192,0.5)',
    backgroundColor: 'rgba(62,201,192,0.08)',
    paddingHorizontal: 14,
    paddingVertical: 5,
  },
  modePillLabel: { color: CALL_COLORS.teal, fontSize: 13, fontWeight: '600' },

  langPill: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(62,201,192,0.45)',
    backgroundColor: 'rgba(62,201,192,0.10)',
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  langPillLabel: {
    color: CALL_COLORS.teal,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.1,
  },

  waveRow: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 26 },
  waveBar: { width: 3, borderRadius: 2 },

  caption: {
    alignSelf: 'stretch',
    marginHorizontal: 6,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: CALL_COLORS.glassEdge,
    backgroundColor: 'rgba(11,18,32,0.78)',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 8,
  },
  captionSpeakerRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  captionDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: CALL_COLORS.teal },
  captionSpeaker: {
    color: CALL_COLORS.teal,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    flexShrink: 1,
  },
  // `flexShrink: 0` is the whole point: the name gives way, the language does not.
  captionLanguage: {
    color: CALL_COLORS.teal,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
    flexShrink: 0,
    opacity: 0.85,
  },
  captionOriginal: { color: CALL_COLORS.text, fontSize: 16, lineHeight: 23 },
  // A partial is not yet what was said; it reads a shade back from a final one.
  captionInterim: { opacity: 0.7 },
  captionNested: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(62,201,192,0.22)',
    backgroundColor: 'rgba(62,201,192,0.07)',
    paddingHorizontal: 13,
    paddingVertical: 11,
    gap: 5,
  },
  captionNestedLabel: {
    color: CALL_COLORS.teal,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  captionTranslated: { color: CALL_COLORS.text, fontSize: 15, lineHeight: 22 },

  summary: {
    alignSelf: 'stretch',
    marginHorizontal: 6,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: CALL_COLORS.glassEdge,
    backgroundColor: 'rgba(11,18,32,0.72)',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 10,
  },
  summaryHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  summaryGlyph: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 16 },
  summaryGlyphBar: { width: 3, borderRadius: 1, backgroundColor: CALL_COLORS.teal },
  summaryTitle: { color: CALL_COLORS.text, fontSize: 15, fontWeight: '600' },
  summaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  summaryLabel: { color: CALL_COLORS.muted, fontSize: 13 },
  summaryValue: { color: CALL_COLORS.text, fontSize: 14, fontWeight: '600', flexShrink: 1 },

  /*
   * THE DOCK IS ONE ROW, AND THAT IS WHERE THE CAPTION CARD'S SPACE CAME FROM.
   *
   * Five controls pinned to 72dp needed 458dp, so no portrait phone got the
   * board's single row: it wrapped to two, cost 224dp -- a third of an 800dp
   * screen -- and the 97dp it grew by is exactly what pushed the caption card
   * off the bottom. The arithmetic now, at 360dp: 360 - 28 (dockWrap) - 2
   * (border) - 32 (padding) = 298dp usable; four 52dp circles, one 56dp red
   * one and four 6dp gaps is 288dp. It fits, with the touch targets still well
   * over the 44dp floor.
   *
   * TEN DP OF MARGIN, AND IT USED TO BE TWO. This comment claimed a 6dp gap
   * while `controlsRow` was rendering 8, so the figure above was eight dp
   * optimistic and the real row measured 358 against 360 -- and below 360dp
   * effective width, which the same handset produces at Android's "Larger"
   * display setting, `flexWrap` took over in silence. The gap is now the 6 this
   * says, and which row is drawn is decided against the MEASURED width rather
   * than a fixed count of controls: see `dockLabels` and `dockCompact` in
   * ../call/callScreenModel.ts, where the figures below are the inputs.
   */
  dock: {
    backgroundColor: CALL_COLORS.glass,
    borderColor: CALL_COLORS.glassEdge,
    borderWidth: 1,
    borderRadius: 28,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 16,
    gap: 16,
  },
  // Bounded at both ends: 52 is the circle and the floor for a touch target, and
  // 88 stops one long word from claiming the width the End button needs.
  roundWrap: { alignItems: 'center', gap: 6, minWidth: 52, maxWidth: 88 },
  round: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(255,255,255,0.09)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The narrow-screen row. 44dp is the touch-target floor, on BOTH axes.
  roundWrapCompact: { minWidth: 44, maxWidth: 72 },
  roundCompact: { width: 44, height: 44, borderRadius: 22 },
  roundActive: { backgroundColor: CALL_COLORS.teal, borderColor: CALL_COLORS.teal },
  roundMark: { color: CALL_COLORS.text, fontSize: 12, fontWeight: '800', letterSpacing: 1.5 },
  roundMarkActive: { color: CALL_COLORS.ground },
  roundLabel: { color: CALL_COLORS.muted, fontSize: 11 },
  end: { backgroundColor: CALL_COLORS.red, borderColor: CALL_COLORS.red, width: 56, height: 56, borderRadius: 28 },
  // Still the biggest circle in the row, and still four dp over the floor.
  endCompact: { width: 48, height: 48, borderRadius: 24 },
  endLabel: { color: '#ffffff', fontSize: 14, fontWeight: '700', letterSpacing: 0.3 },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.4 },
});
