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
import {
  languagePairLabel,
  languagePairNames,
  type CallLanguagePair,
} from '../call/callLanguages';

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
 * THE LANGUAGE PAIR, as a pill: `YO → EN`.
 *
 * Rendered only where a pair was measured -- the component takes a
 * `CallLanguagePair`, and there is no shape of it meaning "unknown", on
 * purpose. A screen with nothing to show draws no pill; see
 * ../call/callLanguages.ts for where the pair comes from and why the handset's
 * own profile is not allowed to supply it.
 *
 * The codes are what the board asks for and what fits; the screen reader gets
 * the whole names, because "Y O arrow E N" is not a sentence.
 */
export function LanguagePill({ pair }: { readonly pair: CallLanguagePair }): JSX.Element {
  return (
    <View style={styles.langPill}>
      <Text
        accessibilityLabel={`Translating ${languagePairNames(pair)}`}
        style={styles.langPillLabel}
      >
        {languagePairLabel(pair)}
      </Text>
    </View>
  );
}

/**
 * THE RING MOTIF behind the avatar: a dashed outer ring and a solid arc.
 *
 * `progress` is the arc, and it is a MEASUREMENT or it is absent. Given a
 * number in 0..1 the arc sweeps that share of the circle and carries a bright
 * node at its head; given null it draws the board's static quarter-arc, which
 * asserts nothing. There is deliberately no spinning variant: an arc that
 * travels looks like something advancing, and on this screen the only thing
 * that advances is the ring window (see ../call/callTimer.ts `ringProgress`).
 */
export function CallRing({
  size,
  progress = null,
  dim = false,
}: {
  readonly size: number;
  readonly progress?: number | null;
  readonly dim?: boolean;
}): JSX.Element {
  const stroke = 2;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  // Clamped here rather than trusted: a progress computed from two clocks can
  // land outside the circle, and an arc longer than its circle draws a second
  // lap that reads as the deadline having been extended.
  const swept = progress === null ? 0.25 : Math.min(1, Math.max(0, progress));
  const arc = circumference * swept;
  const opacity = dim ? 0.35 : 1;
  // The node sits at the head of the arc: 12 o'clock is -90deg, and the arc is
  // drawn from there clockwise, so the head is swept*360 degrees round.
  const headAngle = (swept * 360 - 90) * (Math.PI / 180);
  const centre = size / 2;
  return (
    <Svg width={size} height={size} style={{ position: 'absolute', opacity }}>
      {/* The dashed outer ring: texture, never a value. */}
      <Circle
        cx={centre}
        cy={centre}
        r={radius}
        stroke="rgba(62,201,192,0.28)"
        strokeWidth={stroke}
        strokeDasharray="3 9"
        fill="none"
      />
      <Circle
        cx={centre}
        cy={centre}
        r={radius}
        stroke={CALL_COLORS.teal}
        strokeWidth={stroke + 1}
        strokeLinecap="round"
        strokeDasharray={`${arc} ${Math.max(0, circumference - arc)}`}
        // -90deg puts the start of the arc at the top of the circle.
        transform={`rotate(-90 ${centre} ${centre})`}
        fill="none"
      />
      {progress !== null && (
        <Circle
          cx={centre + radius * Math.cos(headAngle)}
          cy={centre + radius * Math.sin(headAngle)}
          r={4}
          fill="#ffffff"
        />
      )}
    </Svg>
  );
}

/**
 * The person, in a halo. `pulsing` breathes the outer ring while a call is
 * being placed -- the one animated thing on the screen, so it means
 * something: "still trying".
 *
 * `ring` puts the board's dashed ring and arc around it; `progress` fills that
 * arc from a real figure. `dim` is the ended screen: the same person, greyed,
 * rather than a different picture of them.
 */
export function AvatarHalo({
  accountId,
  name,
  size = 120,
  pulsing = false,
  ring = false,
  progress = null,
  dim = false,
}: {
  readonly accountId: string;
  readonly name: string;
  readonly size?: number;
  readonly pulsing?: boolean;
  readonly ring?: boolean;
  readonly progress?: number | null;
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
      {ring && <CallRing size={outer} progress={progress} dim={dim} />}
      {/* The plain outer ring gives way to the dashed one: two concentric
          circles a hair apart read as a rendering fault, not a motif. */}
      {!ring && (
        <Animated.View
          style={[
            styles.haloRing,
            {
              width: outer,
              height: outer,
              borderRadius: outer / 2,
              borderColor: 'rgba(62,201,192,0.16)',
              opacity: pulsing ? pulse.interpolate({ inputRange: [0, 1], outputRange: [0.9, 0] }) : 1,
              transform: [
                {
                  scale: pulsing
                    ? pulse.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1.12] })
                    : 1,
                },
              ],
            },
          ]}
        />
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
export function SpeechIndicator({ active }: { readonly active: boolean }): JSX.Element {
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
      accessibilityLabel={active ? 'Speaking' : 'Quiet'}
      accessibilityRole="image"
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
      <View style={styles.captionSpeakerRow}>
        <View style={styles.captionDot} />
        <Text style={styles.captionSpeaker} numberOfLines={1}>
          {speaker.length === 0 ? sourceLabel : `${speaker.toUpperCase()} · ${sourceLabel}`}
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
  onPress,
}: {
  /** A short text mark; used when no icon is given. */
  readonly mark?: string;
  /** The glyph, drawn by the caller in the right colour for `active`. */
  readonly icon?: ReactNode;
  readonly label: string;
  readonly active?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}): JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled }}
      style={({ pressed }) => [styles.roundWrap, pressed && styles.pressed, disabled && styles.disabled]}
    >
      <View style={[styles.round, active && styles.roundActive]}>
        {icon ?? <Text style={[styles.roundMark, active && styles.roundMarkActive]}>{mark ?? ''}</Text>}
      </View>
      <Text style={styles.roundLabel}>{label}</Text>
    </Pressable>
  );
}

/** The one red control: a round hang-up in the dock, labelled beneath (canon). */
export function EndCallButton({
  label,
  onPress,
  icon,
  disabled = false,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly icon?: ReactNode;
  /** The request is already in flight; a second press would send a second end. */
  readonly disabled?: boolean;
}): JSX.Element {
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.roundWrap, (pressed || disabled) && styles.pressed]}
    >
      <View style={[styles.round, styles.end]}>{icon ?? <Text style={styles.endLabel}>End</Text>}</View>
      <Text style={styles.roundLabel}>{label}</Text>
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

  dock: {
    backgroundColor: CALL_COLORS.glass,
    borderColor: CALL_COLORS.glassEdge,
    borderWidth: 1,
    borderRadius: 28,
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 18,
    gap: 16,
  },
  roundWrap: { alignItems: 'center', gap: 8, minWidth: 72 },
  round: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: 'rgba(255,255,255,0.09)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundActive: { backgroundColor: CALL_COLORS.teal, borderColor: CALL_COLORS.teal },
  roundMark: { color: CALL_COLORS.text, fontSize: 12, fontWeight: '800', letterSpacing: 1.5 },
  roundMarkActive: { color: CALL_COLORS.ground },
  roundLabel: { color: CALL_COLORS.muted, fontSize: 12 },
  end: { backgroundColor: CALL_COLORS.red, borderColor: CALL_COLORS.red, width: 68, height: 68, borderRadius: 34 },
  endLabel: { color: '#ffffff', fontSize: 14, fontWeight: '700', letterSpacing: 0.3 },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.4 },
});
