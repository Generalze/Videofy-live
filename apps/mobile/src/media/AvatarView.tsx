/** @author masterzee001 */
/**
 * A person's picture, or their initial.
 *
 * THE BYTES ARE FETCHED THE WAY EVERYTHING ELSE IS. The picture route needs
 * the session, and RN's Image on Android proved unable to carry it: the
 * phone reported "Unexpected HTTP code 401" for a picture the same phone
 * fetched with the session at 200 (founder screenshot, 30 Aug 2026). So the
 * picture is fetched through the app's authorised fetch -- the one path
 * that is known to attach the session -- and handed to Image as bytes.
 * Pictures are small (the server caps them), and a fetched picture is kept
 * in memory per person and version so a list of rows fetches each once.
 *
 * A 404 -- no picture -- renders the initial. So does a fetch failure, and
 * a failure is not forever: it is retried after a minute, and a changed
 * person or version retries at once.
 */
import { useEffect, useState, type JSX } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { bytesToBase64 } from './voiceNotes';

interface AvatarConfig {
  /** The app's authorised fetch: a path on the account service, the session attached. */
  fetch: (path: string) => Promise<Response | null>;
}

let config: AvatarConfig | null = null;

export function configureAvatars(next: AvatarConfig): void {
  config = next;
  pictures.clear();
}

/** Fetched pictures by "<accountId>#<version>": a data URI, or null for "no picture". */
const pictures = new Map<string, string | null>();
const inFlight = new Map<string, Promise<string | null>>();

export type AvatarImageState = { readonly state: 'loaded' } | { readonly state: 'failed'; readonly detail: string };

async function fetchPicture(accountId: string, version: number): Promise<{ uri: string | null; detail: string | null }> {
  const current = config;
  if (current === null) return { uri: null, detail: 'avatars not configured' };
  let response: Response | null;
  try {
    response = await current.fetch(`/avatars/${encodeURIComponent(accountId)}${version > 0 ? `?v=${version}` : ''}`);
  } catch {
    return { uri: null, detail: 'network' };
  }
  if (response === null) return { uri: null, detail: 'signed out' };
  if (response.status === 404) return { uri: null, detail: null };
  if (!response.ok) return { uri: null, detail: `HTTP ${response.status}` };
  try {
    const type = response.headers.get('content-type') ?? 'image/jpeg';
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0) return { uri: null, detail: 'empty' };
    return { uri: `data:${type.split(';')[0]};base64,${bytesToBase64(bytes)}`, detail: null };
  } catch {
    return { uri: null, detail: 'unreadable' };
  }
}

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
  onImageState,
  version = 0,
  size = 44,
}: {
  readonly accountId: string;
  readonly name: string;
  /** Reported once per attempt: loaded, or failed with a short reason (never a URL). */
  readonly onImageState?: ((state: AvatarImageState) => void) | undefined;
  /** Bump to refetch after an upload; the cache key includes it. */
  readonly version?: number;
  readonly size?: number;
}): JSX.Element {
  const key = `${accountId}#${version}`;
  const [uri, setUri] = useState<string | null>(() => pictures.get(key) ?? null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    const cached = pictures.get(key);
    if (cached !== undefined) {
      setUri(cached);
      if (cached !== null) onImageState?.({ state: 'loaded' });
      return undefined;
    }
    const pending = inFlight.get(key) ?? (() => {
      const promise = fetchPicture(accountId, version).then((result) => {
        // Only a definite answer is remembered; a transient failure is retried below.
        if (result.uri !== null || result.detail === null) pictures.set(key, result.uri);
        inFlight.delete(key);
        return result.uri ?? (result.detail === null ? null : Promise.reject(new Error(result.detail)));
      });
      inFlight.set(key, promise);
      return promise;
    })();
    let retry: ReturnType<typeof setTimeout> | null = null;
    pending.then(
      (found) => {
        if (!live) return;
        setUri(found);
        if (found !== null) onImageState?.({ state: 'loaded' });
      },
      (error: unknown) => {
        if (!live) return;
        onImageState?.({ state: 'failed', detail: error instanceof Error ? error.message : 'fetch failed' });
        retry = setTimeout(() => setAttempt((count) => count + 1), 60_000);
      },
    );
    return () => {
      live = false;
      if (retry !== null) clearTimeout(retry);
    };
    // onImageState is a reporting callback; re-running on its identity would refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, accountId, version, attempt]);

  const circle = {
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: `hsl(${hueFor(accountId)}, 45%, 30%)`,
  };
  return (
    <View style={[styles.circle, circle]}>
      <Text style={[styles.letter, { fontSize: size * 0.42 }]}>
        {(name.trim()[0] ?? '?').toUpperCase()}
      </Text>
      {uri !== null ? (
        <Image
          source={{ uri }}
          style={[StyleSheet.absoluteFill, { borderRadius: size / 2 }]}
          onError={() => {
            pictures.delete(key);
            setUri(null);
            onImageState?.({ state: 'failed', detail: 'decode' });
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  letter: { color: 'rgba(255,255,255,0.92)', fontWeight: '700' },
});
