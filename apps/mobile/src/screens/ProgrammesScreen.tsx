/** @author masterzee001 */
/**
 * C7 Streams: the discovery surface.
 *
 * WHAT IS ON, FROM THE SAME DIRECTORY THE WEB SHOWS. The gateway's
 * channel:directory feed is the only source; the phone adds search, the
 * follows and follower counts from the account service, and two chip rows
 * it can back with data -- nothing else. No invented viewer counts, no
 * schedules the channels do not carry.
 *
 * TWO ROWS, TWO MEANINGS (founder ruling 29 Aug 2026, LOCKED): "Categories
 * are an explicit, controlled channel-side field -- one primary category in
 * v1, set by the operator -- never inferred from follows, visibility or
 * live state; Live / Following / Public are filters and are shown as
 * filters." The FILTER row is always there. The CATEGORY row appears only
 * when at least one listed channel carries a category, and lists only the
 * categories present; a channel without one is never given one.
 *
 * INTERESTED = A FOLLOW WITH A REMINDER. Every row has a bell; pressing it
 * follows the channel with `remind` on, so the account service pushes when
 * it goes live. That push ({kind:"channel-live", channelId}) lands here as
 * `openChannelId`, and the channel opens once, in the app's own viewer.
 *
 * THE ADVERT SLOT IS PART OF THE LAYOUT (founder ruling 29 Aug): reserved,
 * separated, silent, below the channel list and above the tab bar.
 */
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { subscribeChannelDirectory, type ChannelSummary } from '../api/channelDirectory';
import type { Api } from '../api/client';
import type { ChannelCategory } from '../programmes/channelCategories';
import {
  FILTER_LABELS,
  categoryLabel,
  deriveCategoryChips,
  deriveFilters,
  describeVisibility,
  filterChannels,
  findChannel,
  formatInterest,
  initials,
  isFollowing,
  resolveCategoryChoice,
  resolveFilter,
  selectFeatured,
  type Filter,
} from '../programmes/programmeCatalogue';
import { useChannelInterest } from '../programmes/useChannelInterest';
import { AdSlot } from '../ui/AdSlot';
import { C7, Chip, GlassCard, SectionHeading } from '../ui/c7';
import { Icon } from '../ui/icons';

const GATEWAY_URL = process.env['EXPO_PUBLIC_GATEWAY_URL'] ?? 'https://staging.consummate7.com';
/** One stable empty list, so the memos and the push-open effect do not re-run on every render before the directory arrives. */
const NO_CHANNELS: readonly ChannelSummary[] = [];

export interface ProgrammesScreenProps {
  readonly api: Api;
  /** Open the in-app viewer for this channel. */
  readonly onOpen: (channel: ChannelSummary) => void;
  /**
   * A channel-live push routed here: when it changes to an id the directory
   * lists, that channel opens once. Set it back to null after the viewer
   * closes so a later push for the same channel opens it again.
   */
  readonly openChannelId?: string | null | undefined;
}

function InterestBell({
  channel,
  following,
  busy,
  onPress,
}: {
  readonly channel: ChannelSummary;
  readonly following: boolean;
  readonly busy: boolean;
  readonly onPress: () => void;
}): JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityState={{ selected: following, disabled: busy }}
      accessibilityLabel={following ? `Stop reminders for ${channel.displayName}` : `Tell me when ${channel.displayName} goes live`}
      hitSlop={6}
      style={({ pressed }) => [styles.bell, following && styles.bellOn, (pressed || busy) && styles.pressed]}
    >
      <Icon name="bell" size={18} color={following ? C7.ground : C7.teal} />
    </Pressable>
  );
}

