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
import { AvatarView } from '../media/AvatarView';

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
 * The person, in a halo. `pulsing` breathes the outer ring while a call is
 * being placed -- the one animated thing on the screen, so it means
 * something: "still trying".
 */
export function AvatarHalo({
  accountId,
  name,
  size = 120,
  pulsing = false,
}: {
  readonly accountId: string;
  readonly name: string;
  readonly size?: number;
  readonly pulsing?: boolean;
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
                scale: pulsing ? pulse.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1.12] }) : 1,
              },
            ],
          },
        ]}
      />
      <View
        style={[
          styles.haloRing,
          { width: inner, height: inner, borderRadius: inner / 2, borderColor: 'rgba(62,201,192,0.38)' },
        ]}
      />
      <AvatarView accountId={accountId} name={name} size={size} />
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
  label,
  active = false,
  disabled = false,
  onPress,
}: {
  readonly mark: string;
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
        <Text style={[styles.roundMark, active && styles.roundMarkActive]}>{mark}</Text>
      </View>
      <Text style={styles.roundLabel}>{label}</Text>
    </Pressable>
  );
}

/** The one red button. */
export function EndCallButton({
  label,
  onPress,
}: {
  readonly label: string;
  readonly onPress: () => void;
}): JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.end, pressed && styles.pressed]}
    >
      <Text style={styles.endLabel}>{label}</Text>
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
  end: {
    backgroundColor: CALL_COLORS.red,
    borderRadius: 999,
    paddingVertical: 16,
    alignItems: 'center',
  },
  endLabel: { color: '#ffffff', fontSize: 16, fontWeight: '700', letterSpacing: 0.3 },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.4 },
});
