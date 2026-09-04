/** @author masterzee001 */
/**
 * The incoming direct call: who is calling, in which mode, and two buttons.
 *
 * Shown ONLY after the server confirmed the call is live (the pre-join
 * check) and the ringing acknowledgement was sent -- so "Ringing…" on the
 * caller's side means this screen is actually on somebody's phone. No codes
 * anywhere: a direct call is a person. Same C7 surface as the call itself,
 * so answering does not feel like changing apps.
 */
import { type JSX } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useBottomInset } from '../ui/insets';
import { AvatarHalo, C7Mark, CALL_COLORS, CallBackdrop } from '../ui/callTheme';
import { Icon } from '../ui/icons';

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
  const bottomInset = useBottomInset();
  return (
    <View style={styles.screen}>
      <CallBackdrop />
      <View style={styles.top}>
        <C7Mark caption={mode === 'translated' ? 'Translated call' : 'Incoming call'} />
      </View>
      <View style={styles.identity}>
        <AvatarHalo accountId={caller.accountId} name={caller.name} size={136} pulsing />
        <Text style={styles.name}>{caller.name}</Text>
        <Text style={styles.kicker}>is calling you on C7</Text>
      </View>
      <View style={[styles.actions, { paddingBottom: bottomInset + 40 }]}>
        <View style={styles.action}>
          <Pressable
            onPress={onDecline}
            accessibilityRole="button"
            accessibilityLabel="Decline"
            style={({ pressed }) => [styles.round, styles.decline, pressed && styles.pressed]}
          >
            <Icon name="hangup" size={32} color="#ffffff" />
          </Pressable>
          <Text style={styles.actionLabel}>Decline</Text>
        </View>
        <View style={styles.action}>
          <Pressable
            onPress={onAnswer}
            accessibilityRole="button"
            accessibilityLabel="Answer"
            style={({ pressed }) => [styles.round, styles.answer, pressed && styles.pressed]}
          >
            <Icon name="phone" size={30} color="#ffffff" />
          </Pressable>
          <Text style={styles.actionLabel}>Answer</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: CALL_COLORS.ground, justifyContent: 'space-between' },
  top: { paddingTop: 52, paddingHorizontal: 22 },
  identity: { alignItems: 'center', gap: 8, paddingHorizontal: 28 },
  name: { color: CALL_COLORS.text, fontSize: 30, fontWeight: '700', marginTop: 8, textAlign: 'center' },
  kicker: { color: CALL_COLORS.muted, fontSize: 15 },
  actions: { flexDirection: 'row', justifyContent: 'space-evenly', paddingHorizontal: 24 },
  action: { alignItems: 'center', gap: 10 },
  round: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center' },
  decline: { backgroundColor: CALL_COLORS.red },
  answer: { backgroundColor: '#22a06b' },
  actionLabel: { color: CALL_COLORS.muted, fontSize: 13 },
  pressed: { opacity: 0.8 },
});
