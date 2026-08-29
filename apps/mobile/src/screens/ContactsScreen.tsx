/** @author masterzee001 */
/**
 * People, to canon: your contacts with Message and Call beside each, a
 * quiet menu for the rest, requests that need an answer first, and the
 * ones still waiting on the other person.
 *
 * NO INVENTED PRESENCE. The canon shows "Active now" and "Speaks Yoruba";
 * presence is the next wave (blueprint §11) and a contact's languages are
 * not on the contact wire yet. Until they are, nothing here claims them.
 *
 * ADDING IS BY USERNAME AND THE ANSWER IS DELIBERATELY FLAT. A username
 * that does not exist, an account that is private, and a person who has
 * blocked you all answer the same way server-side.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { AvatarView } from '../media/AvatarView';
import type { Api, ContactPerson, ContactsResponse } from '../api/client';
import { C7, GlassCard, PrimaryButton, RoundIconButton, SectionHeading } from '../ui/c7';
import { Icon } from '../ui/icons';

function personName(person: ContactPerson): string {
  return person.displayName ?? person.username ?? person.accountId;
}

export interface ContactsScreenProps {
  readonly api: Api;
  readonly onMessage: (partner: ContactPerson) => void;
  readonly onCall: (partner: ContactPerson) => void;
  /** Their picture or name opens their profile. */
  readonly onOpenPerson: (partner: ContactPerson) => void;
  /** Opened by the header's add-person control. */
  readonly adding?: boolean;
  readonly onAddingChange?: (adding: boolean) => void;
}

