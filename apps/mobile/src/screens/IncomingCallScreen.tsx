/** @author masterzee001 */
/**
 * The incoming direct call: who is calling, in which mode, and two buttons.
 *
 * Shown ONLY after the server confirmed the call is live (the pre-join
 * check) and the ringing acknowledgement was sent -- so "Ringing…" on the
 * caller's side means this screen is actually on somebody's phone. No codes
 * anywhere: a direct call is a person.
 */
import { type JSX } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AvatarView } from '../media/AvatarView';

export interface IncomingCallScreenProps {
  readonly caller: { readonly accountId: string; readonly name: string };
  readonly mode: 'normal' | 'translated';
  readonly onAnswer: () => void;
  readonly onDecline: () => void;
}

export function IncomingCallScreen({
  caller,
  mode,
  onAnswer,
  onDecline,
}: IncomingCallScreenProps): JSX.Element {
  return (
    <View style={styles.screen}>
      <View style={styles.identity}>
        <AvatarView accountId={caller.accountId} name={caller.name} size={128} />
        <Text style={styles.name}>{caller.name}</Text>
        <Text style={styles.kicker}>Incoming C7 call</Text>
        <Text style={styles.mode}>{mode === 'translated' ? 'Translated call' : 'Normal call'}</Text>
      </View>
      <View style={styles.actions}>
        <Pressable
          onPress={onDecline}
          accessibilityRole="button"
          style={({ pressed }) => [styles.button, styles.decline, pressed && styles.pressed]}
        >
          <Text style={styles.buttonLabel}>Decline</Text>
        </Pressable>
        <Pressable
          onPress={onAnswer}
          accessibilityRole="button"
          style={({ pressed }) => [styles.button, styles.answer, pressed && styles.pressed]}
        >
          <Text style={styles.buttonLabel}>Answer</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#0b0f14',
    justifyContent: 'space-between',
    paddingTop: 96,
    paddingBottom: 72,
    paddingHorizontal: 32,
  },
  identity: { alignItems: 'center', gap: 12 },
  name: { color: '#e4ebf1', fontSize: 28, fontWeight: '700', marginTop: 8 },
  kicker: { color: '#8d99a6', fontSize: 14 },
  mode: { color: '#3ec9c0', fontSize: 14, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 16 },
  button: { flex: 1, borderRadius: 16, paddingVertical: 18, alignItems: 'center' },
  decline: { backgroundColor: '#4a1f1f' },
  answer: { backgroundColor: '#12503f' },
  pressed: { opacity: 0.8 },
  buttonLabel: { color: '#e4ebf1', fontSize: 17, fontWeight: '700' },
});
