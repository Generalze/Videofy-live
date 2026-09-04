/** @author masterzee001 */
/**
 * Creating a C7 account from the phone.
 *
 * THE USERNAME RULE IS IMPORTED, NOT REIMPLEMENTED. `checkUsernameShape` is the
 * same function the account service runs, reached through a subpath export
 * because `username.ts` has no imports at all and is safe on Hermes -- the
 * package barrel is not, since several of its other modules use `node:crypto`.
 *
 * That matters more than it sounds. A second copy of this rule in the client
 * would drift, and the drift is invisible in the direction that hurts: the app
 * accepts a name, the server refuses it, and the person is told to fix
 * something the app just told them was fine. The web form has already produced
 * exactly one bug of that family today by collecting a username and never
 * sending it.
 *
 * THE CLIENT CHECK IS COURTESY, NOT AUTHORITY. It answers instantly and saves a
 * round trip; the server still decides, because only the server knows whether a
 * name is already taken or was previously used and released. Nothing here
 * pretends to know that.
 *
 * REGISTRATION RETURNS A SESSION. `POST /accounts` responds 201 with the same
 * body as sign-in, so a new account is signed in immediately -- making somebody
 * repeat the password they just chose is ceremony.
 */
import { useCallback, useMemo, useState, type JSX } from 'react';
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
import {
  USERNAME_REFUSAL_MESSAGES,
  checkUsernameShape,
} from '@videofy-live/account-trust/username';
import type { SignUpResult } from '../auth/authSessionManager';

const MESSAGE: Record<NonNullable<SignUpResult['reason']>, string> = {
  taken: 'That email address or username is already in use.',
  invalid: 'Check the details and try again.',
  'rate-limited': 'Too many attempts. Try again in a few minutes.',
  network: 'Could not reach Videofy. Check your connection and try again.',
  server: 'Something went wrong at our end. Try again shortly.',
};

export interface SignUpScreenProps {
  readonly onSignUp: (email: string, password: string, username: string) => Promise<SignUpResult>;
  readonly onBackToSignIn: () => void;
}

export function SignUpScreen({ onSignUp, onBackToSignIn }: SignUpScreenProps): JSX.Element {
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Only complained about once there is something to complain about. Telling
   * somebody their username is too short while they are still typing the third
   * character is noise that trains people to ignore the message.
   */
  const usernameProblem = useMemo(() => {
    const trimmed = username.trim();
    if (trimmed.length === 0) return null;
    const check = checkUsernameShape(trimmed);
    return check.ok ? null : USERNAME_REFUSAL_MESSAGES[check.reason];
  }, [username]);

  const normalised = useMemo(() => {
    const check = checkUsernameShape(username.trim());
    return check.ok ? check.username : null;
  }, [username]);

  const submit = useCallback(async () => {
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const result = await onSignUp(email.trim(), password, username.trim());
      if (!result.ok) {
        // The server's own sentence names the field; the generic word is the fallback.
        setError(
          result.message ?? (result.reason === undefined ? MESSAGE.server : MESSAGE[result.reason]),
        );
      }
    } finally {
      setBusy(false);
      setPassword('');
    }
  }, [busy, email, password, username, onSignUp]);

  const ready =
    email.trim().length > 0 && password.length >= 8 && normalised !== null && !busy;

  return (
    <KeyboardAvoidingView
      style={styles.fill}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.screen} keyboardShouldPersistTaps="handled">
        <Text style={styles.brand}>CONSUMMATE 7</Text>
        <Text style={styles.title}>Create your account</Text>
        <Text style={styles.lede}>One C7 account across every product.</Text>

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
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>C7 username</Text>
          <TextInput
            style={[styles.input, usernameProblem !== null && styles.inputBad]}
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            placeholder="c7yourname"
            placeholderTextColor="#4a545f"
            editable={!busy}
          />
          {usernameProblem !== null ? (
            <Text style={styles.fieldBad}>{usernameProblem}</Text>
          ) : (
            <Text style={styles.hint}>
              {normalised === null
                ? 'This is how people add you. Your name in calls is separate and can be changed.'
                : `You will be ${normalised}. This one cannot be given up and taken back later.`}
            </Text>
          )}
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Password</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoCapitalize="none"
            autoComplete="new-password"
            textContentType="newPassword"
            placeholderTextColor="#4a545f"
            editable={!busy}
            onSubmitEditing={submit}
          />
          <Text style={styles.hint}>At least 8 characters.</Text>
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
            <Text style={styles.buttonLabel}>Create C7 account</Text>
          )}
        </Pressable>

        <Pressable onPress={onBackToSignIn} style={styles.link} accessibilityRole="button">
          <Text style={styles.linkLabel}>I already have an account</Text>
        </Pressable>
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
    gap: 6,
  },
  brand: { color: '#3ec9c0', fontSize: 12, letterSpacing: 3, fontWeight: '600' },
  title: { color: '#e4ebf1', fontSize: 30, fontWeight: '700' },
  lede: { color: '#8d99a6', fontSize: 15, marginBottom: 20 },

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
  inputBad: { borderColor: '#4a2620' },
  hint: { color: '#5d6874', fontSize: 12, lineHeight: 17 },
  fieldBad: { color: '#d9a441', fontSize: 12, lineHeight: 17 },

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
  linkLabel: { color: '#8d99a6', fontSize: 14 },
});
