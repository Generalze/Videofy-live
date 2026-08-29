/** @author masterzee001 */
/**
 * C7 Streams: the discovery surface.
 *
 * WHAT IS ON, FROM THE SAME DIRECTORY THE WEB SHOWS. The gateway's
 * channel:directory feed is the only source; the phone adds search and a
 * live/upcoming split and nothing it cannot back with data -- no invented
 * viewer counts, no categories the channels do not carry yet. A channel
 * opens the web viewer, which is where programmes play today.
 *
 * THE ADVERT SLOT IS PART OF THE LAYOUT (founder ruling 29 Aug): reserved,
 * separated, silent, below the channel list and above the tab bar.
 */
import { useEffect, useMemo, useState, type JSX } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { listenerUrlFor, subscribeChannelDirectory, type ChannelSummary } from '../api/channelDirectory';
import { AdSlot } from '../ui/AdSlot';
import { C7, Chip, GlassCard, SectionHeading } from '../ui/c7';
import { Icon } from '../ui/icons';

const GATEWAY_URL = process.env['EXPO_PUBLIC_GATEWAY_URL'] ?? 'https://staging.consummate7.com';
const LISTEN_URL = process.env['EXPO_PUBLIC_LISTEN_URL'] ?? `${GATEWAY_URL}/listen`;

type Filter = 'all' | 'live' | 'off';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('');
}

export function ProgrammesScreen(): JSX.Element {
  const [channels, setChannels] = useState<readonly ChannelSummary[] | null>(null);
  const [link, setLink] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    const subscription = subscribeChannelDirectory(GATEWAY_URL, setChannels, setLink);
    return () => subscription.close();
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (channels ?? [])
      .filter((channel) => (filter === 'all' ? true : filter === 'live' ? channel.live : !channel.live))
      .filter((channel) => (q.length === 0 ? true : channel.displayName.toLowerCase().includes(q)))
      .sort((a, b) => Number(b.live) - Number(a.live) || a.displayName.localeCompare(b.displayName));
  }, [channels, filter, query]);

  const featured = (channels ?? []).find((channel) => channel.live) ?? null;

  const open = (channel: ChannelSummary): void => {
    void Linking.openURL(listenerUrlFor(LISTEN_URL, channel.channelId));
  };

  return (
    <ScrollView style={styles.fill} contentContainerStyle={styles.screen}>
      {featured !== null && (
        <GlassCard accent style={styles.featured}>
          <View style={styles.featuredArt}>
            <Text style={styles.featuredInitials}>{initials(featured.displayName)}</Text>
          </View>
          <View style={{ flex: 1, gap: 8 }}>
            <Chip label="Live now" tone="live" />
            <Text style={styles.featuredTitle}>{featured.displayName}</Text>
            <Text style={styles.featuredBody}>Watching now, in your language.</Text>
            <Pressable onPress={() => open(featured)} accessibilityRole="button" style={({ pressed }) => [styles.watch, pressed && styles.pressed]}>
              <Icon name="programmes" size={18} color="#ffffff" />
              <Text style={styles.watchLabel}>Watch</Text>
            </Pressable>
          </View>
        </GlassCard>
      )}

      <View style={styles.filters}>
        <Chip label="All" active={filter === 'all'} onPress={() => setFilter('all')} />
        <Chip label="Live" active={filter === 'live'} onPress={() => setFilter('live')} />
        <Chip label="Off air" active={filter === 'off'} onPress={() => setFilter('off')} />
      </View>

      <SectionHeading title="Discoverable channels" subtitle="Public channels you can watch and join." />
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
      </View>

      {channels === null && (
        <Text style={styles.empty}>{link === 'disconnected' ? 'Could not reach C7 Streams. Check your connection.' : 'Finding channels…'}</Text>
      )}
      {channels !== null && visible.length === 0 && (
        <Text style={styles.empty}>{query.length > 0 ? 'No channel matches that.' : 'No public channels are listed right now.'}</Text>
      )}
      {visible.map((channel) => (
        <Pressable key={channel.channelId} onPress={() => open(channel)} accessibilityRole="button" style={({ pressed }) => pressed && styles.pressed}>
          <GlassCard padded={false} style={styles.row}>
            <View style={[styles.art, channel.live && styles.artLive]}>
              <Text style={styles.artInitials}>{initials(channel.displayName)}</Text>
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <View style={styles.titleRow}>
                <Text style={styles.rowTitle} numberOfLines={1}>{channel.displayName}</Text>
                {channel.live ? <Chip label="Live" tone="live" /> : <Chip label="Off air" tone="amber" />}
              </View>
              <View style={styles.metaRow}>
                <Icon name={channel.visibility === 'public' ? 'globe' : 'lock'} size={14} color={C7.muted} />
                <Text style={styles.meta}>{channel.visibility === 'public' ? 'Public' : channel.visibility === 'private' ? 'Private · Link-only' : 'Locked'}</Text>
              </View>
            </View>
            <Icon name="chevron" size={18} color={C7.muted} />
          </GlassCard>
        </Pressable>
      ))}

      <AdSlot />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  screen: { padding: 16, gap: 14, paddingBottom: 32 },
  featured: { flexDirection: 'row', gap: 14, padding: 14 },
  featuredArt: { width: 110, borderRadius: 14, backgroundColor: 'rgba(62,201,192,0.14)', alignItems: 'center', justifyContent: 'center', minHeight: 130 },
  featuredInitials: { color: C7.teal, fontSize: 30, fontWeight: '700', fontFamily: 'serif' },
  featuredTitle: { color: C7.text, fontSize: 24, fontWeight: '600', fontFamily: 'serif' },
  featuredBody: { color: C7.muted, fontSize: 13 },
  watch: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: C7.tealDeep, borderRadius: 999, paddingVertical: 11, marginTop: 4 },
  watchLabel: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  filters: { flexDirection: 'row', gap: 8 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 999, borderWidth: 1, borderColor: C7.panelEdge, backgroundColor: 'rgba(255,255,255,0.04)', paddingHorizontal: 14, paddingVertical: 4 },
  searchInput: { flex: 1, color: C7.text, fontSize: 15, paddingVertical: 8 },
  empty: { color: C7.muted, fontSize: 14, textAlign: 'center', paddingVertical: 18 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  art: { width: 58, height: 58, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.05)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C7.panelEdge },
  artLive: { backgroundColor: 'rgba(62,201,192,0.12)', borderColor: 'rgba(62,201,192,0.35)' },
  artInitials: { color: C7.text, fontSize: 18, fontWeight: '700', fontFamily: 'serif' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowTitle: { color: C7.text, fontSize: 17, fontWeight: '600', fontFamily: 'serif', flexShrink: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  meta: { color: C7.muted, fontSize: 12 },
  pressed: { opacity: 0.75 },
});
