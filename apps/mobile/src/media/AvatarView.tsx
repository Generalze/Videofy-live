/** @author masterzee001 */
/**
 * A face on the phone, or the person's initial on a colour that is theirs.
 *
 * The avatar route requires the session, and React Native's Image sends
 * whatever headers it is given -- so the app configures this module once with
 * the account base URL and a header provider, and every screen just renders
 * `<AvatarView accountId name />`. The provider is a function, not a stored
 * token: token ownership stays inside AuthSessionManager (the same rule that
 * shaped `callSessionToken`), and sign-out instantly starves this module.
 *
 * A 404 -- no picture -- renders the initial. So does a fetch failure: a
 * broken image glyph in a contact row is a bug report nobody can act on.
 */
import { useState, type JSX } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

interface AvatarConfig {
  baseUrl: string;
  headers: () => Record<string, string> | null;
}

let config: AvatarConfig | null = null;

export function configureAvatars(next: AvatarConfig): void {
  config = next;
}

/** Muted but distinct; derived from the id so it is stable, not stored. */
const HUES = [172, 205, 262, 314, 22, 42] as const;

function hueFor(accountId: string): number {
  let hash = 0;
  for (let index = 0; index < accountId.length; index += 1) {
    hash = (hash * 31 + accountId.charCodeAt(index)) | 0;
  }
  return HUES[Math.abs(hash) % HUES.length] ?? 172;
}

export function AvatarView({
  accountId,
  name,
  size = 36,
  version = 0,
}: {
  readonly accountId: string;
  readonly name: string;
  /**
   * Bumped after this person changes their picture. The URL otherwise never
   * changes, the server allows a minute of caching and the image cache keeps
   * the old answer -- which on a real phone read as "upload did nothing".
   */
  readonly version?: number;
  readonly size?: number;
}): JSX.Element {
  const [failed, setFailed] = useState(false);
  const headers = config?.headers() ?? null;
  const circle = {
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: `hsl(${hueFor(accountId)}, 45%, 30%)`,
  };
  const showImage = config !== null && headers !== null && !failed;
  return (
    <View style={[styles.circle, circle]}>
      <Text style={[styles.letter, { fontSize: size * 0.42 }]}>
        {(name.trim()[0] ?? '?').toUpperCase()}
      </Text>
      {showImage ? (
        <Image
          source={{
            uri: `${config?.baseUrl}/avatars/${accountId}${version > 0 ? `?v=${version}` : ''}`,
            headers: headers ?? {},
          }}
          style={[StyleSheet.absoluteFill, { borderRadius: size / 2 }]}
          onError={() => setFailed(true)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  letter: { color: 'rgba(255,255,255,0.92)', fontWeight: '700' },
});
