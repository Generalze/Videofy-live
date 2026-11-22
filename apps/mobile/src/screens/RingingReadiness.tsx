/** @author masterzee001 */
/**
 * The right to wake, on screen: what Android was READ as saying, the one
 * request the platform allows, and the honest limit of what any app can do.
 *
 * Two surfaces share one body. The BANNER sits at the top of Chats -- the
 * first screen after sign-in, once this phone is registered for pushes, which
 * is the moment the request makes sense: the phone can now be pushed, and
 * this is the remaining reason it might not wake. The ROW on the profile
 * (profileRows.tsx) shows the same reading whenever somebody looks.
 *
 * NOTHING HERE PROMISES A RINGING PHONE. The words come from
 * push/ringingReadiness, which derives them from a reading and, for the
 * vendors that run a second battery manager, says that no app can reach it.
 *
 * TWO THINGS, DECIDED SEPARATELY (push/ringingReadiness): the REQUEST is
 * offered while the exemption is missing or could not be read; the VENDOR
 * SENTENCE is drawn on a vendor phone whatever the exemption says, because
 * granting it changes nothing about that setting.
 */
import type { JSX } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { readinessWords, shouldNameVendorSetting, shouldOfferExemption, type RingingReadiness } from '../push/ringingReadiness';
import { C7, GlassCard } from '../ui/c7';

export interface RingingReadinessActions {
  /** Ask Android; the answer is re-read on the next foreground, never assumed. */
  readonly onAllow: () => void;
  /** The app's own settings page, the nearest a link can get to the vendor's battery manager. */
  readonly onOpenSettings: () => void;
}

export function RingingReadinessBody({ readiness, onAllow, onOpenSettings }: RingingReadinessActions & { readonly readiness: RingingReadiness }): JSX.Element {
  const words = readinessWords(readiness);
  return (
    <View style={styles.body}>
      <Text style={words.tone === 'warn' ? styles.warn : styles.hint}>{words.detail}</Text>
      {words.bucketLine !== null && <Text style={styles.hint}>{words.bucketLine}</Text>}
      {shouldOfferExemption(readiness) && (
        <Pressable onPress={onAllow} accessibilityRole="button" accessibilityLabel="Allow background use" style={[styles.smallButton, styles.selfStart]}>
          <Text style={styles.smallButtonLabel}>Allow background use</Text>
        </Pressable>
      )}
      {shouldNameVendorSetting(readiness) && words.vendorLine !== null && (
        <>
          <Text style={styles.warn}>{words.vendorLine}</Text>
          <Pressable onPress={onOpenSettings} accessibilityRole="button" accessibilityLabel="Open app settings" style={styles.quiet}>
            <Text style={styles.quietLabel}>Open app settings</Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

/**
 * The card above Chats. Drawn while the request or the vendor sentence has
 * something to say and the person has not said not now
 * (push/ringingReadiness.shouldShowRingingBanner decides; App.tsx obeys).
 * The headline is the measured fact.
 */
export function RingingBanner({ readiness, onAllow, onOpenSettings, onDismiss }: RingingReadinessActions & { readonly readiness: RingingReadiness; readonly onDismiss: () => void }): JSX.Element {
  const words = readinessWords(readiness);
  return (
    <GlassCard accent style={styles.banner}>
      <Text style={styles.title}>{words.headline}</Text>
      <RingingReadinessBody readiness={readiness} onAllow={onAllow} onOpenSettings={onOpenSettings} />
      <Pressable onPress={onDismiss} accessibilityRole="button" accessibilityLabel="Not now" style={styles.quiet}>
        <Text style={styles.quietLabel}>Not now</Text>
      </Pressable>
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  banner: { marginHorizontal: 16, marginTop: 12, gap: 8 },
  body: { gap: 8 },
  title: { color: C7.text, fontSize: 17, fontWeight: '600', fontFamily: 'serif', lineHeight: 23 },
  hint: { color: C7.muted, fontSize: 13, lineHeight: 19 },
  warn: { color: C7.amber, fontSize: 13, lineHeight: 19 },
  smallButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 14, borderRadius: 12, backgroundColor: C7.tealDeep, borderWidth: 1, borderColor: 'rgba(62,201,192,0.7)', minHeight: 44 },
  selfStart: { alignSelf: 'flex-start', paddingVertical: 9 },
  smallButtonLabel: { color: '#ffffff', fontSize: 13, fontWeight: '700' },
  quiet: { paddingHorizontal: 10, paddingVertical: 8, alignSelf: 'flex-start' },
  quietLabel: { color: C7.muted, fontSize: 13 },
});
