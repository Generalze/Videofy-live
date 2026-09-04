/** @author masterzee001 */
/**
 * The masthead, to canon: the C7 mark on the left (the website favicon's
 * two strokes inside the teal orbit), the place you are beside it, and
 * C7 Streams on the right -- the one link that is on every tab because
 * discovery is the product's front door. No tagline, nothing else.
 */
import { type JSX, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { C7, C7Lockup } from './c7';

export function AppHeader({
  title,
  onStreams,
  streamsActive = false,
  right,
}: {
  /** Where the person is: Chats, People, Conference, Profile. */
  readonly title: string;
  /** Opens the C7 Streams discovery surface. */
  readonly onStreams: () => void;
  /** On the Streams surface itself the link becomes the title. */
  readonly streamsActive?: boolean;
  /** An optional control before the Streams link (add person, settings). */
  readonly right?: ReactNode;
}): JSX.Element {
  return (
    <View style={styles.header}>
      <View style={styles.left}>
        <C7Lockup size={34} />
        {!streamsActive && (
          <>
            <View style={styles.divider} />
            <Text style={styles.title} numberOfLines={1}>
              {title}
            </Text>
          </>
        )}
      </View>
      <View style={styles.right}>
        {right}
        <Pressable
          onPress={onStreams}
          accessibilityRole="button"
          accessibilityLabel="C7 Streams"
          hitSlop={8}
          style={({ pressed }) => pressed && styles.pressed}
        >
          <Text style={[styles.streams, streamsActive && styles.streamsActive]}>
            <Text style={styles.streamsC7}>C7 </Text>Streams
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingTop: 50,
    paddingHorizontal: 18,
    paddingBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  left: { flexDirection: 'row', alignItems: 'center', gap: 12, flexShrink: 1 },
  divider: { width: 1, height: 26, backgroundColor: 'rgba(255,255,255,0.18)' },
  title: { color: C7.text, fontSize: 24, fontWeight: '600', fontFamily: 'serif', letterSpacing: -0.2, flexShrink: 1 },
  right: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  streams: { color: C7.teal, fontSize: 18, fontWeight: '600', fontFamily: 'serif' },
  streamsActive: { fontSize: 24 },
  streamsC7: { color: C7.text },
  pressed: { opacity: 0.7 },
});
