/** @author masterzee001 */
/**
 * What a signed-in phone can prove about itself.
 *
 * This is the screen the pre-auth diagnostic was standing in for. The three
 * checks it ran -- reachable, permitted, token issued -- are now preconditions
 * rather than the point: what matters here is whether the server has actually
 * bound this device to this account, which is the last link in the chain and
 * the only one that needs a session.
 *
 * IT STATES REGISTRATION FAILURES BY NAME, for the same reason the pre-auth
 * screen did. `permission-denied` is a choice, `unauthorized` means the session
 * ended, `rejected` means the server refused this device, `network` is none of
 * those. One "could not register" would collapse four different fixes into a
 * dead end.
 *
 * NEITHER THE SESSION TOKEN NOR THE PUSH TOKEN APPEARS HERE. Not truncated, not
 * as a length, not behind a "show" toggle. There is no diagnostic worth a
 * credential in a screenshot.
 */
import { useCallback, useState, type JSX } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { RegistrationOutcome } from '../push/deviceRegistrationService';

const EXPLANATION: Record<Extract<RegistrationOutcome, { ok: false }>['reason'], string> = {
  'not-signed-in': 'The session ended before the device could be registered.',
  'permission-denied':
    'Notifications are turned off for this app. Calls will not ring until they are allowed in Android settings.',
  'no-token':
    'Firebase did not issue a token for this build. This is a build or configuration problem, not a permission one.',
  unauthorized: 'The session was rejected. Sign in again.',
  rejected: 'The server would not accept this device.',
  network: 'Could not reach Videofy from this phone.',
};

export interface HomeScreenProps {
  readonly accountId: string;
  readonly onRegister: () => Promise<RegistrationOutcome>;
  readonly onSignOut: () => Promise<void>;
}

export function HomeScreen({ accountId, onRegister, onSignOut }: HomeScreenProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<RegistrationOutcome | null>(null);

  const register = useCallback(async () => {
    setBusy(true);
    try {
      setOutcome(await onRegister());
    } finally {
      setBusy(false);
    }
  }, [onRegister]);

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.brand}>CONSUMMATE 7</Text>
      <Text style={styles.title}>Signed in</Text>
      {/*
        An account id, not an email address. It identifies the session for
        support without putting a person's address on a shared screen.
      */}
      <Text style={styles.account}>{accountId}</Text>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>This device</Text>
        <Text style={styles.cardBody}>
          Registering binds this phone to your account so calls can ring it.
        </Text>

        <Pressable
          style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
          onPress={register}
          disabled={busy}
          accessibilityRole="button"
        >
          {busy ? (
            <ActivityIndicator color="#0b0f14" />
          ) : (
            <Text style={styles.buttonLabel}>
              {outcome?.ok === true ? 'Register again' : 'Register this device'}
            </Text>
          )}
        </Pressable>

        {outcome !== null && (
          <View style={[styles.result, outcome.ok ? styles.resultOk : styles.resultBad]}>
            <Text style={styles.resultTitle}>
              {outcome.ok ? 'Registered' : 'Not registered'}
            </Text>
            <Text style={styles.resultBody}>
              {outcome.ok
                ? 'The server can now reach this phone.'
                : EXPLANATION[outcome.reason]}
            </Text>
            {!outcome.ok && outcome.detail !== undefined && (
              <Text style={styles.resultDetail}>{outcome.detail}</Text>
            )}
          </View>
        )}
      </View>

      <Pressable
        style={({ pressed }) => [styles.signOut, pressed && styles.buttonPressed]}
        onPress={onSignOut}
        accessibilityRole="button"
      >
        <Text style={styles.signOutLabel}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flexGrow: 1,
    backgroundColor: '#0b0f14',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 48,
    gap: 6,
  },
  brand: { color: '#3ec9c0', fontSize: 12, letterSpacing: 3, fontWeight: '600' },
  title: { color: '#e4ebf1', fontSize: 30, fontWeight: '700' },
  account: { color: '#5d6874', fontSize: 12, fontFamily: 'monospace', marginBottom: 24 },

  card: {
    backgroundColor: '#141a21',
    borderWidth: 1,
    borderColor: '#273039',
    borderRadius: 12,
    padding: 18,
    gap: 12,
  },
  cardTitle: { color: '#e4ebf1', fontSize: 17, fontWeight: '600' },
  cardBody: { color: '#8d99a6', fontSize: 14, lineHeight: 20 },

  button: {
    backgroundColor: '#3ec9c0',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  buttonPressed: { opacity: 0.75 },
  buttonLabel: { color: '#0b0f14', fontSize: 16, fontWeight: '600' },

  result: { borderRadius: 10, borderWidth: 1, padding: 14, gap: 5 },
  resultOk: { borderColor: '#10312f', backgroundColor: '#101d1c' },
  resultBad: { borderColor: '#3a2a12', backgroundColor: '#1d1710' },
  resultTitle: { color: '#e4ebf1', fontSize: 15, fontWeight: '600' },
  resultBody: { color: '#8d99a6', fontSize: 13, lineHeight: 19 },
  resultDetail: { color: '#5d6874', fontSize: 12, fontFamily: 'monospace' },

  signOut: { marginTop: 28, paddingVertical: 14, alignItems: 'center' },
  signOutLabel: { color: '#8d99a6', fontSize: 15 },
});
