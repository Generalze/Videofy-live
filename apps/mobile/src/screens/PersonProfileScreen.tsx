/** @author masterzee001 */
/**
 * Another person's profile -- what they have let you see, and what you can
 * do about it.
 *
 * PRIVACY-SAFE BY CONSTRUCTION: the server decides what a viewer may know
 * (GET /profiles/:accountId answers 404 for an undiscoverable stranger,
 * exactly like adding one does), and this screen renders only what came
 * back. The language shown is the one they SPEAK -- what you would hear on
 * a call -- never the one they prefer to listen in.
 *
 * Reached from anywhere a person's picture or name appears.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { AvatarView } from '../media/AvatarView';
import type { Api, ContactPerson, PersonProfile } from '../api/client';
import { C7, C7Ground, Chip, GlassCard, RoundIconButton } from '../ui/c7';
import { Icon } from '../ui/icons';

const LANGUAGE_NAMES: Record<string, string> = { en: 'English', es: 'Spanish', fr: 'French' };

const RELATIONSHIP_WORDS: Record<PersonProfile['relationship'], string> = {
  contact: 'In your contacts',
  requested: 'Request sent · waiting for them',
  incoming: 'They asked to connect with you',
  blocked: 'Blocked',
  none: 'Not in your contacts',
};

export function PersonProfileScreen({
  api,
  accountId,
  fallback,
  onBack,
  onMessage,
  onCall,
}: {
  readonly api: Api;
  readonly accountId: string;
  /** What we already knew about them, shown while the profile loads. */
  readonly fallback: ContactPerson | null;
  readonly onBack: () => void;
  readonly onMessage: (person: ContactPerson) => void;
  readonly onCall: (person: ContactPerson) => void;
}): JSX.Element {
  const [profile, setProfile] = useState<PersonProfile | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await api.profileOf(accountId);
    if (result.ok) setProfile(result.value);
    else setNotice(result.status === 404 ? 'This profile is not available to you.' : result.error);
  }, [accountId, api]);

  useEffect(() => {
    void load();
  }, [load]);

  const person: ContactPerson = {
    accountId,
    username: profile?.username ?? fallback?.username ?? null,
    displayName: profile?.displayName ?? fallback?.displayName ?? null,
  };
  const name = person.displayName ?? person.username ?? accountId;

  const act = useCallback(
    async (action: () => Promise<{ ok: boolean; error?: string }>) => {
      setBusy(true);
      setNotice(null);
      const result = await action();
      if (!result.ok) setNotice(result.error ?? 'That could not be done.');
      await load();
      setBusy(false);
    },
    [load],
  );

  const remove = (): void => {
    Alert.alert(`Remove ${name}?`, `${name} will be removed from your contacts. You can add each other again later.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void act(() => api.removeContact(accountId)) },
    ]);
  };

  const block = (): void => {
    Alert.alert(`Block ${name}?`, 'They will not be able to message, call or add you. You can unblock later from your contacts.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Block', style: 'destructive', onPress: () => void act(() => api.blockContact(accountId)) },
    ]);
  };

  const report = (): void => {
    Alert.alert('Report this person', 'Reports go to C7. Tell us what happened by email at safety@consummate7.com and include their username.', [
      { text: 'OK' },
    ]);
  };

  const share = (): void => {
    if (person.username === null) return;
    void Share.share({ message: `Add me on C7: @${person.username}` });
  };

  return (
    <View style={styles.fill}>
      <C7Ground />
      <ScrollView contentContainerStyle={styles.screen}>
        <View style={styles.top}>
          <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Back" hitSlop={8} style={styles.back}>
            <Icon name="chevron" size={22} color={C7.text} />
          </Pressable>
          <Text style={styles.topTitle}>Profile</Text>
          <View style={{ width: 30 }} />
        </View>

        <View style={styles.identity}>
          <View style={styles.avatarRing}>
            <AvatarView accountId={accountId} name={name} size={116} />
          </View>
          <Text style={styles.name}>{name}</Text>
          <View style={styles.handleRow}>
            {person.username !== null && <Text style={styles.handle}>@{person.username}</Text>}
            {profile?.official === true && <Chip label="C7" tone="teal" />}
          </View>
          {profile === null && notice === null && <ActivityIndicator color={C7.teal} />}
          {profile !== null && (
            <Text style={styles.relationship}>{RELATIONSHIP_WORDS[profile.relationship]}</Text>
          )}
          {notice !== null && <Text style={styles.notice}>{notice}</Text>}
        </View>

        <View style={styles.actions}>
          <RoundIconButton label="Message" onPress={() => onMessage(person)} size={52}>
            <Icon name="message" size={22} color={C7.text} />
          </RoundIconButton>
          <RoundIconButton label="Call" onPress={() => onCall(person)} size={52} tone="teal">
            <Icon name="phone" size={22} color={C7.teal} />
          </RoundIconButton>
          {person.username !== null && (
            <RoundIconButton label="Share" onPress={share} size={52}>
              <Icon name="share" size={22} color={C7.text} />
            </RoundIconButton>
          )}
        </View>

        {profile !== null && (
          <GlassCard style={{ gap: 12 }}>
            {profile.spokenLanguage !== null && (
              <View style={styles.row}>
                <Icon name="translate" size={20} color={C7.teal} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowTitle}>Speaks {LANGUAGE_NAMES[profile.spokenLanguage] ?? profile.spokenLanguage.toUpperCase()}</Text>
                  <Text style={styles.rowSub}>What you hear on a call; translated when your conversation is in translated mode.</Text>
                </View>
              </View>
            )}
            <View style={styles.row}>
              <Icon name={profile.discoverable ? 'globe' : 'lock'} size={20} color={C7.muted} />
              <Text style={styles.rowSub}>{profile.discoverable ? 'Discoverable by username' : 'Not discoverable by username'}</Text>
            </View>
          </GlassCard>
        )}

        {profile !== null && (
          <GlassCard padded={false} style={{ overflow: 'hidden' }}>
            {profile.relationship === 'none' && (
              <Pressable disabled={busy} onPress={() => void act(() => api.requestContact(person.username ?? accountId))} accessibilityRole="button" style={styles.listRow}>
                <Icon name="add-person" size={20} color={C7.teal} />
                <Text style={styles.listLabel}>Add to contacts</Text>
              </Pressable>
            )}
            {profile.relationship === 'incoming' && (
              <Pressable disabled={busy} onPress={() => void act(() => api.acceptContact(accountId))} accessibilityRole="button" style={styles.listRow}>
                <Icon name="add-person" size={20} color={C7.teal} />
                <Text style={styles.listLabel}>Accept their request</Text>
              </Pressable>
            )}
            {profile.relationship === 'contact' && (
              <Pressable disabled={busy} onPress={remove} accessibilityRole="button" style={styles.listRow}>
                <Icon name="close" size={20} color={C7.muted} />
                <Text style={styles.listLabel}>Remove contact</Text>
              </Pressable>
            )}
            {profile.relationship !== 'blocked' && (
              <Pressable disabled={busy} onPress={block} accessibilityRole="button" style={styles.listRow}>
                <Icon name="shield" size={20} color={C7.red} />
                <Text style={[styles.listLabel, { color: C7.red }]}>Block</Text>
              </Pressable>
            )}
            <Pressable onPress={report} accessibilityRole="button" style={styles.listRow}>
              <Icon name="bell" size={20} color={C7.muted} />
              <Text style={styles.listLabel}>Report</Text>
            </Pressable>
          </GlassCard>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  screen: { padding: 16, paddingTop: 50, gap: 16, paddingBottom: 48 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  back: { transform: [{ rotate: '180deg' }], padding: 4 },
  topTitle: { color: C7.text, fontSize: 18, fontWeight: '600', fontFamily: 'serif' },
  identity: { alignItems: 'center', gap: 8 },
  avatarRing: { borderRadius: 70, borderWidth: 2, borderColor: C7.teal, padding: 4 },
  name: { color: C7.text, fontSize: 30, fontWeight: '600', fontFamily: 'serif', marginTop: 6, textAlign: 'center' },
  handleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  handle: { color: C7.muted, fontSize: 15 },
  relationship: { color: C7.teal, fontSize: 13 },
  notice: { color: C7.amber, fontSize: 13, textAlign: 'center' },
  actions: { flexDirection: 'row', justifyContent: 'center', gap: 28 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowTitle: { color: C7.text, fontSize: 15, fontWeight: '600' },
  rowSub: { color: C7.muted, fontSize: 13, lineHeight: 18, flexShrink: 1 },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C7.panelEdge },
  listLabel: { color: C7.text, fontSize: 15 },
});
