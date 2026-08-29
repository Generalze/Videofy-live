/** @author masterzee001 */
/**
 * People, to canon: requests that need an answer first, then suggested
 * connections, then your contacts with Message and Call beside each and a
 * quiet menu for the rest, and last the ones still waiting on the other
 * person.
 *
 * PRESENCE IS THE SERVER'S WORD. A contact shows "Active now", "Busy" or
 * "Away" only when GET /presence answered for them -- and it only answers
 * for accepted contacts. Nobody else gets a dot, so a dot never claims a
 * relationship that does not exist. The answer is refreshed once a minute
 * while this tab is open; the contact list itself every eight seconds.
 *
 * ADDING IS BY USERNAME AND THE ANSWER IS DELIBERATELY FLAT. A username
 * that does not exist, an account that is private, and a person who has
 * blocked you all answer the same way server-side.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from 'react-native';
import { AvatarView } from '../media/AvatarView';
import type { Api, ContactPerson, ContactsResponse, PresenceState, SuggestedPerson } from '../api/client';
import { contactShareMessage, languageName, PRESENCE_WORDS, personName, suggestionSubtitle, withPresence } from '../people/people';
import { C7, Chip, GlassCard, PresenceDot, PrimaryButton, RoundIconButton, SectionHeading } from '../ui/c7';
import { Icon } from '../ui/icons';

export interface ContactsScreenProps {
  readonly api: Api;
  readonly onMessage: (partner: ContactPerson) => void;
  readonly onCall: (partner: ContactPerson) => void;
  /** Their picture or name opens their profile. */
  readonly onOpenPerson: (partner: ContactPerson) => void;
  /** Opened by the header's add-person control. */
  readonly adding?: boolean;
  readonly onAddingChange?: (adding: boolean) => void;
  /** The signed-in person, for "Share my contact". Null until known; no username hides the link. */
  readonly self: { readonly username: string | null; readonly displayName: string | null } | null;
}

