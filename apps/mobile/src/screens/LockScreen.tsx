/** @author masterzee001 */
/**
 * The lock screen: an hour away, and the phone asks who is holding it.
 *
 * BIOMETRICS FIRST, THE PASSWORD ALWAYS. The prompt opens by itself on
 * arrival (one hour idle should cost one touch, not a form); when the phone
 * has no biometrics enrolled, or they fail, or the person prefers not to
 * use them, the account password unlocks. Both paths only UNLOCK -- the
 * session behind the lock is untouched. Sign out is offered because a lock
 * screen is also where somebody discovers this is not their account.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { C7, C7Ground, C7Lockup, PrimaryButton } from '../ui/c7';
import { Icon } from '../ui/icons';

export type UnlockWithPassword = (password: string) => Promise<'ok' | 'wrong' | 'network'>;

export function LockScreen({
  email,
  biometricsPreferred,
  onUnlockWithPassword,
  onUnlocked,
  onSignOut,
}: {
  readonly email: string | null;
  readonly biometricsPreferred: boolean;
  readonly onUnlockWithPassword: UnlockWithPassword;
  readonly onUnlocked: () => void;
  readonly onSignOut: () => void;
}): JSX.Element {
  const [biometrics, setBiometrics] = useState<'checking' | 'available' | 'unavailable'>('checking');
  const [prompting, setPrompting] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const promptBiometrics = useCallback(async () => {
    setPrompting(true);
    setNotice(null);
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock Videofy Live',
        cancelLabel: 'Use password',
        disableDeviceFallback: true,
      });
      if (result.success) {
        onUnlocked();
        return;
      }
      if (result.error !== 'user_cancel' && result.error !== 'system_cancel' && result.error !== 'app_cancel') {
        setNotice('Biometrics did not unlock. Use your password.');
      }
    } catch {
      setNotice('Biometrics are not available right now. Use your password.');
    } finally {
      setPrompting(false);
    }
  }, [onUnlocked]);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [hardware, enrolled] = await Promise.all([
          LocalAuthentication.hasHardwareAsync(),
          LocalAuthentication.isEnrolledAsync(),
        ]);
        if (!live) return;
        const available = hardware && enrolled && biometricsPreferred;
        setBiometrics(available ? 'available' : 'unavailable');
        if (available) void promptBiometrics();
      } catch {
        if (live) setBiometrics('unavailable');
      }
    })();
    return () => {
      live = false;
    };
  }, [biometricsPreferred, promptBiometrics]);

  const submitPassword = async (): Promise<void> => {
    if (password.length === 0 || busy) return;
    setBusy(true);
    setNotice(null);
    const outcome = await onUnlockWithPassword(password);
    setBusy(false);
    if (outcome === 'ok') {
      onUnlocked();
      return;
    }
    setNotice(outcome === 'wrong' ? 'That password is not right.' : 'Could not check your password. Check your connection.');
  };

  return (
    <View style={styles.fill}>
      <C7Ground />
      <View style={styles.body}>
        <C7Lockup />
        <View style={styles.lockBadge}>
          <Icon name="lock" size={28} color={C7.teal} />
        </View>
        <Text style={styles.title}>Locked</Text>
        <Text style={styles.subtitle}>You have been away for a while.{email !== null ? `\nSigned in as ${email}` : ''}</Text>

        {biometrics === 'checking' && <ActivityIndicator color={C7.teal} />}
        {biometrics === 'available' && (
          <PrimaryButton label={prompting ? 'Waiting for you…' : 'Unlock with fingerprint or face'} onPress={() => void promptBiometrics()} disabled={prompting} />
        )}

        <View style={styles.passwordBlock}>
          <Text style={styles.label}>{biometrics === 'available' ? 'Or use your password' : 'Enter your password'}</Text>
          <TextInput
            style={styles.input}
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            placeholderTextColor={C7.faint}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={() => void submitPassword()}
          />
          <PrimaryButton label={busy ? 'Checking…' : 'Unlock'} onPress={() => void submitPassword()} disabled={busy || password.length === 0} />
        </View>

        {notice !== null && <Text style={styles.notice}>{notice}</Text>}

        <Pressable onPress={onSignOut} accessibilityRole="button" style={styles.signOut}>
          <Text style={styles.signOutLabel}>Not you? Sign out</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C7.ground },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 28 },
  lockBadge: { width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(62,201,192,0.12)', borderWidth: 1, borderColor: 'rgba(62,201,192,0.35)', alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  title: { color: C7.text, fontSize: 28, fontWeight: '600', fontFamily: 'serif' },
  subtitle: { color: C7.muted, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  passwordBlock: { width: '100%', gap: 10, marginTop: 8 },
  label: { color: C7.muted, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1 },
  input: { borderRadius: 12, borderWidth: 1, borderColor: C7.panelEdge, backgroundColor: 'rgba(255,255,255,0.04)', color: C7.text, fontSize: 16, paddingHorizontal: 14, paddingVertical: 12 },
  notice: { color: C7.amber, fontSize: 13, textAlign: 'center' },
  signOut: { marginTop: 12, padding: 8 },
  signOutLabel: { color: C7.muted, fontSize: 13, textDecorationLine: 'underline' },
});
