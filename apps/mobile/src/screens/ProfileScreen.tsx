/** @author masterzee001 */
/**
 * Who you are here, and what this phone can do about it.
 *
 * THE VERIFICATION CARD SAYS WHAT VERIFICATION ACTUALLY GATES. The app-shell
 * once implied all three checks were needed to host a call; the truth is that
 * EMAIL ALONE unlocks hosting, and phone/identity gate commercial products.
 * Stating the real rule here is cheaper than answering the support question.
 *
 * DEVICE REGISTRATION IS AUTOMATIC AND THIS CARD ONLY REPORTS IT. The app
 * registers on every signed-in launch; a manual retry exists for the day the
 * automatic one failed, and the failure reasons keep their names because
 * "could not register" collapses four different fixes into a dead end.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { AvatarView } from '../media/AvatarView';
import { pickAvatar } from '../media/avatarPicker';
import type { Api, Profile, VerificationStatus } from '../api/client';
import type { RegistrationOutcome } from '../push/deviceRegistrationService';

const DEVICE_EXPLANATION: Record<Extract<RegistrationOutcome, { ok: false }>['reason'], string> = {
  'not-signed-in': 'The session ended before the device could be registered.',
  'permission-denied': 'Notifications are off for this app, so calls cannot ring this phone.',
  'no-token': 'Firebase did not issue a token for this build.',
  unauthorized: 'The session was rejected. Sign in again.',
  rejected: 'The server would not accept this device.',
  network: 'Could not reach Videofy from this phone.',
};

export interface ProfileScreenProps {
  readonly api: Api;
  readonly deviceOutcome: RegistrationOutcome | null;
  readonly onRetryDevice: () => Promise<void>;
  readonly onSignOut: () => Promise<void>;
}

export function ProfileScreen({
  api,
  deviceOutcome,
  onRetryDevice,
  onSignOut,
}: ProfileScreenProps): JSX.Element {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [verification, setVerification] = useState<VerificationStatus | null>(null);
  const [draftName, setDraftName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pictureNotice, setPictureNotice] = useState<string | null>(null);
  /** Remounts the avatar after upload so the cached image is refetched. */
  const [avatarEpoch, setAvatarEpoch] = useState(0);

  const changePicture = useCallback(async () => {
    setPictureNotice(null);
    const picked = await pickAvatar();
    if (!picked.ok) {
      if (picked.reason !== null) setPictureNotice(picked.reason);
      return;
    }
    const result = await api.setAvatar(picked.dataUrl);
    if (!result.ok) {
      setPictureNotice(result.error === 'network' ? 'Could not reach C7.' : String(result.error));
      return;
    }
    setAvatarEpoch((epoch) => epoch + 1);
  }, [api]);

  const load = useCallback(async () => {
    const [me, status] = await Promise.all([api.me(), api.verification()]);
    if (me.ok) {
      setProfile(me.value);
      setDraftName((current) => (current.length === 0 ? (me.value.displayName ?? '') : current));
    }
    if (status.ok) setVerification(status.value);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveName = useCallback(async () => {
    const name = draftName.trim();
    if (name.length === 0 || busy) return;
    setBusy(true);
    setNotice(null);
    const result = await api.setDisplayName(name);
    setNotice(result.ok ? 'Saved.' : result.error);
    if (result.ok) await load();
    setBusy(false);
  }, [api, busy, draftName, load]);

  const sendEmail = useCallback(async () => {
    setBusy(true);
    setNotice(null);
    const result = await api.sendVerificationEmail();
    setNotice(
      result.ok
        ? 'Verification email sent. The link lasts 30 minutes.'
        : result.error,
    );
    setBusy(false);
  }, [api]);

  const emailVerified = verification?.email === 'verified';

  return (
    <ScrollView style={styles.fill} contentContainerStyle={styles.screen}>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Your C7 identity</Text>
        {profile === null ? (
          <ActivityIndicator color="#3ec9c0" />
        ) : (
          <>
            <View style={styles.avatarRow}>
              <Pressable onPress={() => void changePicture()} accessibilityRole="button">
                <AvatarView
                  key={avatarEpoch}
                  accountId={profile.accountId}
                  name={profile.displayName ?? profile.username ?? '?'}
                  size={64}
                />
              </Pressable>
              <View style={styles.avatarText}>
                <Text style={styles.identity}>{profile.username ?? profile.accountId}</Text>
                <Text style={styles.email}>{profile.email}</Text>
                <Pressable onPress={() => void changePicture()} accessibilityRole="button">
                  <Text style={styles.avatarAction}>Change picture</Text>
                </Pressable>
              </View>
            </View>
            {pictureNotice !== null && <Text style={styles.pictureNotice}>{pictureNotice}</Text>}
            <Text style={styles.label}>Name shown in calls</Text>
            <View style={styles.nameRow}>
              <TextInput
                style={styles.input}
                value={draftName}
                onChangeText={setDraftName}
                placeholder="Your name"
                placeholderTextColor="#4a545f"
                maxLength={40}
              />
              <Pressable
                onPress={() => void saveName()}
                disabled={busy}
                accessibilityRole="button"
                style={[styles.smallButton, busy && styles.disabled]}
              >
                <Text style={styles.smallButtonLabel}>Save</Text>
              </Pressable>
            </View>
            <Text style={styles.hint}>
              Your username is how people add you and cannot change. This name is what they see,
              and can.
            </Text>
          </>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Verification</Text>
        {verification === null ? (
          <ActivityIndicator color="#3ec9c0" />
        ) : (
          <>
            <View style={styles.checkRow}>
              <Text style={emailVerified ? styles.checkDone : styles.checkPending}>
                {emailVerified ? '✓' : '·'}
              </Text>
              <Text style={styles.checkLabel}>
                Email {emailVerified ? 'verified' : `- ${verification.email}`}
              </Text>
            </View>
            <View style={styles.checkRow}>
              <Text style={verification.phone === 'verified' ? styles.checkDone : styles.checkPending}>
                {verification.phone === 'verified' ? '✓' : '·'}
              </Text>
              <Text style={styles.checkLabel}>Phone - {verification.phone}</Text>
            </View>
            <View style={styles.checkRow}>
              <Text
                style={verification.identity === 'verified' ? styles.checkDone : styles.checkPending}
              >
                {verification.identity === 'verified' ? '✓' : '·'}
              </Text>
              <Text style={styles.checkLabel}>Identity - {verification.identity}</Text>
            </View>
            {/*
              The real rule, not the cautious one: email alone unlocks hosting.
              Phone and identity gate commercial products, nothing else.
            */}
            <Text style={styles.hint}>
              {emailVerified
                ? 'You can start calls. Phone and identity checks unlock commercial products later.'
                : 'Verify your email to start calls. You can already join calls and message contacts.'}
            </Text>
            {!emailVerified && (
              <Pressable
                onPress={() => void sendEmail()}
                disabled={busy}
                accessibilityRole="button"
                style={[styles.smallButton, styles.selfStart, busy && styles.disabled]}
              >
                <Text style={styles.smallButtonLabel}>Send verification email</Text>
              </Pressable>
            )}
          </>
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>This phone</Text>
        {deviceOutcome === null && <ActivityIndicator color="#3ec9c0" />}
        {deviceOutcome?.ok === true && (
          <Text style={styles.hint}>Registered. Calls and messages can reach this phone.</Text>
        )}
        {deviceOutcome !== null && !deviceOutcome.ok && (
          <>
            <Text style={styles.warnText}>{DEVICE_EXPLANATION[deviceOutcome.reason]}</Text>
            <Pressable
              onPress={() => void onRetryDevice()}
              accessibilityRole="button"
              style={[styles.smallButton, styles.selfStart]}
            >
              <Text style={styles.smallButtonLabel}>Try again</Text>
            </Pressable>
          </>
        )}
      </View>

      {notice !== null && <Text style={styles.notice}>{notice}</Text>}

      <Pressable
        onPress={() => void onSignOut()}
        accessibilityRole="button"
        style={({ pressed }) => [styles.signOut, pressed && styles.pressed]}
      >
        <Text style={styles.signOutLabel}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#0b0f14' },
  screen: { padding: 16, gap: 14, paddingBottom: 48 },
  card: {
    backgroundColor: '#141a21',
    borderWidth: 1,
    borderColor: '#273039',
    borderRadius: 12,
    padding: 16,
    gap: 10,
  },
  cardTitle: { color: '#e4ebf1', fontSize: 16, fontWeight: '600' },
  identity: { color: '#3ec9c0', fontSize: 20, fontWeight: '700', fontFamily: 'monospace' },
  avatarRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 8 },
  avatarText: { flex: 1, gap: 2 },
  avatarAction: { color: '#3ec9c0', fontSize: 13, fontWeight: '600', marginTop: 4 },
  pictureNotice: { color: '#d9a441', fontSize: 12, marginBottom: 6 },
  email: { color: '#8d99a6', fontSize: 13 },
  label: { color: '#5d6874', fontSize: 12, marginTop: 6 },
  nameRow: { flexDirection: 'row', gap: 8 },
  input: {
    flex: 1,
    backgroundColor: '#0b0f14',
    borderWidth: 1,
    borderColor: '#273039',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 9,
    color: '#e4ebf1',
    fontSize: 15,
  },
  smallButton: {
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: '#3ec9c0',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 40,
  },
  selfStart: { alignSelf: 'flex-start', paddingVertical: 9 },
  disabled: { backgroundColor: '#1f3a38' },
  smallButtonLabel: { color: '#0b0f14', fontSize: 13, fontWeight: '700' },
  hint: { color: '#8d99a6', fontSize: 13, lineHeight: 19 },
  warnText: { color: '#d9a441', fontSize: 13, lineHeight: 19 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  checkDone: { color: '#3ec9c0', fontSize: 15, width: 16, fontWeight: '700' },
  checkPending: { color: '#5d6874', fontSize: 15, width: 16 },
  checkLabel: { color: '#e4ebf1', fontSize: 14 },
  notice: { color: '#d9a441', fontSize: 13, textAlign: 'center' },
  signOut: { alignItems: 'center', paddingVertical: 14 },
  pressed: { opacity: 0.7 },
  signOutLabel: { color: '#8d99a6', fontSize: 15 },
});