export function ContactsScreen({ api, onMessage, onCall, onOpenPerson, adding = false, onAddingChange, self }: ContactsScreenProps): JSX.Element {
  const [data, setData] = useState<ContactsResponse | null>(null);
  const [suggestions, setSuggestions] = useState<readonly SuggestedPerson[] | null>(null);
  const [presence, setPresence] = useState<Readonly<Record<string, PresenceState>>>({});
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [suggestionNotice, setSuggestionNotice] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(adding);

  useEffect(() => {
    if (adding) setShowAdd(true);
  }, [adding]);

  const load = useCallback(async () => {
    const result = await api.contacts();
    if (result.ok) setData(result.value);
  }, [api]);

  const loadSuggestions = useCallback(async () => {
    const result = await api.suggestions();
    if (result.ok) setSuggestions(result.value);
    else setSuggestions((current) => current ?? []);
  }, [api]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 8000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    void loadSuggestions();
  }, [loadSuggestions]);

  /* Presence for accepted contacts only, once a minute while mounted. Keyed on the ids so a changed list asks at once. */
  const contactIds = useMemo(() => (data?.contacts ?? []).map((person) => person.accountId).join(','), [data]);
  useEffect(() => {
    if (contactIds.length === 0) return undefined;
    const ids = contactIds.split(',');
    let live = true;
    const refresh = async (): Promise<void> => {
      const result = await api.presence(ids);
      if (live && result.ok) setPresence(result.value);
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [api, contactIds]);

  const add = useCallback(async () => {
    const handle = username.trim();
    if (handle.length === 0 || busy) return;
    setBusy(true);
    setNotice(null);
    const result = await api.requestContact(handle);
    if (result.ok) {
      setUsername('');
      setNotice('Request sent.');
      await Promise.all([load(), loadSuggestions()]);
    } else {
      setNotice(
        result.status === 404
          ? `No discoverable account named ${handle}. Ask them to switch on Discoverable in their Profile, then try again.`
          : result.error,
      );
    }
    setBusy(false);
  }, [api, busy, load, loadSuggestions, username]);

  const addSuggested = useCallback(
    async (person: SuggestedPerson) => {
      if (person.username === null) return;
      setSuggestionNotice(null);
      const result = await api.requestContact(person.username);
      if (result.ok) {
        setSuggestions((current) => (current ?? []).filter((candidate) => candidate.accountId !== person.accountId));
        setSuggestionNotice('Request sent.');
        await load();
      } else {
        setSuggestionNotice(result.error);
      }
    },
    [api, load],
  );

  const act = useCallback(
    async (action: () => ReturnType<Api['acceptContact']>) => {
      setNotice(null);
      const result = await action();
      if (!result.ok) setNotice(result.error);
      await Promise.all([load(), loadSuggestions()]);
    },
    [load, loadSuggestions],
  );

  const remove = (person: ContactPerson): void => {
    const name = personName(person);
    Alert.alert(`Remove ${name}?`, `${name} will be removed from your contacts. You can add each other again later.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void act(() => api.removeContact(person.accountId)) },
    ]);
  };

  const share = (person: { readonly displayName: string | null; readonly username: string | null; readonly accountId: string }): void => {
    if (person.username === null) return;
    void Share.share({ message: contactShareMessage(personName(person), person.username) });
  };

  const contacts = data === null ? [] : withPresence(data.contacts, presence);
  const selfUsername = self?.username ?? null;

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
          {selfUsername !== null && (
            <Pressable
              onPress={() => share({ accountId: selfUsername, username: selfUsername, displayName: self?.displayName ?? null })}
              accessibilityRole="button"
              hitSlop={6}
              style={styles.shareSelf}
            >
              <Icon name="share" size={16} color={C7.teal} />
              <Text style={styles.shareSelfLabel}>Share my contact</Text>
            </Pressable>
          )}
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

      <SectionHeading title="Suggested connections" subtitle="People you may know. Nobody already in your contacts." />
      {suggestions === null && <ActivityIndicator color={C7.teal} />}
      {suggestions !== null && suggestions.length === 0 && (
        <Text style={styles.emptyBody}>No suggestions yet. Add people by username.</Text>
      )}
      {suggestions?.map((person) => (
        <GlassCard key={person.accountId} padded={false} style={styles.row}>
          <Pressable onPress={() => onOpenPerson(person)} accessibilityRole="button" accessibilityLabel={`Open ${personName(person)}'s profile`} style={styles.personTap}>
            <AvatarView accountId={person.accountId} name={personName(person)} size={48} />
            <View style={styles.rowText}>
              <View style={styles.nameRow}>
                <Text style={styles.name} numberOfLines={1}>{personName(person)}</Text>
                {person.official === true && <Chip label="C7" tone="teal" />}
              </View>
              {person.username !== null && <Text style={styles.handle}>@{person.username}</Text>}
              <View style={styles.subtitleRow}>
                <Icon name="people" size={13} color={C7.teal} />
                <Text style={styles.subtitle}>{suggestionSubtitle(person)}</Text>
              </View>
            </View>
          </Pressable>
          {person.username !== null && (
            <RoundIconButton label="Add" tone="teal" onPress={() => void addSuggested(person)}>
              <Icon name="add-person" size={20} color={C7.teal} />
            </RoundIconButton>
          )}
        </GlassCard>
      ))}
      {suggestionNotice !== null && <Text style={styles.notice}>{suggestionNotice}</Text>}

      <SectionHeading title="Contacts" action={data !== null && data.contacts.length > 0 ? `${data.contacts.length}` : undefined} />
      {data === null && <ActivityIndicator color={C7.teal} />}
      {data !== null && data.contacts.length === 0 && (
        <Text style={styles.emptyBody}>Nobody yet. Being contacts is what lets you ring, message and send voice notes to each other.</Text>
      )}
      {contacts.map((person) => (
        <GlassCard key={person.accountId} padded={false} style={styles.row}>
          <Pressable onPress={() => onOpenPerson(person)} accessibilityRole="button" accessibilityLabel={`Open ${personName(person)}'s profile`} style={styles.personTap}>
            <View>
              <AvatarView accountId={person.accountId} name={personName(person)} size={54} />
              {person.presence !== undefined && (
                <View style={styles.presenceBadge}>
                  <PresenceDot state={person.presence} size={14} />
                </View>
              )}
            </View>
            <View style={styles.rowText}>
              <Text style={styles.name} numberOfLines={1}>{personName(person)}</Text>
              {person.username !== null && <Text style={styles.handle}>@{person.username}</Text>}
              {person.presence !== undefined && (
                <View style={styles.subtitleRow}>
                  <PresenceDot state={person.presence} size={8} />
                  <Text style={[styles.presenceWords, person.presence === 'active' && styles.presenceActive]}>{PRESENCE_WORDS[person.presence]}</Text>
                </View>
              )}
              {typeof person.spokenLanguage === 'string' && person.spokenLanguage.length > 0 && (
                <View style={styles.chips}>
                  <Chip label={`Speaks ${languageName(person.spokenLanguage)}`} tone="teal" />
                </View>
              )}
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
              <Pressable onPress={() => { setMenuFor(null); onOpenPerson(person); }} accessibilityRole="button" style={styles.menuItem}>
                <Icon name="profile" size={16} color={C7.text} />
                <Text style={styles.menuLabel}>View profile</Text>
              </Pressable>
              {person.username !== null && (
                <Pressable onPress={() => { setMenuFor(null); share(person); }} accessibilityRole="button" style={styles.menuItem}>
                  <Icon name="share" size={16} color={C7.text} />
                  <Text style={styles.menuLabel}>Share contact</Text>
                </Pressable>
              )}
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
  shareSelf: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start', paddingVertical: 4 },
  shareSelfLabel: { color: C7.teal, fontSize: 14, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
  personTap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  presenceBadge: { position: 'absolute', right: -1, bottom: -1 },
  rowText: { flex: 1, gap: 3 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { color: C7.text, fontSize: 18, fontWeight: '600', fontFamily: 'serif', flexShrink: 1 },
  handle: { color: C7.muted, fontSize: 13 },
  subtitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  subtitle: { color: C7.muted, fontSize: 13 },
  presenceWords: { color: C7.muted, fontSize: 13 },
  presenceActive: { color: C7.green },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  requestActions: { alignItems: 'flex-end', gap: 4 },
  quiet: { paddingHorizontal: 10, paddingVertical: 6 },
  quietLabel: { color: C7.muted, fontSize: 13 },
  more: { padding: 6 },
  menu: { position: 'absolute', right: 10, top: 56, backgroundColor: '#0e1826', borderWidth: 1, borderColor: C7.panelEdge, borderRadius: 12, padding: 6, zIndex: 10, elevation: 6 },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  menuLabel: { color: C7.text, fontSize: 14, fontWeight: '600' },
  menuDanger: { color: C7.red, fontSize: 14, fontWeight: '600' },
  pending: { color: C7.muted, fontSize: 12, fontStyle: 'italic' },
  emptyBody: { color: C7.muted, fontSize: 14, lineHeight: 20 },
});
