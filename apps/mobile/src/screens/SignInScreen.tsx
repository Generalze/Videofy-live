/** @author masterzee001 */
/**
 * Signing in.
 *
 * THE ERROR TEXT IS DELIBERATELY VAGUE, and it is the only part of this screen
 * with a security argument behind it. "No account with that address" and "wrong
 * password" are different sentences, and telling them apart hands anybody
 * willing to iterate addresses a list of who has an account here. The server
 * already answers both identically; this screen must not reconstruct the
 * distinction from a status code and put it back on screen.
 *
 * RATE LIMITING IS THE ONE EXCEPTION, because it is actionable and reveals
 * nothing: it happens after repeated failures on an address whether or not that
 * address exists, and a person who is locked out needs to know to wait rather
 * than to keep trying.
 *
 * NOTHING IS REMEMBERED HERE. The password lives in component state for the
 * duration of the attempt and nowhere else -- not in secure storage, not in a
 * "remember me", not in a ref that outlives the screen. The session token the
 * server returns is the thing worth keeping, and the session layer keeps it.
 */
import { useCallback, useState, type JSX } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { SignInResult } from '../auth/authSessionManager';

const MESSAGE: Record<NonNullable<SignInResult['reason']>, string> = {
  // One sentence for both wrong-password and no-such-account. See the note above.
  'invalid-credentials': 'That email address and password do not match.',
  'rate-limited': 'Too many attempts. Try again in a few minutes.',
  network: 'Could not reach Videofy. Check your connection and try again.',
  server: 'Something went wrong at our end. Try again shortly.',
};

export interface SignInScreenProps {
  readonly onSignIn: (email: string, password: string) => Promise<SignInResult>;
  readonly onCreateAccount: () => void;
  /** Shown when a session ended by itself rather than by choice. */
  readonly notice?: string | undefined;
}

export function SignInScreen({ onSignIn, onCreateAccount, notice }: SignInScreenProps): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const result = await onSignIn(email.trim(), password);
      if (!result.ok) {
        setError(result.reason === undefined ? MESSAGE.server : MESSAGE[result.reason]);
      }
      /*
       * On success nothing is done here at all. The session manager changes
       * state and the app re-routes; a screen that also navigated would be a
       * second source of truth about whether somebody is signed in.
       */
    } finally {
      setBusy(false);
      // Cleared either way. A password left in state after a failed attempt is
      // a password sitting in a component that may be inspected or serialised.
      setPassword('');
    }
  }, [busy, email, password, onSignIn]);

  const ready = email.trim().length > 0 && password.length > 0 && !busy;

  return (
    <KeyboardAvoidingView
      style={styles.fill}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
        <Text style={styles.brand}>CONSUMMATE 7</Text>
        <Text style={styles.title}>Videofy Live</Text>
        <Text style={styles.lede}>Sign in to your C7 account.</Text>

        {notice !== undefined && (
          <View style={styles.notice}>
            <Text style={styles.noticeText}>{notice}</Text>
          </View>
        )}

        <View style={styles.field}>
          <Text style={styles.label}>Email address</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            textContentType="emailAddress"
            placeholder="you@example.com"
            placeholderTextColor="#4a545f"
            editable={!busy}
            returnKeyType="next"
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Password</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="current-password"
            textContentType="password"
            placeholderTextColor="#4a545f"
            editable={!busy}
            returnKeyType="go"
            onSubmitEditing={submit}
          />
        </View>

        {error !== null && (
          <View style={styles.error} accessibilityLiveRegion="polite">
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <Pressable
          style={({ pressed }) => [
            styles.button,
            !ready && styles.buttonDisabled,
            pressed && ready && styles.buttonPressed,
          ]}
          onPress={submit}
          disabled={!ready}
          accessibilityRole="button"
        >
          {busy ? (
            <ActivityIndicator color="#0b0f14" />
          ) : (
            <Text style={styles.buttonLabel}>Sign in</Text>
          )}
        </Pressable>

        <Pressable onPress={onCreateAccount} style={styles.link} accessibilityRole="button">
          <Text style={styles.linkLabel}>Create a C7 account</Text>
        </Pressable>

        <Text style={styles.footnote}>
          Sessions last 12 hours. You will be asked to sign in again after that.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#0b0f14' },
  screen: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 28,
    paddingVertical: 48,
    gap: 8,
  },
  brand: { color: '#3ec9c0', fontSize: 12, letterSpacing: 3, fontWeight: '600' },
  title: { color: '#e4ebf1', fontSize: 32, fontWeight: '700' },
  lede: { color: '#8d99a6', fontSize: 15, marginBottom: 20 },

  notice: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#3a2a12',
    backgroundColor: '#1d1710',
    padding: 12,
    marginBottom: 12,
  },
  noticeText: { color: '#d9a441', fontSize: 13, lineHeight: 19 },

  field: { gap: 6, marginBottom: 14 },
  label: { color: '#8d99a6', fontSize: 13 },
  input: {
    backgroundColor: '#141a21',
    borderWidth: 1,
    borderColor: '#273039',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: '#e4ebf1',
    fontSize: 16,
  },

  error: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#4a2620',
    backgroundColor: '#1d1210',
    padding: 12,
    marginBottom: 12,
  },
  errorText: { color: '#e06c5b', fontSize: 13, lineHeight: 19 },

  button: {
    backgroundColor: '#3ec9c0',
    paddingVertical: 15,
    borderRadius: 10,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonDisabled: { backgroundColor: '#1f3a38' },
  buttonPressed: { opacity: 0.75 },
  buttonLabel: { color: '#0b0f14', fontSize: 16, fontWeight: '600' },

  link: { marginTop: 20, alignItems: 'center', paddingVertical: 8 },
  linkLabel: { color: '#3ec9c0', fontSize: 14 },
  footnote: { color: '#5d6874', fontSize: 12, marginTop: 12, textAlign: 'center' },
});
