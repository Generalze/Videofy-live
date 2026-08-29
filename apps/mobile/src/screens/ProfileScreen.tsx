/** @author masterzee001 */
/**
 * Profile, to canon: the person first (picture in a teal ring, name,
 * @handle, the C7 badge), then the rows -- Languages & Voice, Devices &
 * Security (this phone's registration), Verification -- and sign out.
 *
 * WHAT THE CANON SHOWS AND THIS BUILD DOES NOT CLAIM: session counts,
 * following, saved, availability, notification and privacy settings,
 * "My C7 Voice" and an upgrade offer. Each of those is a product not yet
 * built; a row that leads nowhere would be worse than no row.
 *
 * THE VERIFICATION ROW SAYS WHAT VERIFICATION ACTUALLY GATES: email alone
 * unlocks hosting; phone and identity gate commercial products.
 */
import { useCallback, useEffect, useState, type JSX, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { AvatarView } from '../media/AvatarView';
import { pickAvatar } from '../media/avatarPicker';
import type { Api, Profile, VerificationStatus } from '../api/client';
import type { RegistrationOutcome } from '../push/deviceRegistrationService';
import { C7, Chip, GlassCard } from '../ui/c7';
import { Icon, type IconName } from '../ui/icons';

const DEVICE_EXPLANATION: Record<Extract<RegistrationOutcome, { ok: false }>['reason'], string> = {
  'not-signed-in': 'The session ended before the device could be registered.',
  'permission-denied': 'Notifications are off for this app, so calls cannot ring this phone.',
  'no-token': 'Firebase did not issue a token for this build.',
  unauthorized: 'The session was rejected. Sign in again.',
  rejected: 'The server would not accept this device.',
  network: 'Could not reach Videofy from this phone.',
};

const LANGUAGES = [
  ['en', 'English'],
  ['es', 'Spanish'],
  ['fr', 'French'],
] as const;

function languageName(code: string | null | undefined): string {
  const found = LANGUAGES.find(([c]) => c === code);
  return found ? found[1] : (code ?? '—');
}

export interface ProfileScreenProps {
  readonly api: Api;
  readonly deviceOutcome: RegistrationOutcome | null;
  readonly onRetryDevice: () => Promise<void>;
  readonly onSignOut: () => Promise<void>;
}

function Row({ icon, title, subtitle, open, onPress, children }: { readonly icon: IconName; readonly title: string; readonly subtitle?: string | undefined; readonly open?: boolean; readonly onPress?: () => void; readonly children?: ReactNode }): JSX.Element {
  return (
    <GlassCard padded={false} style={styles.rowCard}>
      <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.rowHead, pressed && onPress && styles.pressed]}>
        <View style={styles.rowIcon}>
          <Icon name={icon} size={22} color={C7.teal} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.rowTitle}>{title}</Text>
          {subtitle !== undefined && <Text style={styles.rowSubtitle}>{subtitle}</Text>}
        </View>
        {onPress !== undefined && <Icon name="chevron" size={18} color={C7.muted} />}
      </Pressable>
      {open && children !== undefined && <View style={styles.rowBody}>{children}</View>}
    </GlassCard>
  );
}

