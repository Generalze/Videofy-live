/** @author masterzee001 */
/**
 * A programme, inside the app.
 *
 * THE LIVE VIEWER RUNS IN A WEBVIEW under the C7 shell -- the same viewer
 * the web serves, with its captions, language choice, translated audio and
 * the original-audio level, so nothing about a programme differs between
 * a phone and a laptop and nothing is re-implemented twice while the
 * Programme Quality Engine is still ahead. The person never leaves the
 * app: back is the app's back, the header is the app's header. A native
 * player replaces the WebView when HLS renditions exist (blueprint §5).
 *
 * THE BELL IS THE SAME BELL AS THE LIST. "Interested" here is the same
 * follow-with-reminder the list sends, from the same hook, with the same
 * optimistic flip and rollback; the follower count beside it is the account
 * service's, not a guess.
 *
 * The viewer page is public for public channels; a private link-only
 * channel reaches its page by the same link the operator shares.
 */
import { useEffect, useState, type JSX } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import type { ChannelSummary } from '../api/channelDirectory';
import { listenerUrlFor } from '../api/channelDirectory';
import type { Api } from '../api/client';
import { describeVisibility, formatInterest, isFollowing } from '../programmes/programmeCatalogue';
import { useChannelInterest } from '../programmes/useChannelInterest';
import { C7, C7Ground, Chip } from '../ui/c7';
import { Icon } from '../ui/icons';

const GATEWAY_URL = process.env['EXPO_PUBLIC_GATEWAY_URL'] ?? 'https://staging.consummate7.com';
const LISTEN_URL = process.env['EXPO_PUBLIC_LISTEN_URL'] ?? `${GATEWAY_URL}/listen`;

export interface ProgrammeViewerScreenProps {
  readonly channel: ChannelSummary;
  readonly api: Api;
  readonly onBack: () => void;
}

export function ProgrammeViewerScreen({ channel, api, onBack }: ProgrammeViewerScreenProps): JSX.Element {
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const { follows, interest, pending, notice, loadInterest, toggle } = useChannelInterest(api);
  const url = listenerUrlFor(LISTEN_URL, channel.channelId);

  useEffect(() => {
    loadInterest([channel.channelId]);
  }, [channel.channelId, loadInterest]);

  const following = isFollowing(follows, channel.channelId);
  const busy = pending.has(channel.channelId);
  const count = formatInterest(interest[channel.channelId]);

  return (
    <View style={styles.fill}>
      <C7Ground />
      <View style={styles.header}>
        <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Back" hitSlop={8} style={styles.back}>
          <Icon name="chevron" size={22} color={C7.text} />
        </Pressable>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={styles.title} numberOfLines={1}>{channel.displayName}</Text>
          <View style={styles.metaRow}>
            {channel.live ? <Chip label="Live" tone="live" /> : <Chip label="Off air" tone="amber" />}
            <Text style={styles.meta}>{describeVisibility(channel.visibility)}</Text>
            {count !== null && (
              <>
                <Text style={styles.metaDot}>·</Text>
                <Text style={styles.metaTeal}>{count}</Text>
              </>
            )}
          </View>
        </View>
        <Pressable
          onPress={() => toggle(channel.channelId)}
          disabled={busy}
          accessibilityRole="button"
          accessibilityState={{ selected: following, disabled: busy }}
          accessibilityLabel={following ? 'Stop reminders for this channel' : 'Tell me when this channel goes live'}
          style={({ pressed }) => [styles.follow, following && styles.followOn, (pressed || busy) && styles.pressed]}
        >
          <Icon name="bell" size={18} color={following ? C7.ground : C7.teal} />
          <Text style={[styles.followLabel, following && styles.followLabelOn]}>{following ? 'Following' : 'Interested'}</Text>
        </Pressable>
      </View>
      {notice !== null && <Text style={styles.notice}>{notice}</Text>}
      <View style={styles.stage}>
        {failed ? (
          <View style={styles.centre}>
            <Text style={styles.stateText}>The programme could not be loaded.</Text>
            <Pressable onPress={() => { setFailed(false); setLoading(true); }} accessibilityRole="button" style={styles.retry}>
              <Text style={styles.retryLabel}>Try again</Text>
            </Pressable>
          </View>
        ) : (
          <WebView
            source={{ uri: url }}
            style={styles.web}
            allowsInlineMediaPlayback
            mediaPlaybackRequiresUserAction={false}
            javaScriptEnabled
            domStorageEnabled
            allowsFullscreenVideo
            onLoadEnd={() => setLoading(false)}
            onError={() => setFailed(true)}
            onHttpError={() => setFailed(true)}
          />
        )}
        {loading && !failed && (
          <View style={[styles.centre, styles.overlay]} pointerEvents="none">
            <ActivityIndicator color={C7.teal} size="large" />
            <Text style={styles.stateText}>Joining the programme…</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C7.ground },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 50, paddingHorizontal: 14, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: C7.panelEdge },
  back: { transform: [{ rotate: '180deg' }], padding: 4 },
  title: { color: C7.text, fontSize: 18, fontWeight: '600', fontFamily: 'serif' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  meta: { color: C7.muted, fontSize: 12 },
  metaDot: { color: C7.faint, fontSize: 12 },
  metaTeal: { color: C7.teal, fontSize: 12, fontWeight: '600' },
  follow: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, borderWidth: 1, borderColor: 'rgba(62,201,192,0.5)', paddingHorizontal: 12, paddingVertical: 7 },
  followOn: { backgroundColor: C7.teal, borderColor: C7.teal },
  followLabel: { color: C7.teal, fontSize: 13, fontWeight: '700' },
  followLabelOn: { color: C7.ground },
  notice: { color: C7.amber, fontSize: 12, paddingHorizontal: 14, paddingVertical: 6 },
  stage: { flex: 1 },
  web: { flex: 1, backgroundColor: C7.ground },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(7,11,18,0.85)' },
  stateText: { color: C7.muted, fontSize: 14, textAlign: 'center' },
  retry: { borderRadius: 999, borderWidth: 1, borderColor: C7.teal, paddingHorizontal: 16, paddingVertical: 9 },
  retryLabel: { color: C7.teal, fontSize: 14, fontWeight: '700' },
  pressed: { opacity: 0.75 },
});
