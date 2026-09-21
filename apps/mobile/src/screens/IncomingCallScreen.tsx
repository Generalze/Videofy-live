/** @author masterzee001 */
/**
 * The incoming direct call: who is calling, in which mode, and two buttons.
 *
 * Shown ONLY after the server confirmed the call is live (the pre-join
 * check) and the ringing acknowledgement was sent -- so "Ringing…" on the
 * caller's side means this screen is actually on somebody's phone. No codes
 * anywhere: a direct call is a person. Same C7 surface as the call itself,
 * so answering does not feel like changing apps.
 *
 * TWO THINGS THE FOUNDER'S BOARD ASKS FOR AND THIS SCREEN CANNOT HONESTLY
 * DRAW, both for the same reason: this phone is not in the call yet.
 *
 *   the language pair  `YO -> EN` needs the other seat's speakLanguage and
 *                      this seat's hearLanguage, and both live on `call:state`,
 *                      which only exists after joining. The pre-join wire --
 *                      GET /calls/direct/:callId, see ../call/directCallApi.ts
 *                      -- carries ring, state, mode, callerAccountId and
 *                      callerName, and no language of any kind. The MODE is
 *                      carried and is shown, because the mode is the honest
 *                      half of the same fact: this call will be translated.
 *   "mobile"           the caller's device class is on no wire the handset
 *                      reads. A pill reading "mobile" under every caller would
 *                      be a decoration shaped like a fact.
 *
 * Both are server-side questions and are reported as such rather than filled
 * in with something plausible.
 */
import { type JSX } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useBottomInset } from '../ui/insets';
import { AvatarHalo, C7Mark, CALL_COLORS, CallBackdrop, Eyebrow } from '../ui/callTheme';
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
        {/*
          * THE MARK IS THE PRODUCT, NOT THE CALL. It used to read "Translated
          * call" for a translated call -- word for word what the teal pill 200dp
          * below it says -- and "Incoming call" otherwise, which is word for word
          * the eyebrow directly beneath it. One statement of what kind of call
          * this is, per screen: the eyebrow says it is incoming, the pill says it
          * is translated, and the mark says whose app this is.
          */}
        <C7Mark />
      </View>
      <View style={styles.identity}>
        <Eyebrow>Incoming call</Eyebrow>
        {/* The pulse is the only animated thing on this screen, and when it
            stopped a ringing phone looked frozen. `pulsing` and `ring` are
            required props on AvatarHalo now: dropping either is a compile
            error rather than a silent regression. There is no arc here --
            nothing has measured a deadline before this phone is in the call. */}
        <AvatarHalo
          accountId={caller.accountId}
          name={caller.name}
          size={136}
          pulsing
          ring
          measure={null}
        />
        {/* One line, like every other name on these screens: a long Nigerian
            name at 30pt wrapped to three and pushed the two buttons down. */}
        <Text numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6} style={styles.name}>
          {caller.name}
        </Text>
        <Text style={styles.kicker}>is calling you on C7</Text>
        {/*
          * The MODE, which the pre-join wire does carry. It is not the board's
          * language pill and does not pretend to be: it says the call will be
          * translated, not which way round.
          */}
        {mode === 'translated' && (
          <View style={styles.modePill}>
            <Text style={styles.modePillLabel}>Translated call</Text>
          </View>
        )}
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
  modePill: {
    marginTop: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(62,201,192,0.5)',
    backgroundColor: 'rgba(62,201,192,0.08)',
    paddingHorizontal: 14,
    paddingVertical: 5,
  },
  modePillLabel: { color: CALL_COLORS.teal, fontSize: 13, fontWeight: '600' },
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
