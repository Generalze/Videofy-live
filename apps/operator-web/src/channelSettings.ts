/**
 * An operator's own channel: what it is called, who can reach it, and the link
 * they hand out.
 *
 * Each channel has its own operator page and its own viewer page. This module
 * holds the rules that decide what a settings change means and what the
 * shareable link looks like, with no React and no socket in the way, because
 * those rules are the part worth being sure about.
 */
import type { ChannelVisibility } from '@videofy-live/shared-types';

/** The gateway refuses anything shorter; saying so here avoids a pointless round trip. */
export const MIN_CODE_LENGTH = 6;
export const MAX_CODE_LENGTH = 64;
export const MAX_NAME_LENGTH = 80;

export interface ChannelSettingsDraft {
  readonly displayName: string;
  readonly visibility: ChannelVisibility;
  /** Null means "clear the code"; undefined means "leave whatever is set alone". */
  readonly code?: string | null;
}

export type SettingsProblem =
  | { readonly field: 'displayName'; readonly message: string }
  | { readonly field: 'code'; readonly message: string };

/**
 * What each choice actually does, in the words the operator needs.
 *
 * Written here rather than in the component because the distinction between
 * unlisted and private is the one people get wrong, and it should read the same
 * everywhere it appears.
 */
export const VISIBILITY_DESCRIPTIONS: Record<ChannelVisibility, string> = {
  public: 'Listed for everyone. Anyone can find and watch this programme.',
  unlisted: 'Not listed. Anyone with the link can watch — the link is the only thing needed.',
  private: 'Not listed, and the link is not enough on its own. Viewers must also enter the code.',
};

/**
 * Check a draft before sending it.
 *
 * A PRIVATE CHANNEL WITH NO CODE IS THE ONE THAT MATTERS. The gateway refuses
 * every viewer in that state rather than admitting them, which is the safe way
 * round, but an operator who sees "private" on their screen and an empty
 * audience deserves to be told why before they go looking for a bug.
 */
export function validateSettings(
  draft: ChannelSettingsDraft,
  hasExistingCode: boolean,
): readonly SettingsProblem[] {
  const problems: SettingsProblem[] = [];

  const name = draft.displayName.trim();
  if (name.length === 0) {
    problems.push({ field: 'displayName', message: 'Give the channel a name viewers will see.' });
  } else if (name.length > MAX_NAME_LENGTH) {
    problems.push({
      field: 'displayName',
      message: `Keep the name under ${MAX_NAME_LENGTH} characters.`,
    });
  }

  if (typeof draft.code === 'string' && draft.code.length > 0) {
    if (draft.code.length < MIN_CODE_LENGTH) {
      problems.push({
        field: 'code',
        message: `Use at least ${MIN_CODE_LENGTH} characters — a short code is guessable.`,
      });
    } else if (draft.code.length > MAX_CODE_LENGTH) {
      problems.push({ field: 'code', message: `Keep the code under ${MAX_CODE_LENGTH} characters.` });
    }
  }

  const willHaveCode =
    draft.code === undefined ? hasExistingCode : draft.code !== null && draft.code.length > 0;
  if (draft.visibility === 'private' && !willHaveCode) {
    problems.push({
      field: 'code',
      message: 'A private channel needs a code. Without one, nobody can join — including you.',
    });
  }

  return problems;
}

/**
 * The payload for the gateway.
 *
 * A code is sent only when the operator actually changed it. Resending a code
 * on every unrelated settings change would put a live join code on the wire
 * each time somebody renamed their channel.
 */
export function toSettingsPayload(
  draft: ChannelSettingsDraft,
): { displayName: string; visibility: ChannelVisibility; code?: string | null } {
  return {
    displayName: draft.displayName.trim(),
    visibility: draft.visibility,
    ...(draft.code === undefined ? {} : { code: draft.code }),
  };
}

/**
 * A code that is worth having.
 *
 * Ambiguous characters are left out: a code gets read aloud, written on a
 * whiteboard and retyped from a photograph, and `0`/`O` and `1`/`l` cost more
 * in failed joins than the handful of bits they add.
 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateJoinCode(
  randomBytes: (length: number) => Uint8Array,
  length = 10,
): string {
  const bytes = randomBytes(length);
  let code = '';
  for (const byte of bytes) {
    /*
     * Modulo bias is real and negligible here: 256 % 31 leaves a slight tilt
     * toward the first nine characters, worth far less than one bit across a
     * ten-character code. Rejection sampling would be the correct instinct on
     * anything long-lived; this is an operator-rotatable room code.
     */
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return code;
}

/** The random source, taken as a parameter so this module stays testable. */
export function browserRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * The link the operator gives out.
 *
 * @param viewerOrigin - Where the viewer app is served, which is not where the
 * operator app is served. Defaulting to the current origin would hand out a
 * link into the operator console.
 */
export function shareableViewerLink(
  viewerOrigin: string,
  channelId: string,
  visibility: ChannelVisibility,
  code: string | null,
): string {
  const base = `${viewerOrigin.replace(/\/$/, '')}/c/${encodeURIComponent(channelId)}`;
  /*
   * The code rides in the link only for a private channel, and only when the
   * operator has one to include. For public and unlisted there is nothing to
   * carry, and a `?code=` on the end would imply otherwise.
   */
  if (visibility !== 'private' || code === null || code.length === 0) return base;
  return `${base}?code=${encodeURIComponent(code)}`;
}

/**
 * Whether the operator can still hand out a working link.
 *
 * After a code is set, the gateway reports only that one exists -- never the
 * code itself -- so this page can no longer build a link that carries it. That
 * is the right trade, and the operator needs to be told plainly rather than
 * silently given a link that will not let anybody in.
 */
export function canShareCodedLink(visibility: ChannelVisibility, codeInHand: string | null): boolean {
  return visibility !== 'private' || (codeInHand !== null && codeInHand.length > 0);
}
