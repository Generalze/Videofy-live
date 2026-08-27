/** @author masterzee001 */
/**
 * Every conversation, most recent first, with what is unread.
 *
 * POLLING, NOT A SOCKET, and that is a considered trade rather than a gap. The
 * push notification is the realtime channel -- a new message pings the phone
 * through FCM -- and this list only needs to be current while somebody is
 * actually looking at it. A five-second poll over an indexed query costs
 * almost nothing; a persistent socket per idle app costs the gateway a
 * connection per user forever. If polling ever shows its seams, the socket
 * belongs in the gateway alongside the call events, not bolted on here.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { AvatarView } from '../media/AvatarView';
import type { Api, ContactPerson, ConversationEntry } from '../api/client';
import { formatDuration } from '../media/voiceNotes';

const POLL_MS = 5000;

function personName(person: ContactPerson): string {
  return person.displayName ?? person.username ?? person.accountId;
}

function preview(entry: ConversationEntry, selfId: string): string {
  const prefix = entry.last.senderId === selfId ? 'You: ' : '';
  if (entry.last.kind === 'voice') {
    return `${prefix}Voice note (${formatDuration(entry.last.mediaDurationMs)})`;
  }
  return `${prefix}${entry.last.body ?? ''}`;
}

export interface ConversationsScreenProps {
  readonly api: Api;
  readonly selfId: string;
  readonly onOpen: (partner: ContactPerson) => void;
  /** Where to send somebody whose list is empty: their contacts. */
  readonly onFindContacts: () => void;
}

export function ConversationsScreen({
  api,
  selfId,
  onOpen,
  onFindContacts,
}: ConversationsScreenProps): JSX.Element {
  const [entries, setEntries] = useState<readonly ConversationEntry[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const result = await api.conversations();
    if (result.ok) setEntries(result.value);
  }, [api]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={entries?.length === 0 ? styles.emptyWrap : undefined}
      data={entries ?? []}
      keyExtractor={(entry) => entry.partner.accountId}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor="#3ec9c0"
          onRefresh={() => {
            setRefreshing(true);
            void load().finally(() => setRefreshing(false));
          }}
        />
      }
      ListEmptyComponent={
        entries === null ? null : (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No conversations yet</Text>
            <Text style={styles.emptyBody}>
              Messages are between contacts. Add somebody by their C7 username and say hello.
            </Text>
            <Pressable onPress={onFindContacts} accessibilityRole="button" style={styles.emptyLink}>
              <Text style={styles.emptyLinkLabel}>Go to contacts</Text>
            </Pressable>
          </View>
        )
      }
      renderItem={({ item }) => (
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          onPress={() => onOpen(item.partner)}
          accessibilityRole="button"
        >
          <AvatarView
            accountId={item.partner.accountId}
            name={personName(item.partner)}
            size={42}
          />
          <View style={styles.rowText}>
            <Text style={styles.name}>{personName(item.partner)}</Text>
            <Text
              style={[styles.preview, item.unread > 0 && styles.previewUnread]}
              numberOfLines={1}
            >
              {preview(item, selfId)}
            </Text>
          </View>
          {item.unread > 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeLabel}>{item.unread > 99 ? '99+' : item.unread}</Text>
            </View>
          )}
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1, backgroundColor: '#0b0f14' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#161d25',
  },
  pressed: { opacity: 0.7 },
  rowText: { flex: 1, gap: 3 },
  name: { color: '#e4ebf1', fontSize: 16, fontWeight: '600' },
  preview: { color: '#5d6874', fontSize: 13 },
  previewUnread: { color: '#8d99a6', fontWeight: '600' },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#3ec9c0',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  badgeLabel: { color: '#0b0f14', fontSize: 12, fontWeight: '700' },

  emptyWrap: { flexGrow: 1, justifyContent: 'center' },
  empty: { alignItems: 'center', gap: 8, paddingHorizontal: 32 },
  emptyTitle: { color: '#e4ebf1', fontSize: 17, fontWeight: '600' },
  emptyBody: { color: '#8d99a6', fontSize: 14, textAlign: 'center', lineHeight: 20 },
  emptyLink: { marginTop: 8, paddingVertical: 8, paddingHorizontal: 16 },
  emptyLinkLabel: { color: '#3ec9c0', fontSize: 15, fontWeight: '600' },
});
