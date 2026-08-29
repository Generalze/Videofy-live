/** @author masterzee001 */
/**
 * The C7 visual system for the phone -- the canon (docs/design/mobile app
 * canon design, 29 Aug 2026) rendered as primitives every screen shares.
 *
 * ONE GROUND. Deep navy-black, a soft teal illumination top-left, and a
 * faint orbital texture on the right edge: the same on Chats, People,
 * Programmes, Conference, Profile and the call itself, so moving between
 * them reads as staying inside one product. Nothing here is a library
 * beyond react-native-svg, which draws the mark and the orbits exactly.
 *
 * THE MARK IS THE WEBSITE FAVICON. The same two strokes as
 * apps/ecosystem-web/public/c7-mark.svg (the C arc, the 7), so the icon in
 * the tab bar, the header and the browser are one identity.
 *
 * GLASS, NOT PANELS. Cards are translucent over the ground with a hairline
 * edge; the ground shows through and the illumination survives, which is
 * what keeps the screens from collapsing back into flat black rectangles.
 */
import { type JSX, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, Ellipse, Path, RadialGradient, Rect, Stop } from 'react-native-svg';

export const C7 = {
  ground: '#070b12',
  navy: '#0b1220',
  panel: 'rgba(14, 22, 36, 0.72)',
  panelEdge: 'rgba(120, 200, 200, 0.12)',
  panelEdgeStrong: 'rgba(62, 201, 192, 0.35)',
  teal: '#3ec9c0',
  tealDeep: '#128a84',
  tealSoft: 'rgba(62,201,192,0.12)',
  text: '#eef3f7',
  muted: '#8d99a6',
  faint: '#5d6874',
  red: '#e0453a',
  green: '#2ecc8a',
  amber: '#e0a43a',
  live: '#1f8f5f',
} as const;

/** The favicon's two strokes, at any size. */
export function C7Mark({ size = 34, tile = false }: { readonly size?: number; readonly tile?: boolean }): JSX.Element {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      {tile && <Rect width="64" height="64" rx="14" fill="#0a0d14" />}
      <Path d="M45.5 17.6 A19.8 19.8 0 1 0 45.5 46.4" fill="none" stroke="#93a1bd" strokeWidth="7.5" strokeLinecap="square" />
      <Path d="M34.5 17.6 H52 L40 50" fill="none" stroke="#ffffff" strokeWidth="7.5" strokeLinejoin="miter" strokeLinecap="square" />
    </Svg>
  );
}

