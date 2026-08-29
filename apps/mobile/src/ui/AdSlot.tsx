/** @author masterzee001 */
/**
 * The advert placement: a first-class slot, not an improvised card.
 *
 * RESERVED, SEPARATED, SILENT. It is always the same shape and always
 * labelled Sponsored, sits between sections rather than over content, and
 * never carries sound or motion. Until an advertising source is wired
 * (operator console › Advertising), it shows the house creative -- so the
 * space is designed in from day one instead of being retrofitted.
 */
import { useState, type JSX } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { C7 } from './c7';
import { Icon } from './icons';

export interface AdCreative {
  readonly headline: string;
  readonly body: string;
  readonly cta: string;
  readonly onPress?: () => void;
}

const HOUSE: AdCreative = {
  headline: 'Your message, in every language.',
  body: 'C7 programmes reach audiences in the language they think in.',
  cta: 'Learn more',
};

export function AdSlot({ creative = HOUSE, dismissible = true }: { readonly creative?: AdCreative; readonly dismissible?: boolean }): JSX.Element | null {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <View style={styles.slot} accessibilityLabel="Sponsored">
      <View style={styles.glow} pointerEvents="none" />
      <View style={styles.top}>
        <Text style={styles.label}>Sponsored</Text>
        {dismissible && (
          <Pressable onPress={() => setDismissed(true)} accessibilityRole="button" accessibilityLabel="Hide" hitSlop={8}>
            <Icon name="close" size={16} color={C7.muted} />
          </Pressable>
        )}
      </View>
      <View style={styles.row}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={styles.headline}>{creative.headline}</Text>
          <Text style={styles.body}>{creative.body}</Text>
        </View>
        <Pressable onPress={creative.onPress} accessibilityRole="button" style={({ pressed }) => [styles.cta, pressed && styles.pressed]}>
          <Text style={styles.ctaLabel}>{creative.cta} ›</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  slot: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(62,201,192,0.28)',
    backgroundColor: 'rgba(12, 28, 36, 0.85)',
    padding: 16,
    gap: 10,
    overflow: 'hidden',
  },
  glow: { position: 'absolute', right: -60, top: -60, width: 200, height: 200, borderRadius: 100, backgroundColor: 'rgba(62,201,192,0.08)' },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { color: C7.muted, fontSize: 10, letterSpacing: 1.4, textTransform: 'uppercase' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headline: { color: C7.text, fontSize: 18, fontWeight: '600', fontFamily: 'serif' },
  body: { color: C7.muted, fontSize: 13, lineHeight: 18 },
  cta: { borderRadius: 999, borderWidth: 1, borderColor: C7.teal, paddingHorizontal: 14, paddingVertical: 9 },
  ctaLabel: { color: C7.teal, fontSize: 13, fontWeight: '700' },
  pressed: { opacity: 0.7 },
});
