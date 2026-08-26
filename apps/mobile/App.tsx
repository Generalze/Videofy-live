/** @author masterzee001 */
/**
 * The first screen, and deliberately a diagnostic one.
 *
 * WHAT IT PROVES, AND WHAT IT REFUSES TO FAKE. Before any of the product
 * exists, one question is worth answering on a real phone: can this device be
 * reached? Three of the four layers involved can be checked without an account,
 * and this checks them. The fourth -- binding a push token to an account -- is
 * authenticated, and there is no sign-in yet.
 *
 * The shortcut would be to carry a real session token in an `EXPO_PUBLIC_`
 * variable so the button appears to work. That variable is compiled into the
 * bundle in plain text and readable by anyone who unpacks the APK, so it would
 * publish a live credential to every install. The shortcut is therefore not
 * offered anywhere in this app, and the screen says plainly what is still
 * unproven instead of pretending otherwise.
 *
 * NO TOKEN IS EVER DISPLAYED. Only whether one was issued, and its length. A
 * token on screen is a token in a screenshot.
 */
import { StatusBar } from 'expo-status-bar';
/*
 * React 19 removed the GLOBAL JSX namespace, so `JSX.Element` no longer
 * resolves without an import. It is exported from 'react' instead.
 */
import { useCallback, useState, type JSX } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { pendingProbes, runDiagnostics, type Probe } from './src/pushDiagnostics';

/** Where the account service lives for this build. Not a secret. */
const ACCOUNT_BASE_URL =
  process.env['EXPO_PUBLIC_ACCOUNT_URL'] ?? 'https://staging.consummate7.com/auth';

const MARK: Record<Probe['state'], string> = { pending: '·', pass: '✓', fail: '✗' };

export default function App(): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [probes, setProbes] = useState<readonly Probe[]>(pendingProbes());
  const [ran, setRan] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    try {
      setProbes(await runDiagnostics({ accountBaseUrl: ACCOUNT_BASE_URL }));
      setRan(true);
    } finally {
      setBusy(false);
    }
  }, []);

  const allPassed = ran && probes.every((probe) => probe.state === 'pass');

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <StatusBar style="light" />
      <Text style={styles.brand}>CONSUMMATE 7</Text>
      <Text style={styles.title}>Videofy Live</Text>
      <Text style={styles.lede}>Before anything else: can this phone be reached?</Text>

      <View style={styles.probes}>
        {probes.map((probe) => (
          <View key={probe.id} style={styles.probe}>
            <Text style={[styles.mark, styles[probe.state]]}>{MARK[probe.state]}</Text>
            <View style={styles.probeText}>
              <Text style={styles.probeLabel}>{probe.label}</Text>
              {probe.detail !== '' && <Text style={styles.probeDetail}>{probe.detail}</Text>}
            </View>
          </View>
        ))}
      </View>

      <Pressable
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
        onPress={run}
        disabled={busy}
        accessibilityRole="button"
      >
        {busy ? (
          <ActivityIndicator color="#0b0f14" />
        ) : (
          <Text style={styles.buttonLabel}>{ran ? 'Run again' : 'Run checks'}</Text>
        )}
      </Pressable>

      {allPassed && (
        <View style={styles.note}>
          <Text style={styles.noteTitle}>Everything reachable</Text>
          <Text style={styles.noteBody}>
            Network, TLS, routing, notification permission and Firebase all work on this
            device.
          </Text>
        </View>
      )}

      {/*
        Stated permanently, not only after a run. Somebody opening this build
        should be able to see what it does NOT yet do without pressing anything.
      */}
      <View style={styles.pending}>
        <Text style={styles.pendingTitle}>Not proven yet: registering this device</Text>
        <Text style={styles.noteBody}>
          Binding a push token to an account is authenticated, and sign-in does not exist in
          this build. It is deliberately not faked with a token compiled into the app.
          Sign-in and secure session storage are the next piece of work.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flexGrow: 1,
    backgroundColor: '#0b0f14',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 56,
    gap: 12,
  },
  brand: { color: '#3ec9c0', fontSize: 12, letterSpacing: 3, fontWeight: '600' },
  title: { color: '#e4ebf1', fontSize: 32, fontWeight: '700' },
  lede: { color: '#8d99a6', fontSize: 15, textAlign: 'center', marginBottom: 12 },

  probes: { width: '100%', gap: 10, marginBottom: 20 },
  probe: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  mark: { fontSize: 18, width: 20, textAlign: 'center', fontWeight: '700' },
  pending: {
    marginTop: 24,
    width: '100%',
    borderTopWidth: 1,
    borderTopColor: '#273039',
    paddingTop: 16,
    gap: 6,
  },
  pass: { color: '#3ec9c0' },
  fail: { color: '#d9a441' },
  probeText: { flex: 1, gap: 2 },
  probeLabel: { color: '#e4ebf1', fontSize: 15 },
  probeDetail: { color: '#5d6874', fontSize: 12, fontFamily: 'monospace' },

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

  note: {
    marginTop: 20,
    width: '100%',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#10312f',
    backgroundColor: '#101d1c',
    padding: 16,
    gap: 6,
  },
  noteTitle: { color: '#e4ebf1', fontSize: 16, fontWeight: '600' },
  noteBody: { color: '#8d99a6', fontSize: 13, lineHeight: 19 },
  pendingTitle: { color: '#d9a441', fontSize: 14, fontWeight: '600' },
});
