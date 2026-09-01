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
 *
 * THE HEADER IS THE CHANNEL'S IDENTITY (founder directive A, 30 Aug 2026,
 * LOCKED): picture or initials, name and @handle, read from the directory
 * row. The WebView still opens the OPAQUE listener link -- "opaque links
 * still working" -- while the share action hands out the public canonical
 * /streams/<handle> page. Share is offered only when a handle exists: with
 * none there is nothing canonical to share, and a dead button is worse than
 * no button (REAL when shown; absent, not disabled, otherwise).
 */
import { useEffect, useState, type JSX } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import * as Clipboard from 'expo-clipboard';
import type { ChannelSummary } from '../api/channelDirectory';
import { listenerUrlFor } from '../api/channelDirectory';
import type { Api } from '../api/client';
import { WEB_URL } from '../people/people';
import {
  channelShareUrl,
  describeVisibility,
  formatInterest,
  handleLabel,
  isFollowing,
} from '../programmes/programmeCatalogue';
import { ChannelAvatar } from '../programmes/ChannelAvatar';
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
  const [copied, setCopied] = useState(false);
  const { follows, interest, pending, notice, loadInterest, toggle } = useChannelInterest(api);
  /*
   * THE SPONSORED SLOT IS INSIDE THE EMBEDDED PAGE, not out here.
   *
   * listener-web renders it directly below the viewer display and above the
   * controls, which is the locked placement. A native slot on this screen was
   * tried and removed: it necessarily sat AFTER the whole WebView, so the
   * advert appeared below the embedded controls instead of below the display,
   * and it needed a second delivery implementation to feed it.
   */
  const url = listenerUrlFor(LISTEN_URL, channel.channelId);
  const shareUrl = channelShareUrl(WEB_URL, channel);
  const handle = handleLabel(channel.handle);

  useEffect(() => {
    loadInterest([channel.channelId]);
  }, [channel.channelId, loadInterest]);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 3000);
    return () => clearTimeout(timer);
  }, [copied]);

  const following = isFollowing(follows, channel.channelId);
  const busy = pending.has(channel.channelId);
  const count = formatInterest(interest[channel.channelId]);

  const share = (): void => {
    if (shareUrl === null) return;
    void Clipboard.setStringAsync(shareUrl).then(() => setCopied(true));
  };

  return (
    <View style={styles.fill}>
      <C7Ground />
      <View style={styles.header}>
        <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel="Back" hitSlop={8} style={styles.back}>
          <Icon name="chevron" size={22} color={C7.text} />
        </Pressable>
        <ChannelAvatar channel={channel} size={40} radius={20} live={channel.live} />
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={styles.title} numberOfLines={1}>{channel.displayName}</Text>
          <View style={styles.metaRow}>
            {handle !== null && <Text style={styles.handle}>{handle}</Text>}
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
        {shareUrl !== null && (
          <Pressable
            onPress={share}
            accessibilityRole="button"
            accessibilityLabel="Copy the channel link"
            hitSlop={6}
            style={({ pressed }) => [styles.share, pressed && styles.pressed]}
          >
            <Icon name="share" size={18} color={C7.teal} />
          </Pressable>
        )}
      </View>
      {copied && <Text style={styles.copied}>Link copied: {shareUrl}</Text>}
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
  handle: { color: C7.teal, fontSize: 12, fontWeight: '600' },
  share: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(62,201,192,0.5)' },
  copied: { color: C7.teal, fontSize: 12, paddingHorizontal: 14, paddingVertical: 6 },
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
