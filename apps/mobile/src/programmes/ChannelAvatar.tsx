/** @author masterzee001 */
/**
 * A channel's picture, or its initials on the tile where the picture goes.
 *
 * FOUNDER DIRECTIVE (A, 30 Aug 2026, LOCKED): discovery "uses persisted
 * identity (name, avatar, handle, category, live status, current
 * programme)". The picture is the account service's public
 * GET /channels/<id>/avatar, named on the directory row as `avatarUrl`; the
 * directory row is the only source, so a channel without one shows its
 * initials and nothing is invented.
 *
 * Shaped like AvatarView (media/AvatarView.tsx) on purpose: the letters sit
 * under the image so a picture that fails to load leaves a tile with
 * letters in it rather than a broken glyph, and a failure is retried after
 * the server's own cache window rather than remembered until restart. It is
 * not AvatarView itself because the channel route is public -- no session
 * header, no account id -- and the tile is a rounded square, not a face.
 */
import { useEffect, useState, type JSX } from 'react';
import { Image, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { channelAvatarUri, type ChannelSummary } from '../api/channelDirectory';
import { initials } from './programmeCatalogue';

/** Not a secret: `EXPO_PUBLIC_` values are compiled into the bundle. Staging mounts the account service at /auth. */
const ACCOUNT_URL = process.env['EXPO_PUBLIC_ACCOUNT_URL'] ?? 'https://staging.consummate7.com/auth';

/** Retry a failed picture after the account service's cache window. */
const RETRY_MS = 60_000;

export function ChannelAvatar({
  channel,
  size = 58,
  radius = 12,
  live = false,
  style,
}: {
  readonly channel: Pick<ChannelSummary, 'channelId' | 'displayName' | 'avatarUrl'>;
  readonly size?: number;
  readonly radius?: number;
  /** Tints the tile so a live channel reads as live before the chip is read. */
  readonly live?: boolean;
  readonly style?: StyleProp<ViewStyle>;
}): JSX.Element {
  const [failed, setFailed] = useState(false);
  const uri = channelAvatarUri(ACCOUNT_URL, channel.avatarUrl);

  useEffect(() => {
    setFailed(false);
  }, [uri]);
  useEffect(() => {
    if (!failed) return undefined;
    const timer = setTimeout(() => setFailed(false), RETRY_MS);
    return () => clearTimeout(timer);
  }, [failed]);

  const tile = { width: size, height: size, borderRadius: radius };
  return (
    <View style={[styles.tile, live && styles.tileLive, tile, style]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Text style={[styles.letters, { fontSize: Math.round(size * 0.31) }]}>{initials(channel.displayName)}</Text>
      {uri !== null && !failed ? (
        <Image
          source={{ uri }}
          style={[StyleSheet.absoluteFill, { borderRadius: radius }]}
          onError={() => setFailed(true)}
          accessibilityIgnoresInvertColors
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(120, 200, 200, 0.12)',
  },
  tileLive: { backgroundColor: 'rgba(62,201,192,0.12)', borderColor: 'rgba(62,201,192,0.35)' },
  letters: { color: '#eef3f7', fontWeight: '700', fontFamily: 'serif' },
});
