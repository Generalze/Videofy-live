/** @author masterzee001 */
/**
 * The first screen, and deliberately a diagnostic one.
 *
 * WHAT THIS IS FOR. Before any of the product exists there is one question
 * worth answering on a real phone: can this device be reached? Everything else
 * -- calls, contacts, messages -- is built on a push token that the server
 * accepted and can actually deliver to. So the first screen registers, and
 * SHOWS WHAT HAPPENED, including the failures.
 *
 * IT SHOWS THE FAILURE MODES BY NAME because they are not interchangeable.
 * Permission denied is the person's choice and the app must keep working
 * without ringing; no token is a build or Firebase problem; server refused is a
 * session problem; network is neither. A single "could not register" would
 * collapse four different fixes into one dead end.
 *
 * IT NEVER DISPLAYS THE PUSH TOKEN. A token on screen is a token in a
 * screenshot, and anyone holding one can push to this device.
 */
import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { registerForPush, type RegistrationOutcome } from './src/pushRegistration';

/** Where the account service lives for this build. */
const ACCOUNT_BASE_URL = process.env['EXPO_PUBLIC_ACCOUNT_URL'] ?? 'https://c7.example/api/account';

const EXPLANATION: Record<string, string> = {
  'permission-denied':
    'Notifications are turned off for this app. Calls will not ring until they are allowed in Android settings.',
  'no-token':
    'Firebase did not return a token. This build may be missing google-services.json, or it is not a development build.',
  'server-refused': 'The account service rejected the registration. The session may have expired.',
  network: 'Could not reach the account service from this phone.',
  'unsupported-platform': 'Push is not available on this platform.',
};

export default function App(): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<RegistrationOutcome | null>(null);

  const register = useCallback(async () => {
    setBusy(true);
    try {
      setOutcome(
        await registerForPush({
          accountBaseUrl: ACCOUNT_BASE_URL,
          // Placeholder until sign-in exists. Registration is per ACCOUNT, so
          // this screen cannot succeed against a real server without one -- and
          // that is correct, not a gap to paper over with an anonymous device.
          sessionToken: process.env['EXPO_PUBLIC_DEV_SESSION'] ?? '',
          label: 'Android phone',
        }),
      );
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <Text style={styles.brand}>CONSUMMATE 7</Text>
      <Text style={styles.title}>Videofy Live</Text>
      <Text style={styles.lede}>
        Before anything else: can this phone be reached?
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
          <Text style={styles.buttonLabel}>Register this device</Text>
        )}
      </Pressable>

      {outcome !== null && (
        <View style={[styles.result, outcome.ok ? styles.resultOk : styles.resultBad]}>
          <Text style={styles.resultTitle}>
            {outcome.ok ? 'Registered' : 'Not registered'}
          </Text>
          <Text style={styles.resultBody}>
            {outcome.ok
              ? 'The server has this device and can push to it.'
              : (EXPLANATION[outcome.reason] ?? outcome.reason)}
          </Text>
          {!outcome.ok && outcome.detail !== undefined && (
            <Text style={styles.resultDetail}>{outcome.detail}</Text>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#0b0f14',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    gap: 12,
  },
  brand: {
    color: '#3ec9c0',
    fontSize: 12,
    letterSpacing: 3,
    fontWeight: '600',
  },
  title: { color: '#e4ebf1', fontSize: 34, fontWeight: '700' },
  lede: {
    color: '#8d99a6',
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 20,
  },
  button: {
    backgroundColor: '#3ec9c0',
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 10,
    minWidth: 220,
    alignItems: 'center',
  },
  buttonPressed: { opacity: 0.75 },
  buttonLabel: { color: '#0b0f14', fontSize: 16, fontWeight: '600' },
  result: {
    marginTop: 24,
    borderRadius: 10,
    borderWidth: 1,
    padding: 16,
    width: '100%',
    gap: 6,
  },
  resultOk: { borderColor: '#10312f', backgroundColor: '#101d1c' },
  resultBad: { borderColor: '#3a2a12', backgroundColor: '#1d1710' },
  resultTitle: { color: '#e4ebf1', fontSize: 16, fontWeight: '600' },
  resultBody: { color: '#8d99a6', fontSize: 14, lineHeight: 20 },
  resultDetail: { color: '#5d6874', fontSize: 12, fontFamily: 'monospace' },
});
