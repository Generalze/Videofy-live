/** @author masterzee001 */
/**
 * The advert placement: a first-class slot, not an improvised card.
 *
 * RESERVED, SEPARATED, SILENT. It is always the same shape and always
 * labelled Sponsored, sits between sections rather than over content, and
 * never carries sound or motion.
 *
 * THE SHARED, SERIALISABLE CONTRACT. This file used to declare its own
 * `AdCreative` carrying an `onPress` CALLBACK -- which cannot be sent over a
 * wire, so no server could ever have supplied one. A creative now arrives from
 * the delivery endpoint like any other data, and the destination is an https
 * address the service already validated.
 *
 * THE SERVICE DECIDES WHICH CREATIVE THIS IS. What arrives is the EFFECTIVE
 * one: the programme's own when it is enabled and inside its window, otherwise
 * the house creative. This component does not evaluate a schedule, because a
 * phone with a wrong date would otherwise run an advert outside the period it
 * was sold for.
 */
import { useState, type JSX } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { HOUSE_CREATIVE, type SponsoredCreative } from '@videofy-live/shared-types';
import { creativeOpener } from '../sponsoredDelivery';
import { C7 } from './c7';
import { Icon } from './icons';

export type { SponsoredCreative };

export function AdSlot({ creative = HOUSE_CREATIVE, dismissible = true }: { readonly creative?: SponsoredCreative; readonly dismissible?: boolean }): JSX.Element | null {
  const [dismissed, setDismissed] = useState(false);
  const href = creative.href;

  /*
   * NO LINK MEANS NO PRESS HANDLER. A button that responds to a tap by doing
   * nothing reads as broken; without a destination the call to action is plain
   * text, exactly as it is on the web.
   *
   * A FAILED OPEN MUST NOT TAKE THE PROGRAMME DOWN. `openURL` rejects when
   * nothing can handle the address, and an unhandled rejection here would crash
   * a listener out of a live programme over an advert.
   */
  const open = creativeOpener(href, (url) => Linking.openURL(url)) ?? undefined;

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
        {open === undefined ? (
          <View style={styles.cta}>
            <Text style={styles.ctaLabel}>{creative.cta} ›</Text>
          </View>
        ) : (
          <Pressable onPress={open} accessibilityRole="button" style={({ pressed }) => [styles.cta, pressed && styles.pressed]}>
            <Text style={styles.ctaLabel}>{creative.cta} ›</Text>
          </Pressable>
        )}
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