export function ProgrammesScreen({ api, onOpen, openChannelId = null }: ProgrammesScreenProps): JSX.Element {
  const [channels, setChannels] = useState<readonly ChannelSummary[] | null>(null);
  const [link, setLink] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');
  const [query, setQuery] = useState('');
  const [chosenFilter, setChosenFilter] = useState<Filter>('all');
  const [chosenCategory, setChosenCategory] = useState<ChannelCategory | null>(null);
  const { follows, interest, pending, notice, loadInterest, toggle } = useChannelInterest(api);

  useEffect(() => {
    const subscription = subscribeChannelDirectory(GATEWAY_URL, setChannels, setLink);
    return () => subscription.close();
  }, []);

  useEffect(() => {
    if (channels !== null) loadInterest(channels.map((channel) => channel.channelId));
  }, [channels, loadInterest]);

  const listed = channels ?? NO_CHANNELS;
  const filters = useMemo(() => deriveFilters(listed, follows), [listed, follows]);
  const filter = resolveFilter(chosenFilter, filters);
  const categories = useMemo(() => deriveCategoryChips(listed), [listed]);
  const category = resolveCategoryChoice(chosenCategory, categories);
  const visible = useMemo(
    () => filterChannels(listed, { filter, category, query, follows }),
    [listed, filter, category, query, follows],
  );
  const featured = useMemo(() => selectFeatured(listed, interest), [listed, interest]);

  // The push-routed open: once per id, and only when the directory lists it.
  const handledRef = useRef<string | null>(null);
  useEffect(() => {
    if (openChannelId === null) {
      handledRef.current = null;
      return;
    }
    if (handledRef.current === openChannelId) return;
    const target = findChannel(listed, openChannelId);
    if (target === null) return;
    handledRef.current = openChannelId;
    onOpen(target);
  }, [openChannelId, listed, onOpen]);

  const featuredCount = featured === null ? null : formatInterest(interest[featured.channelId]);

  const emptyWords =
    query.length > 0
      ? 'No channel matches that.'
      : category !== null
        ? `No listed channel is in ${categoryLabel(category) ?? 'that category'} right now.`
        : filter === 'following'
          ? 'You are not following any listed channel yet.'
          : filter === 'live'
            ? 'Nothing is live right now.'
            : 'No public channels are listed right now.';

  return (
    <ScrollView style={styles.fill} contentContainerStyle={styles.screen}>
      {featured !== null && (
        <GlassCard accent style={styles.featured}>
          <View style={styles.featuredArt}>
            <Text style={styles.featuredInitials}>{initials(featured.displayName)}</Text>
          </View>
          <View style={{ flex: 1, gap: 8 }}>
            <View style={styles.chipRow}>
              <Chip label="Featured" tone="teal" />
              <Chip label="Live now" tone="live" />
            </View>
            <Text style={styles.featuredTitle} numberOfLines={2}>{featured.displayName}</Text>
            {featuredCount !== null && (
              <View style={styles.metaRow}>
                <Icon name="people" size={14} color={C7.teal} />
                <Text style={styles.metaTeal}>{featuredCount}</Text>
              </View>
            )}
            <View style={styles.featuredActions}>
              <Pressable onPress={() => onOpen(featured)} accessibilityRole="button" style={({ pressed }) => [styles.watch, pressed && styles.pressed]}>
                <Icon name="programmes" size={18} color="#ffffff" />
                <Text style={styles.watchLabel}>Watch</Text>
              </Pressable>
              <InterestBell
                channel={featured}
                following={isFollowing(follows, featured.channelId)}
                busy={pending.has(featured.channelId)}
                onPress={() => toggle(featured.channelId)}
              />
            </View>
          </View>
        </GlassCard>
      )}

      <View style={styles.chipBlock}>
        <Text style={styles.chipLabel}>Filter</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
          {filters.map((entry) => (
            <Chip key={entry} label={FILTER_LABELS[entry]} active={filter === entry} onPress={() => setChosenFilter(entry)} />
          ))}
        </ScrollView>
      </View>

      {categories.length > 0 && (
        <View style={styles.chipBlock}>
          <Text style={styles.chipLabel}>Category</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
            {categories.map((entry) => (
              <Chip
                key={entry.id}
                label={entry.label}
                active={category === entry.id}
                onPress={() => setChosenCategory((current) => (current === entry.id ? null : entry.id))}
              />
            ))}
          </ScrollView>
        </View>
      )}

      <Text style={styles.hint}>Interested = we tell you when it goes live.</Text>
      {notice !== null && <Text style={styles.notice}>{notice}</Text>}

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
      {channels !== null && visible.length === 0 && <Text style={styles.empty}>{emptyWords}</Text>}
      {visible.map((channel) => {
        const following = isFollowing(follows, channel.channelId);
        const count = formatInterest(interest[channel.channelId]);
        const label = categoryLabel(channel.category);
        return (
          <Pressable key={channel.channelId} onPress={() => onOpen(channel)} accessibilityRole="button" style={({ pressed }) => pressed && styles.pressed}>
            <GlassCard padded={false} style={styles.row}>
              <View style={[styles.art, channel.live && styles.artLive]}>
                <Text style={styles.artInitials}>{initials(channel.displayName)}</Text>
              </View>
              <View style={{ flex: 1, gap: 5 }}>
                <View style={styles.titleRow}>
                  <Text style={styles.rowTitle} numberOfLines={1}>{channel.displayName}</Text>
                  {channel.live ? <Chip label="Live" tone="live" /> : <Chip label="Off air" tone="amber" />}
                </View>
                <View style={styles.metaRow}>
                  <Icon name={channel.visibility === 'public' ? 'globe' : 'lock'} size={14} color={C7.muted} />
                  <Text style={styles.meta}>{describeVisibility(channel.visibility)}</Text>
                  {label !== null && (
                    <>
                      <Text style={styles.metaDot}>·</Text>
                      <Text style={styles.meta}>{label}</Text>
                    </>
                  )}
                  {count !== null && (
                    <>
                      <Text style={styles.metaDot}>·</Text>
                      <Icon name="people" size={14} color={C7.teal} />
                      <Text style={styles.metaTeal}>{count}</Text>
                    </>
                  )}
                </View>
                {following && (
                  <View style={styles.chipRow}>
                    <Chip label="Following" tone="teal" />
                  </View>
                )}
              </View>
              <InterestBell channel={channel} following={following} busy={pending.has(channel.channelId)} onPress={() => toggle(channel.channelId)} />
            </GlassCard>
          </Pressable>
        );
      })}

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
  featuredActions: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  watch: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: C7.tealDeep, borderRadius: 999, paddingVertical: 11 },
  watchLabel: { color: '#ffffff', fontSize: 15, fontWeight: '600' },
  chipRow: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
  chipBlock: { gap: 6 },
  chipLabel: { color: C7.faint, fontSize: 11, letterSpacing: 1, fontWeight: '700', textTransform: 'uppercase' },
  filters: { flexDirection: 'row', gap: 8, paddingRight: 8 },
  hint: { color: C7.muted, fontSize: 12, marginTop: -6 },
  notice: { color: C7.amber, fontSize: 12, marginTop: -6 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 999, borderWidth: 1, borderColor: C7.panelEdge, backgroundColor: 'rgba(255,255,255,0.04)', paddingHorizontal: 14, paddingVertical: 4 },
  searchInput: { flex: 1, color: C7.text, fontSize: 15, paddingVertical: 8 },
  empty: { color: C7.muted, fontSize: 14, textAlign: 'center', paddingVertical: 18 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  art: { width: 58, height: 58, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.05)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C7.panelEdge },
  artLive: { backgroundColor: 'rgba(62,201,192,0.12)', borderColor: 'rgba(62,201,192,0.35)' },
  artInitials: { color: C7.text, fontSize: 18, fontWeight: '700', fontFamily: 'serif' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowTitle: { color: C7.text, fontSize: 17, fontWeight: '600', fontFamily: 'serif', flexShrink: 1 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  meta: { color: C7.muted, fontSize: 12 },
  metaDot: { color: C7.faint, fontSize: 12 },
  metaTeal: { color: C7.teal, fontSize: 12, fontWeight: '600' },
  bell: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(62,201,192,0.5)', backgroundColor: 'rgba(62,201,192,0.06)' },
  bellOn: { backgroundColor: C7.teal, borderColor: C7.teal },
  pressed: { opacity: 0.75 },
});