export function ProfileScreen({ api, deviceOutcome, onRetryDevice, onSignOut }: ProfileScreenProps): JSX.Element {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [verification, setVerification] = useState<VerificationStatus | null>(null);
  const [draftName, setDraftName] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pictureNotice, setPictureNotice] = useState<string | null>(null);
  const [avatarEpoch, setAvatarEpoch] = useState(0);
  const [open, setOpen] = useState<'languages' | 'name' | 'verification' | 'device' | null>(null);

  const changePicture = useCallback(async () => {
    setPictureNotice(null);
    const picked = await pickAvatar();
    if (!picked.ok) {
      if (picked.reason !== null) setPictureNotice(picked.reason);
      return;
    }
    setPictureNotice('Uploading…');
    const result = await api.setAvatar(picked.dataUrl);
    if (!result.ok) {
      setPictureNotice(result.error === 'network' ? 'Could not reach C7.' : String(result.error));
      return;
    }
    setAvatarEpoch((epoch) => epoch + 1);
    setPictureNotice('Picture updated.');
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
    setNotice(result.ok ? 'Verification email sent. The link lasts 30 minutes.' : result.error);
    setBusy(false);
  }, [api]);

  const emailVerified = verification?.email === 'verified';
  const toggle = (key: NonNullable<typeof open>) => () => setOpen((current) => (current === key ? null : key));

  return (
    <ScrollView style={styles.fill} contentContainerStyle={styles.screen}>
      <GlassCard style={styles.identity}>
        {profile === null ? (
          <ActivityIndicator color={C7.teal} />
        ) : (
          <View style={styles.identityRow}>
            <Pressable onPress={() => void changePicture()} accessibilityRole="button" accessibilityLabel="Change picture" style={styles.avatarRing}>
              <AvatarView key={avatarEpoch} version={avatarEpoch} accountId={profile.accountId} name={profile.displayName ?? profile.username ?? '?'} size={104} />
              <View style={styles.avatarEdit}>
                <Icon name="plus" size={14} color={C7.ground} strokeWidth={2.4} />
              </View>
            </Pressable>
            <View style={{ flex: 1, gap: 6 }}>
              <Text style={styles.name}>{profile.displayName ?? profile.username ?? profile.accountId}</Text>
              <View style={styles.handleRow}>
                <Text style={styles.handle}>@{profile.username ?? profile.accountId}</Text>
                <Chip label="C7" tone="teal" />
              </View>
              <Text style={styles.email}>{profile.email}</Text>
              {pictureNotice !== null && <Text style={styles.pictureNotice}>{pictureNotice}</Text>}
            </View>
          </View>
        )}
      </GlassCard>

      <Row
        icon="translate"
        title="Languages & Voice"
        subtitle={profile === null ? undefined : `Primary ${languageName(profile.defaultLanguage)} · I speak ${languageName(profile.spokenLanguage ?? profile.defaultLanguage)} · I prefer to hear ${languageName(profile.listeningLanguage ?? profile.defaultLanguage)}`}
        open={open === 'languages'}
        onPress={toggle('languages')}
      >
        {profile !== null && (
          <>
            <Text style={styles.label}>I speak</Text>
            <View style={styles.chips}>
              {LANGUAGES.map(([code, label]) => (
                <Chip key={code} label={label} active={(profile.spokenLanguage ?? profile.defaultLanguage) === code} onPress={() => void api.setLanguages({ spokenLanguage: code }).then((r) => { if (r.ok) void load(); })} />
              ))}
            </View>
            <Text style={styles.label}>I prefer to hear</Text>
            <View style={styles.chips}>
              {LANGUAGES.map(([code, label]) => (
                <Chip key={code} label={label} active={(profile.listeningLanguage ?? profile.defaultLanguage) === code} onPress={() => void api.setLanguages({ listeningLanguage: code }).then((r) => { if (r.ok) void load(); })} />
              ))}
            </View>
            <Text style={styles.hint}>Calls and translated messages follow these. The full language catalogue arrives with the programme wave.</Text>
          </>
        )}
      </Row>

      <Row icon="profile" title="Name shown in calls" subtitle={profile?.displayName ?? 'Not set'} open={open === 'name'} onPress={toggle('name')}>
        <View style={styles.nameRow}>
          <TextInput style={styles.input} value={draftName} onChangeText={setDraftName} placeholder="Your name" placeholderTextColor={C7.faint} maxLength={40} />
          <Pressable onPress={() => void saveName()} disabled={busy} accessibilityRole="button" style={[styles.smallButton, busy && styles.disabled]}>
            <Text style={styles.smallButtonLabel}>Save</Text>
          </Pressable>
        </View>
        <Text style={styles.hint}>Your username is how people add you and cannot change. This name is what they see, and can.</Text>
      </Row>

      <Row
        icon="shield"
        title="Verification"
        subtitle={verification === null ? undefined : emailVerified ? 'Email verified · you can start calls' : 'Verify your email to start calls'}
        open={open === 'verification'}
        onPress={toggle('verification')}
      >
        {verification !== null && (
          <>
            {(
              [
                ['Email', verification.email],
                ['Phone', verification.phone],
                ['Identity', verification.identity],
              ] as const
            ).map(([label, state]) => (
              <View key={label} style={styles.checkRow}>
                <Text style={state === 'verified' ? styles.checkDone : styles.checkPending}>{state === 'verified' ? '✓' : '·'}</Text>
                <Text style={styles.checkLabel}>{label} · {state}</Text>
              </View>
            ))}
            <Text style={styles.hint}>
              {emailVerified ? 'You can start calls. Phone and identity checks unlock commercial products later.' : 'You can already join calls and message contacts.'}
            </Text>
            {!emailVerified && (
              <Pressable onPress={() => void sendEmail()} disabled={busy} accessibilityRole="button" style={[styles.smallButton, styles.selfStart, busy && styles.disabled]}>
                <Text style={styles.smallButtonLabel}>Send verification email</Text>
              </Pressable>
            )}
          </>
        )}
      </Row>

      <Row
        icon="bell"
        title="Devices & Security"
        subtitle={deviceOutcome === null ? 'Registering this phone…' : deviceOutcome.ok ? 'This phone can ring for calls and messages' : 'This phone cannot ring yet'}
        open={open === 'device'}
        onPress={toggle('device')}
      >
        {deviceOutcome !== null && !deviceOutcome.ok && (
          <>
            <Text style={styles.warnText}>{DEVICE_EXPLANATION[deviceOutcome.reason]}</Text>
            <Pressable onPress={() => void onRetryDevice()} accessibilityRole="button" style={[styles.smallButton, styles.selfStart]}>
              <Text style={styles.smallButtonLabel}>Try again</Text>
            </Pressable>
          </>
        )}
        {deviceOutcome?.ok === true && <Text style={styles.hint}>Registered. Calls and messages can reach this phone.</Text>}
      </Row>

      {notice !== null && <Text style={styles.notice}>{notice}</Text>}

      <Pressable onPress={() => void onSignOut()} accessibilityRole="button" style={({ pressed }) => [styles.signOut, pressed && styles.pressed]}>
        <Text style={styles.signOutLabel}>Sign out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  screen: { padding: 16, gap: 12, paddingBottom: 48 },
  identity: { padding: 18 },
  identityRow: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  avatarRing: { borderRadius: 60, borderWidth: 2, borderColor: C7.teal, padding: 3 },
  avatarEdit: { position: 'absolute', right: 2, bottom: 2, width: 24, height: 24, borderRadius: 12, backgroundColor: C7.teal, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: C7.ground },
  name: { color: C7.text, fontSize: 28, fontWeight: '600', fontFamily: 'serif', letterSpacing: -0.3 },
  handleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  handle: { color: C7.muted, fontSize: 15 },
  email: { color: C7.faint, fontSize: 13 },
  pictureNotice: { color: C7.amber, fontSize: 12 },
  rowCard: { padding: 0 },
  rowHead: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16 },
  rowIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: C7.tealSoft, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { color: C7.text, fontSize: 19, fontWeight: '600', fontFamily: 'serif' },
  rowSubtitle: { color: C7.muted, fontSize: 13, lineHeight: 18 },
  rowBody: { paddingHorizontal: 16, paddingBottom: 16, gap: 8, borderTopWidth: 1, borderTopColor: C7.panelEdge, paddingTop: 12 },
  label: { color: C7.faint, fontSize: 12, marginTop: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  hint: { color: C7.muted, fontSize: 13, lineHeight: 19 },
  warnText: { color: C7.amber, fontSize: 13, lineHeight: 19 },
  nameRow: { flexDirection: 'row', gap: 8 },
  input: { flex: 1, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: C7.panelEdge, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, color: C7.text, fontSize: 15 },
  smallButton: { paddingHorizontal: 14, borderRadius: 12, backgroundColor: C7.tealDeep, borderWidth: 1, borderColor: 'rgba(62,201,192,0.7)', alignItems: 'center', justifyContent: 'center', minHeight: 40 },
  selfStart: { alignSelf: 'flex-start', paddingVertical: 9 },
  disabled: { opacity: 0.45 },
  smallButtonLabel: { color: '#ffffff', fontSize: 13, fontWeight: '700' },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  checkDone: { color: C7.teal, fontSize: 15, width: 16, fontWeight: '700' },
  checkPending: { color: C7.faint, fontSize: 15, width: 16 },
  checkLabel: { color: C7.text, fontSize: 14 },
  notice: { color: C7.amber, fontSize: 13, textAlign: 'center' },
  signOut: { alignItems: 'center', paddingVertical: 14 },
  pressed: { opacity: 0.7 },
  signOutLabel: { color: C7.muted, fontSize: 15 },
});