export function ContactsScreen({ api, onMessage, onCall, onOpenPerson, adding = false, onAddingChange }: ContactsScreenProps): JSX.Element {
  const [data, setData] = useState<ContactsResponse | null>(null);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(adding);

  useEffect(() => {
    if (adding) setShowAdd(true);
  }, [adding]);

  const load = useCallback(async () => {
    const result = await api.contacts();
    if (result.ok) setData(result.value);
  }, [api]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => clearInterval(timer);
  }, [load]);

  const add = useCallback(async () => {
    const handle = username.trim();
    if (handle.length === 0 || busy) return;
    setBusy(true);
    setNotice(null);
    const result = await api.requestContact(handle);
    if (result.ok) {
      setUsername('');
      setNotice('Request sent.');
      await load();
    } else {
      setNotice(
        result.status === 404
          ? `No discoverable account named ${handle}. Ask them to switch on Discoverable in their Profile, then try again.`
          : result.error,
      );
    }
    setBusy(false);
  }, [api, busy, load, username]);

  const act = useCallback(
    async (action: () => ReturnType<Api['acceptContact']>) => {
      setNotice(null);
      const result = await action();
      if (!result.ok) setNotice(result.error);
      await load();
    },
    [load],
  );

  const remove = (person: ContactPerson): void => {
    const name = personName(person);
    Alert.alert(`Remove ${name}?`, `${name} will be removed from your contacts. You can add each other again later.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void act(() => api.removeContact(person.accountId)) },
    ]);
  };

  return (
    <ScrollView style={styles.fill} contentContainerStyle={styles.screen} onScrollBeginDrag={() => setMenuFor(null)}>
      {(showAdd || (data !== null && data.contacts.length === 0)) && (
        <GlassCard accent style={{ gap: 10 }}>
          <View style={styles.addHead}>
            <Icon name="add-person" size={20} color={C7.teal} />
            <Text style={styles.cardTitle}>Add a contact</Text>
            {data !== null && data.contacts.length > 0 && (
              <Pressable onPress={() => { setShowAdd(false); onAddingChange?.(false); }} accessibilityRole="button" hitSlop={8} style={{ marginLeft: 'auto' }}>
                <Icon name="close" size={16} color={C7.muted} />
              </Pressable>
            )}
          </View>
          <View style={styles.addRow}>
            <TextInput
              style={styles.input}
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="c7username"
              placeholderTextColor={C7.faint}
              onSubmitEditing={() => void add()}
            />
            <Pressable onPress={() => void add()} disabled={busy || username.trim().length === 0} accessibilityRole="button" style={[styles.addButton, (busy || username.trim().length === 0) && styles.disabled]}>
              {busy ? <ActivityIndicator color="#ffffff" size="small" /> : <Text style={styles.addLabel}>Add</Text>}
            </Pressable>
          </View>
          {notice !== null && <Text style={styles.notice}>{notice}</Text>}
        </GlassCard>
      )}

      {data !== null && data.requests.length > 0 && (
        <>
          <SectionHeading title="Requests" subtitle="People who asked to connect with you." />
          {data.requests.map((person) => (
            <GlassCard key={person.accountId} padded={false} style={styles.row}>
              <AvatarView accountId={person.accountId} name={personName(person)} size={48} />
              <View style={styles.rowText}>
                <Text style={styles.name}>{personName(person)}</Text>
                {person.username !== null && <Text style={styles.handle}>@{person.username}</Text>}
              </View>
              <View style={styles.requestActions}>
                <PrimaryButton label="Accept" onPress={() => void act(() => api.acceptContact(person.accountId))} />
                <Pressable onPress={() => void act(() => api.blockContact(person.accountId))} accessibilityRole="button" style={styles.quiet}>
                  <Text style={styles.quietLabel}>Block</Text>
                </Pressable>
              </View>
            </GlassCard>
          ))}
        </>
      )}

      <SectionHeading title="Contacts" action={data !== null && data.contacts.length > 0 ? `${data.contacts.length}` : undefined} />
      {data === null && <ActivityIndicator color={C7.teal} />}
      {data !== null && data.contacts.length === 0 && (
        <Text style={styles.emptyBody}>Nobody yet. Being contacts is what lets you ring, message and send voice notes to each other.</Text>
      )}
      {data?.contacts.map((person) => (
        <GlassCard key={person.accountId} padded={false} style={styles.row}>
          <Pressable onPress={() => onOpenPerson(person)} accessibilityRole="button" accessibilityLabel={`Open ${personName(person)}'s profile`} style={styles.personTap}>
            <AvatarView accountId={person.accountId} name={personName(person)} size={54} />
            <View style={styles.rowText}>
              <Text style={styles.name} numberOfLines={1}>{personName(person)}</Text>
              {person.username !== null && <Text style={styles.handle}>@{person.username}</Text>}
            </View>
          </Pressable>
          <RoundIconButton label="Message" onPress={() => onMessage(person)}>
            <Icon name="message" size={20} color={C7.text} />
          </RoundIconButton>
          <RoundIconButton label="Call" onPress={() => onCall(person)}>
            <Icon name="phone" size={20} color={C7.text} />
          </RoundIconButton>
          <Pressable onPress={() => setMenuFor(menuFor === person.accountId ? null : person.accountId)} accessibilityRole="button" accessibilityLabel="More" hitSlop={8} style={styles.more}>
            <Icon name="more" size={20} color={C7.muted} />
          </Pressable>
          {menuFor === person.accountId && (
            <View style={styles.menu}>
              <Pressable onPress={() => { setMenuFor(null); remove(person); }} accessibilityRole="button" style={styles.menuItem}>
                <Icon name="close" size={16} color={C7.red} />
                <Text style={styles.menuDanger}>Remove contact</Text>
              </Pressable>
            </View>
          )}
        </GlassCard>
      ))}

      {data !== null && data.sent.length > 0 && (
        <>
          <SectionHeading title="Waiting for an answer" />
          {data.sent.map((person) => (
            <GlassCard key={person.accountId} padded={false} style={styles.row}>
              <AvatarView accountId={person.accountId} name={personName(person)} size={44} />
              <View style={styles.rowText}>
                <Text style={styles.name}>{personName(person)}</Text>
                <Text style={styles.pending}>Requested · not yet accepted</Text>
              </View>
            </GlassCard>
          ))}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  screen: { padding: 16, gap: 12, paddingBottom: 40 },
  addHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardTitle: { color: C7.text, fontSize: 18, fontWeight: '600', fontFamily: 'serif' },
  addRow: { flexDirection: 'row', gap: 8 },
  input: { flex: 1, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: C7.panelEdge, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, color: C7.text, fontSize: 15 },
  addButton: { paddingHorizontal: 18, borderRadius: 12, backgroundColor: C7.tealDeep, borderWidth: 1, borderColor: 'rgba(62,201,192,0.7)', alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.45 },
  addLabel: { color: '#ffffff', fontSize: 15, fontWeight: '700' },
  notice: { color: C7.amber, fontSize: 12, lineHeight: 17 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
  personTap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  rowText: { flex: 1, gap: 2 },
  name: { color: C7.text, fontSize: 18, fontWeight: '600', fontFamily: 'serif' },
  handle: { color: C7.muted, fontSize: 13 },
  requestActions: { alignItems: 'flex-end', gap: 4 },
  quiet: { paddingHorizontal: 10, paddingVertical: 6 },
  quietLabel: { color: C7.muted, fontSize: 13 },
  more: { padding: 6 },
  menu: { position: 'absolute', right: 10, top: 56, backgroundColor: '#0e1826', borderWidth: 1, borderColor: C7.panelEdge, borderRadius: 12, padding: 6, zIndex: 10, elevation: 6 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  menuDanger: { color: C7.red, fontSize: 14, fontWeight: '600' },
  pending: { color: C7.muted, fontSize: 12, fontStyle: 'italic' },
  emptyBody: { color: C7.muted, fontSize: 14, lineHeight: 20 },
});
