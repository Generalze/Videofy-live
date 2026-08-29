/** @author masterzee001 */
/**
 * Chats, to canon: search, four filters, one card per conversation with the
 * person, their handle, the last line, when, and what is unread.
 *
 * POLLING, NOT A SOCKET, and that is a considered trade rather than a gap.
 * The push notification is the realtime channel; this list only needs to be
 * current while somebody is looking at it.
 *
 * FILTERS ARE TRUTHFUL. "Translated" shows conversations whose last message
 * carried a rendering; "Calls" shows the conversations whose last item is a
 * call (the server merges calls into each thread). Nothing is invented.
 */
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { AvatarView } from '../media/AvatarView';
import type { Api, ContactPerson, ConversationEntry } from '../api/client';
import { formatDuration } from '../media/voiceNotes';
import { C7, Chip, GlassCard } from '../ui/c7';
import { Icon } from '../ui/icons';

const POLL_MS = 5000;

type Filter = 'all' | 'unread' | 'translated' | 'calls' | 'archived';

function personName(person: ContactPerson): string {
  return person.displayName ?? person.username ?? person.accountId;
}

function preview(entry: ConversationEntry, selfId: string): string {
  const prefix = entry.last.senderId === selfId ? 'You: ' : '';
  if (entry.last.kind === 'voice') {
    return `${prefix}Voice note (${formatDuration(entry.last.mediaDurationMs)})`;
  }
  return `${prefix}${entry.last.translatedBody ?? entry.last.body ?? ''}`;
}

