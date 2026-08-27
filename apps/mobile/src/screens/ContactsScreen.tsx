/** @author masterzee001 */
/**
 * The contact graph: who can reach you, and who you have asked.
 *
 * REQUESTS TO ANSWER COME FIRST. A request somebody sent you is the only thing
 * on this screen you can act on that affects THEM; everything else is
 * housekeeping. The server already refuses to list your own requests as
 * answerable, so this screen cannot offer accepting yourself.
 *
 * ADDING IS BY USERNAME AND THE ANSWER IS DELIBERATELY FLAT. A username that
 * does not exist, an account that is private, and a person who has blocked you
 * all answer the same way server-side; this screen passes that sentence
 * through untouched rather than decorating it into an oracle.
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
import type { Api, ContactPerson, ContactsResponse } from '../api/client';

function personName(person: ContactPerson): string {
  return person.displayName ?? person.username ?? person.accountId;
}

export interface ContactsScreenProps {
  readonly api: Api;
  readonly onMessage: (partner: ContactPerson) => void;
  readonly onCall: (partner: ContactPerson) => void;
}

export function ContactsScreen({ api, onMessage, onCall }: ContactsScreenProps): JSX.Element {
  const [data, setData] = useState<ContactsResponse | null>(null);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

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
      setNotice(result.error);
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

  return (
    <ScrollView style={styles.fill} contentContainerStyle={styles.screen}>
      <View style={styles.addCard}>
        <Text style={styles.cardTitle}>Add a contact</Text>
        <View style={styles.addRow}>
          <TextInput
            style={styles.input}
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="c7username"
            placeholderTextColor="#4a545f"
            onSubmitEditing={() => void add()}
          />
          <Pressable
            onPress={() => void add()}
            disabled={busy || username.trim().length === 0}
            accessibilityRole="button"
            style={[styles.addButton, (busy || username.trim().length === 0) && styles.disabled]}
          >
            {busy ? (
              <ActivityIndicator color="#0b0f14" size="small" />
            ) : (
              <Text style={styles.addLabel}>Add</Text>
            )}
          </Pressable>
        </View>
        {notice !== null && <Text style={styles.notice}>{notice}</Text>}
      </View>

      {data !== null && data.requests.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Requests for you</Text>
          {data.requests.map((person) => (
            <View key={person.accountId} style={styles.row}>
              <Text style={styles.name}>{personName(person)}</Text>
              <View style={styles.actions}>
                <Pressable
                  onPress={() => void act(() => api.acceptContact(person.accountId))}
                  accessibilityRole="button"
                  style={styles.primaryAction}
                >
                  <Text style={styles.primaryActionLabel}>Accept</Text>
                </Pressable>
                <Pressable
                  onPress={() => void act(() => api.blockContact(person.accountId))}
                  accessibilityRole="button"
                  style={styles.quietAction}
                >
                  <Text style={styles.quietActionLabel}>Block</Text>
                </Pressable>
              </View>
            </View>
          ))}
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Contacts</Text>
        {data === null && <ActivityIndicator color="#3ec9c0" />}
        {data !== null && data.contacts.length === 0 && (
          <Text style={styles.emptyBody}>
            Nobody yet. Being contacts is what lets you ring, message and send voice notes to each
            other.
          </Text>
        )}
        {data?.contacts.map((person) => (
          <View key={person.accountId} style={styles.row}>
            <View style={styles.rowText}>
              <Text style={styles.name}>{personName(person)}</Text>
              {person.username !== null && <Text style={styles.handle}>{person.username}</Text>}
            </View>
            <View style={styles.actions}>
              <Pressable
                onPress={() => onMessage(person)}
                accessibilityRole="button"
                style={styles.primaryAction}
              >
                <Text style={styles.primaryActionLabel}>Message</Text>
              </Pressable>
              <Pressable
                onPress={() => onCall(person)}
                accessibilityRole="button"
                style={styles.primaryAction}
              >
                <Text style={styles.primaryActionLabel}>Call</Text>
              </Pressable>
              <Pressable
                onPress={() => void act(() => api.removeContact(person.accountId))}
                accessibilityRole="button"
                style={styles.quietAction}
              >
                <Text style={styles.quietActionLabel}>Remove</Text>
              </Pressable>
            </View>
          </View>
        ))}
      </View>

      {data !== null && data.sent.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Waiting for an answer</Text>
          {data.sent.map((person) => (
            <View key={person.accountId} style={styles.row}>
              <Text style={styles.name}>{personName(person)}</Text>
              <Text style={styles.pending}>requested</Text>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#0b0f14' },
  screen: { padding: 16, gap: 18, paddingBottom: 40 },

  addCard: {
    backgroundColor: '#141a21',
    borderWidth: 1,
    borderColor: '#273039',
    borderRadius: 12,
    padding: 14,
    gap: 10,
  },
  cardTitle: { color: '#e4ebf1', fontSize: 16, fontWeight: '600' },
  addRow: { flexDirection: 'row', gap: 8 },
  input: {
    flex: 1,
    backgroundColor: '#0b0f14',
    borderWidth: 1,
    borderColor: '#273039',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: '#e4ebf1',
    fontSize: 15,
  },
  addButton: {
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: '#3ec9c0',
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: { backgroundColor: '#1f3a38' },
  addLabel: { color: '#0b0f14', fontSize: 15, fontWeight: '700' },
  notice: { color: '#d9a441', fontSize: 12 },

  section: { gap: 8 },
  sectionTitle: {
    color: '#5d6874',
    fontSize: 12,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#161d25',
  },
  rowText: { gap: 2, flexShrink: 1 },
  name: { color: '#e4ebf1', fontSize: 15, fontWeight: '600' },
  handle: { color: '#5d6874', fontSize: 12, fontFamily: 'monospace' },
  actions: { flexDirection: 'row', gap: 6 },
  primaryAction: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 8,
    backgroundColor: '#10312f',
    borderWidth: 1,
    borderColor: '#1f4d49',
  },
  primaryActionLabel: { color: '#3ec9c0', fontSize: 13, fontWeight: '600' },
  quietAction: { paddingHorizontal: 10, paddingVertical: 7 },
  quietActionLabel: { color: '#5d6874', fontSize: 13 },
  pending: { color: '#5d6874', fontSize: 12, fontStyle: 'italic' },
  emptyBody: { color: '#8d99a6', fontSize: 14, lineHeight: 20 },
});
