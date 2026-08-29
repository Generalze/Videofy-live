/** @author masterzee001 */
/**
 * The brand screen the phone opens on.
 *
 * Founder ruling (29 Aug 2026): "deep dark/navy background with subtle
 * premium gradient; centered C7 logo; below it Videofy Live; below that:
 * Speak naturally. Be understood everywhere.; optional subtle loading
 * indicator near the bottom. Show immediately on startup while
 * resources/session load; transition smoothly once ready; no flash of plain
 * white; works on Android physical builds."
 *
 * HOW THE HAND-OFF STAYS INVISIBLE. The OS splash (expo-splash-screen, app.json)
 * is a flat SPLASH_GROUND with the launcher logo at BOOT_MARK_WIDTH dp in the
 * centre. This screen's first frame is exactly that: the same flat colour, the
 * same PNG, the same width, the same centre, with the image's Android fade
 * switched off. App hides the native splash from `onFirstFrame`, which fires
 * once the mark has actually decoded, so the swap changes no pixel. Only then
 * do the C7 ground's illumination, the words and the indicator fade in.
 *
 * HOW IT LEAVES. When `status` leaves the boot phase the screen waits out the
 * remainder of MINIMUM_BOOT_VISIBLE_MS (a fast session check must not blink),
 * fades its mark and words back to bare ground, then calls `onReady`. App
 * replaces it with the next screen, which stands on the same C7Ground, so the
 * cut is ground-to-ground.
 */
import { useEffect, useRef, type JSX } from 'react';
import { ActivityIndicator, Animated, Easing, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import {
  BOOT_MARK_WIDTH,
  BRAND_NAME,
  MINIMUM_BOOT_VISIBLE_MS,
  SPLASH_GROUND,
  TAGLINE,
  bootExitDelayMs,
  bootPhaseWords,
  isBootPhase,
  type BootStatus,
} from '../boot/bootCopy';
import { C7, C7BrandMark, C7Ground } from '../ui/c7';
import { useBottomInset } from '../ui/insets';

export interface BootScreenProps {
  /** The session layer's status; the screen shows while it is a boot phase. */
  readonly status: BootStatus;
  /**
   * Fires once, when the mark has drawn (or, as a floor, shortly after mount
   * so a broken drawable can never strand the app behind the OS splash).
   * Hide the native splash here.
   */
  readonly onFirstFrame?: (() => void) | undefined;
  /** Fires once, after the exit fade, when the app may replace this screen. */
  readonly onReady?: (() => void) | undefined;
  /** Override the hold for tests or a founder who wants it shorter. */
  readonly minimumVisibleMs?: number | undefined;
}

/** If the image never reports, hide the splash anyway after this long. */
const FIRST_FRAME_FLOOR_MS = 600;
const REVEAL_MS = 480;
const EXIT_MS = 260;

/** The logo sits in the middle of its square; its visual bottom edge is ~50dp below centre. */
const WORDS_BELOW_CENTRE = BOOT_MARK_WIDTH * 0.25 + 22;

export function BootScreen({ status, onFirstFrame, onReady, minimumVisibleMs = MINIMUM_BOOT_VISIBLE_MS }: BootScreenProps): JSX.Element {
  const { height } = useWindowDimensions();
  const bottomInset = useBottomInset();
  const mountedAt = useRef(Date.now());
  const reveal = useRef(new Animated.Value(0)).current;
  const markOpacity = useRef(new Animated.Value(1)).current;
  const firstFrameSent = useRef(false);
  const leaving = useRef(false);
  // Latest callbacks, so timers armed earlier never call a stale closure.
  const callbacks = useRef({ onFirstFrame, onReady });
  callbacks.current = { onFirstFrame, onReady };

  const markDrawn = (): void => {
    if (firstFrameSent.current) return;
    firstFrameSent.current = true;
    callbacks.current.onFirstFrame?.();
  };

  useEffect(() => {
    const floor = setTimeout(markDrawn, FIRST_FRAME_FLOOR_MS);
    Animated.timing(reveal, { toValue: 1, duration: REVEAL_MS, delay: 60, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    return () => clearTimeout(floor);
    // Mount only: the reveal plays once, whatever status does afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (isBootPhase(status) || leaving.current) return;
    leaving.current = true;
    const hold = setTimeout(() => {
      Animated.parallel([
        Animated.timing(reveal, { toValue: 0, duration: EXIT_MS, easing: Easing.in(Easing.quad), useNativeDriver: true }),
        Animated.timing(markOpacity, { toValue: 0, duration: EXIT_MS, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      ]).start(({ finished }) => {
        // An interrupted animation (unmount mid-fade) must still let the app move on.
        if (finished || leaving.current) callbacks.current.onReady?.();
      });
    }, bootExitDelayMs(mountedAt.current, Date.now(), minimumVisibleMs));
    return () => clearTimeout(hold);
  }, [status, minimumVisibleMs, reveal, markOpacity]);

  const wordsRise = reveal.interpolate({ inputRange: [0, 1], outputRange: [8, 0] });

  return (
    <View style={styles.root}>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: reveal }]}>
        <C7Ground />
      </Animated.View>
      <StatusBar style="light" />
      <View pointerEvents="none" style={styles.centre}>
        <Animated.View style={{ opacity: markOpacity }}>
          <C7BrandMark width={BOOT_MARK_WIDTH} onLoad={markDrawn} onError={markDrawn} />
        </Animated.View>
      </View>
      <Animated.View pointerEvents="none" style={[styles.words, { top: height / 2 + WORDS_BELOW_CENTRE, opacity: reveal, transform: [{ translateY: wordsRise }] }]}>
        <Text style={styles.brand} accessibilityRole="header">
          {BRAND_NAME}
        </Text>
        <Text style={styles.tagline}>{TAGLINE}</Text>
      </Animated.View>
      <Animated.View pointerEvents="none" style={[styles.foot, { paddingBottom: bottomInset + 28, opacity: reveal }]}>
        <ActivityIndicator color={C7.teal} size="small" />
        <Text style={styles.phase}>{bootPhaseWords(status)}</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  // The flat splash colour first; the C7 ground fades in over it.
  root: { flex: 1, backgroundColor: SPLASH_GROUND },
  centre: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  words: { position: 'absolute', left: 24, right: 24, alignItems: 'center', gap: 8 },
  brand: { color: C7.text, fontSize: 28, fontWeight: '600', fontFamily: 'serif', letterSpacing: -0.3, textAlign: 'center' },
  tagline: { color: C7.muted, fontSize: 15, textAlign: 'center', lineHeight: 21 },
  foot: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', gap: 10 },
  phase: { color: C7.faint, fontSize: 12, letterSpacing: 0.2 },
});