/** The mark with the canon's teal orbit ring behind it (the header lockup). */
export function C7Lockup({ size = 40 }: { readonly size?: number }): JSX.Element {
  const orbit = size + 14;
  return (
    <View style={{ width: orbit, height: orbit, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={orbit} height={orbit} viewBox="0 0 100 100" style={StyleSheet.absoluteFill}>
        <Circle cx="50" cy="50" r="46" stroke="rgba(62,201,192,0.55)" strokeWidth="1.2" fill="none" strokeDasharray="120 60" />
        <Circle cx="50" cy="50" r="40" stroke="rgba(62,201,192,0.22)" strokeWidth="1" fill="none" strokeDasharray="40 110" />
        <Circle cx="22" cy="30" r="1.6" fill="#3ec9c0" />
      </Svg>
      <C7Mark size={size} />
    </View>
  );
}

/**
 * The ground every screen stands on. Absolute-fill; put it first in a
 * screen's tree. The illumination is a radial gradient, the texture an
 * orbital set clipped to the right edge, exactly as the canon frames show.
 */
export function C7Ground(): JSX.Element {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={styles.ground} />
      <Svg width="100%" height="100%" style={StyleSheet.absoluteFill} viewBox="0 0 400 900" preserveAspectRatio="xMidYMin slice">
        <Defs>
          <RadialGradient id="glow" cx="18%" cy="8%" r="55%">
            <Stop offset="0" stopColor="#1d6d70" stopOpacity="0.55" />
            <Stop offset="0.5" stopColor="#0f3a42" stopOpacity="0.22" />
            <Stop offset="1" stopColor="#070b12" stopOpacity="0" />
          </RadialGradient>
          <RadialGradient id="floor" cx="50%" cy="100%" r="60%">
            <Stop offset="0" stopColor="#1a5a62" stopOpacity="0.28" />
            <Stop offset="1" stopColor="#070b12" stopOpacity="0" />
          </RadialGradient>
        </Defs>
        <Rect width="400" height="900" fill="url(#glow)" />
        <Rect width="400" height="900" fill="url(#floor)" />
        <Ellipse cx="470" cy="420" rx="230" ry="300" stroke="rgba(62,201,192,0.16)" strokeWidth="1" fill="none" />
        <Ellipse cx="480" cy="440" rx="170" ry="230" stroke="rgba(62,201,192,0.11)" strokeWidth="1" fill="none" />
        <Ellipse cx="490" cy="460" rx="110" ry="160" stroke="rgba(62,201,192,0.08)" strokeWidth="1" fill="none" />
        <Path d="M300 40 Q 420 200 330 420" stroke="rgba(62,201,192,0.10)" strokeWidth="1" fill="none" />
        <Circle cx="372" cy="300" r="1.6" fill="rgba(140,230,225,0.8)" />
        <Circle cx="342" cy="520" r="1.2" fill="rgba(140,230,225,0.6)" />
        <Circle cx="388" cy="640" r="1.4" fill="rgba(140,230,225,0.5)" />
      </Svg>
    </View>
  );
}

/** A translucent card with a hairline edge. `accent` lights the edge teal. */
export function GlassCard({
  children,
  style,
  accent = false,
  padded = true,
}: {
  readonly children: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
  readonly accent?: boolean;
  readonly padded?: boolean;
}): JSX.Element {
  return (
    <View style={[styles.card, accent && styles.cardAccent, padded && styles.cardPadded, style]}>
      {children}
    </View>
  );
}

/** Section heading with an optional trailing action ("See all ›"). */
export function SectionHeading({
  title,
  action,
  onAction,
  subtitle,
}: {
  readonly title: string;
  readonly action?: string | undefined;
  readonly onAction?: (() => void) | undefined;
  readonly subtitle?: string | undefined;
}): JSX.Element {
  return (
    <View style={styles.sectionRow}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {subtitle !== undefined && <Text style={styles.sectionSubtitle}>{subtitle}</Text>}
      </View>
      {action !== undefined && (
        <Pressable onPress={onAction} accessibilityRole="button" hitSlop={8}>
          <Text style={styles.sectionAction}>{action} ›</Text>
        </Pressable>
      )}
    </View>
  );
}

/** Pill chip: filters, language tags, tiers. */
export function Chip({
  label,
  active = false,
  tone = 'neutral',
  onPress,
  trailing,
}: {
  readonly label: string;
  readonly active?: boolean;
  readonly tone?: 'neutral' | 'teal' | 'live' | 'danger' | 'amber';
  readonly onPress?: () => void;
  readonly trailing?: ReactNode;
}): JSX.Element {
  const body = (
    <View style={[styles.chip, active && styles.chipActive, tone === 'live' && styles.chipLive, tone === 'danger' && styles.chipDanger, tone === 'amber' && styles.chipAmber, tone === 'teal' && styles.chipTeal]}>
      <Text style={[styles.chipLabel, active && styles.chipLabelActive, (tone === 'live' || tone === 'danger') && styles.chipLabelOnColor, tone === 'teal' && styles.chipLabelTeal, tone === 'amber' && styles.chipLabelAmber]}>
        {label}
      </Text>
      {trailing}
    </View>
  );
  if (onPress === undefined) return body;
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: active }} style={({ pressed }) => pressed && styles.pressed}>
      {body}
    </Pressable>
  );
}

