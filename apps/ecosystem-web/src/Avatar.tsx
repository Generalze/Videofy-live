/** @author masterzee001 */
/**
 * A face, or the honest fallback: the person's initial on a colour derived
 * from their account id, so the same person is the same colour everywhere.
 *
 * The image arrives through the authed API (an <img src> carries no
 * Authorization header), so this component asks the api for an object URL and
 * renders the letter until one exists -- and forever, when there is none.
 */
import { useEffect, useState } from 'react';
import type { AccountApi } from './accountApi';

/** Muted but distinct; derived from the id so it is stable, not stored. */
const HUES = [172, 205, 262, 314, 22, 42] as const;

export function avatarHue(accountId: string): number {
  let hash = 0;
  for (const char of accountId) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return HUES[Math.abs(hash) % HUES.length] ?? 172;
}

export function Avatar({
  api,
  accountId,
  name,
  size = 36,
}: {
  readonly api: AccountApi;
  readonly accountId: string;
  readonly name: string;
  readonly size?: number;
}) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.avatarUrl(accountId).then((value) => {
      if (!cancelled) setUrl(value);
    });
    return () => {
      cancelled = true;
    };
  }, [api, accountId]);

  const style = {
    width: size,
    height: size,
    fontSize: size * 0.42,
    background:
      url === null ? `hsl(${avatarHue(accountId)}, 45%, 30%)` : 'transparent',
  };
  return (
    <span className="avatar" style={style} aria-hidden="true">
      {url === null ? (
        (name.trim()[0] ?? '?').toUpperCase()
      ) : (
        <img className="avatar-image" src={url} alt="" />
      )}
    </span>
  );
}
