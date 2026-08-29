/** @author masterzee001 */
/**
 * The app's masthead: the C7 mark, the product name, and where you are.
 *
 * Every tab used to start at the top edge with nothing above its content --
 * no name, no mark, no sense of whose app this is. The founder's note
 * (2026-08-29): "the header of each tab feels very bare, no styling or
 * branding". This is the one header, on the same navy ground and teal mark
 * as the call screens, so the tabs and the calls read as one product.
 */
import { type JSX, type ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { CALL_COLORS } from './callTheme';

export function AppHeader({
  title,
  right,
}: {
  /** Where the person is: Chats, Contacts, Conference, Profile. */
  readonly title: string;
  /** An optional control on the right edge. */
  readonly right?: ReactNode;
}): JSX.Element {
  return (
    <View style={styles.header}>
      <View style={styles.glow} pointerEvents="none" />
      <View style={styles.brand}>
        <View style={styles.markRing}>
          <Text style={styles.markText}>C7</Text>
        </View>
        <View>
          <Text style={styles.wordmark}>Videofy Live</Text>
          <Text style={styles.tagline}>by Consummate 7</Text>
        </View>
      </View>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{title}</Text>
        {right}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingTop: 50,
    paddingHorizontal: 20,
    paddingBottom: 12,
    backgroundColor: CALL_COLORS.ground,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(62,201,192,0.14)',
    overflow: 'hidden',
    gap: 14,
  },
  glow: {
    position: 'absolute',
    top: -220,
    right: -120,
    width: 380,
    height: 380,
    borderRadius: 190,
    backgroundColor: 'rgba(62,201,192,0.07)',
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  markRing: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: CALL_COLORS.teal,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(62,201,192,0.08)',
  },
  markText: { color: CALL_COLORS.teal, fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  wordmark: { color: CALL_COLORS.text, fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },
  tagline: { color: CALL_COLORS.faint, fontSize: 10, letterSpacing: 1.4, textTransform: 'uppercase' },
  titleRow: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' },
  title: { color: CALL_COLORS.text, fontSize: 26, fontWeight: '700', letterSpacing: -0.3 },
});