/** The wide teal primary button. */
export function PrimaryButton({
  label,
  onPress,
  disabled = false,
  leading,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly leading?: ReactNode;
}): JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={({ pressed }) => [styles.primary, disabled && styles.primaryDisabled, pressed && !disabled && styles.pressed]}
    >
      {leading}
      <Text style={styles.primaryLabel}>{label}</Text>
    </Pressable>
  );
}

/** A quiet round icon button (Message / Call beside a person). */
export function RoundIconButton({
  children,
  label,
  onPress,
  tone = 'neutral',
  size = 44,
}: {
  readonly children: ReactNode;
  readonly label: string;
  readonly onPress: () => void;
  readonly tone?: 'neutral' | 'teal';
  readonly size?: number;
}): JSX.Element {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [styles.roundWrap, pressed && styles.pressed]}>
      <View style={[styles.round, { width: size, height: size, borderRadius: size / 2 }, tone === 'teal' && styles.roundTeal]}>{children}</View>
      <Text style={styles.roundLabel}>{label}</Text>
    </Pressable>
  );
}

/** Presence dot: green active, amber busy, grey away. */
export function PresenceDot({ state, size = 10 }: { readonly state: 'active' | 'busy' | 'away'; readonly size?: number }): JSX.Element {
  const color = state === 'active' ? C7.green : state === 'busy' ? C7.amber : C7.faint;
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, borderWidth: 2, borderColor: C7.ground }} />;
}

const styles = StyleSheet.create({
  ground: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: C7.ground },
  card: {
    backgroundColor: C7.panel,
    borderWidth: 1,
    borderColor: C7.panelEdge,
    borderRadius: 18,
  },
  cardAccent: { borderColor: C7.panelEdgeStrong },
  cardPadded: { padding: 16 },
  sectionRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 12, paddingHorizontal: 2 },
  sectionTitle: { color: C7.text, fontSize: 21, fontWeight: '600', fontFamily: 'serif', letterSpacing: -0.2 },
  sectionSubtitle: { color: C7.muted, fontSize: 13 },
  sectionAction: { color: C7.teal, fontSize: 14, fontWeight: '600' },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: C7.panelEdge,
    backgroundColor: 'rgba(255,255,255,0.04)',
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  chipActive: { backgroundColor: C7.tealDeep, borderColor: C7.teal },
  chipTeal: { backgroundColor: C7.tealSoft, borderColor: 'rgba(62,201,192,0.35)' },
  chipLive: { backgroundColor: C7.live, borderColor: C7.live, paddingVertical: 3, paddingHorizontal: 8 },
  chipDanger: { backgroundColor: '#7a2320', borderColor: '#7a2320', paddingVertical: 3, paddingHorizontal: 8 },
  chipAmber: { backgroundColor: 'rgba(224,164,58,0.14)', borderColor: 'rgba(224,164,58,0.4)', paddingVertical: 3, paddingHorizontal: 8 },
  chipLabel: { color: C7.text, fontSize: 13, fontWeight: '600' },
  chipLabelActive: { color: '#ffffff' },
  chipLabelOnColor: { color: '#ffffff', fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase' },
  chipLabelTeal: { color: C7.teal, fontSize: 12 },
  chipLabelAmber: { color: C7.amber, fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase' },
  primary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: C7.tealDeep,
    borderWidth: 1,
    borderColor: 'rgba(62,201,192,0.7)',
    borderRadius: 999,
    paddingVertical: 15,
  },
  primaryDisabled: { opacity: 0.45 },
  primaryLabel: { color: '#ffffff', fontSize: 16, fontWeight: '600' },
  roundWrap: { alignItems: 'center', gap: 6 },
  round: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  roundTeal: { backgroundColor: C7.tealSoft, borderColor: 'rgba(62,201,192,0.45)' },
  roundLabel: { color: C7.muted, fontSize: 12 },
  pressed: { opacity: 0.75 },
});