function when(atMs: number): string {
  const date = new Date(atMs);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export interface ConversationsScreenProps {
  readonly api: Api;
  readonly selfId: string;
  readonly onOpen: (partner: ContactPerson) => void;
  /** Their picture opens their profile; the row opens the chat. */
  readonly onOpenPerson: (partner: ContactPerson) => void;
  /** Where to send somebody whose list is empty: their people. */
  readonly onFindContacts: () => void;
}

export function ConversationsScreen({ api, selfId, onOpen, onOpenPerson, onFindContacts }: ConversationsScreenProps): JSX.Element {
  const [entries, setEntries] = useState<readonly ConversationEntry[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(async () => {
    const result = await api.conversations();
    if (result.ok) setEntries(result.value);
  }, [api]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (entries ?? []).filter((entry) => {
      // Archived conversations live under their own filter and nowhere else.
      if (filter === 'archived') return entry.archived === true;
      if (entry.archived === true) return false;
      if (filter === 'unread' && entry.unread === 0) return false;
      if (filter === 'translated' && entry.last.translatedBody == null) return false;
      if (filter === 'calls' && (entry.last as { kind: string }).kind !== 'call') return false;
      if (q.length === 0) return true;
      return personName(entry.partner).toLowerCase().includes(q) || (entry.partner.username ?? '').toLowerCase().includes(q);
    });
  }, [entries, filter, query]);

  return (
    <FlatList
      style={styles.list}
      contentContainerStyle={[styles.content, entries?.length === 0 && styles.emptyWrap]}
      data={visible}
      keyExtractor={(entry) => entry.partner.accountId}
      ListHeaderComponent={
        <View style={styles.top}>
          <View style={styles.search}>
            <Icon name="search" size={18} color={C7.muted} />
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="Search"
              placeholderTextColor={C7.faint}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Icon name="filter" size={18} color={C7.muted} />
          </View>
          <View style={styles.filters}>
            {(
              [
                ['all', 'All'],
                ['unread', 'Unread'],
                ['translated', 'Translated'],
                ['calls', 'Calls'],
                ['archived', 'Archived'],
              ] as const
            ).map(([key, label]) => (
              <Chip key={key} label={label} active={filter === key} onPress={() => setFilter(key)} />
            ))}
          </View>
        </View>
      }
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={C7.teal}
          onRefresh={() => {
            setRefreshing(true);
            void load().finally(() => setRefreshing(false));
          }}
        />
      }
      ListEmptyComponent={
        entries === null ? null : (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>{filter === 'all' && query.length === 0 ? 'No conversations yet' : 'Nothing here'}</Text>
            {filter === 'all' && query.length === 0 && (
              <>
                <Text style={styles.emptyBody}>Messages are between contacts. Add somebody by their C7 username and say hello.</Text>
                <Pressable onPress={onFindContacts} accessibilityRole="button" style={styles.emptyLink}>
                  <Text style={styles.emptyLinkLabel}>Go to People ›</Text>
                </Pressable>
              </>
            )}
          </View>
        )
      }
      renderItem={({ item }) => {
        const translated = item.last.translatedBody != null;
        return (
          <Pressable style={({ pressed }) => pressed && styles.pressed} onPress={() => onOpen(item.partner)} accessibilityRole="button">
            <GlassCard padded={false} style={styles.row}>
              <Pressable onPress={() => onOpenPerson(item.partner)} accessibilityRole="button" accessibilityLabel={`Open ${personName(item.partner)}'s profile`}>
                <AvatarView accountId={item.partner.accountId} name={personName(item.partner)} size={50} />
              </Pressable>
              <View style={styles.rowText}>
                <View style={styles.rowTop}>
                  <Text style={styles.name} numberOfLines={1}>{personName(item.partner)}</Text>
                  <View style={styles.rowWhen}>
                    {item.muted === true && <Icon name="bell" size={12} color={C7.faint} />}
                    <Text style={styles.when}>{when(item.last.createdAtMs)}</Text>
                  </View>
                </View>
                {item.partner.username !== null && <Text style={styles.handle}>@{item.partner.username}</Text>}
                <Text style={[styles.preview, item.unread > 0 && styles.previewUnread]} numberOfLines={2}>
                  {preview(item, selfId)}
                </Text>
                {translated && (
                  <View style={styles.translated}>
                    <Icon name="translate" size={13} color={C7.teal} />
                    <Text style={styles.translatedLabel}>
                      {item.last.translatedLanguage ? `Translated to ${item.last.translatedLanguage.toUpperCase()}` : 'Translated'}
                    </Text>
                  </View>
                )}
              </View>
              {item.unread > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeLabel}>{item.unread > 99 ? '99+' : item.unread}</Text>
                </View>
              )}
            </GlassCard>
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  content: { paddingHorizontal: 16, paddingBottom: 24, gap: 10 },
  top: { gap: 12, paddingBottom: 4 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 999, borderWidth: 1, borderColor: C7.panelEdge, backgroundColor: 'rgba(255,255,255,0.04)', paddingHorizontal: 16, paddingVertical: 4 },
  searchInput: { flex: 1, color: C7.text, fontSize: 16, paddingVertical: 9 },
  filters: { flexDirection: 'row', gap: 8 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 14 },
  pressed: { opacity: 0.75 },
  rowText: { flex: 1, gap: 3 },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 },
  name: { color: C7.text, fontSize: 19, fontWeight: '600', fontFamily: 'serif', flexShrink: 1 },
  when: { color: C7.muted, fontSize: 12 },
  rowWhen: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  handle: { color: C7.muted, fontSize: 13 },
  preview: { color: C7.muted, fontSize: 14, lineHeight: 19, marginTop: 2 },
  previewUnread: { color: C7.text },
  translated: { flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start', backgroundColor: C7.tealSoft, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3, marginTop: 4 },
  translatedLabel: { color: C7.teal, fontSize: 12, fontWeight: '600' },
  badge: { minWidth: 24, height: 24, borderRadius: 12, backgroundColor: C7.teal, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 7, marginTop: 20 },
  badgeLabel: { color: C7.ground, fontSize: 12, fontWeight: '700' },
  emptyWrap: { flexGrow: 1, justifyContent: 'center' },
  empty: { alignItems: 'center', gap: 8, paddingHorizontal: 32, paddingTop: 40 },
  emptyTitle: { color: C7.text, fontSize: 19, fontWeight: '600', fontFamily: 'serif' },
  emptyBody: { color: C7.muted, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  emptyLink: { marginTop: 8, paddingVertical: 8, paddingHorizontal: 16 },
  emptyLinkLabel: { color: C7.teal, fontSize: 15, fontWeight: '600' },
});
