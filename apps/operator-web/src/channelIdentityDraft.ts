/** @author masterzee001 */
/**
 * The Access page's Edit-channel draft: what goes on the wire and what is
 * refused before it gets there. Kept apart from the component so the
 * component file exports only a component (react-refresh) and the rules can
 * be tested without rendering.
 */
import {
  CHANNEL_DESCRIPTION_MAX_LENGTH,
  CHANNEL_DISPLAY_NAME_MAX_LENGTH,
  checkChannelHandle,
  type ChannelCategory,
  type ChannelVisibility,
} from '@videofy-live/shared-types';
import type { ChannelIdentity, ChannelIdentityPatch } from './premium/channelIdentity';

export interface EditDraft {
  readonly handle: string;
  readonly displayName: string;
  readonly description: string;
  readonly category: ChannelCategory | null;
}

/**
 * Only what changed goes on the wire: an unchanged handle sent again would be
 * a no-op at best and a needless uniqueness check at worst.
 */
export function identityPatch(profile: ChannelIdentity, draft: EditDraft): ChannelIdentityPatch {
  const patch: ChannelIdentityPatch = {};
  const handle = draft.handle.trim().replace(/^@/, '').toLowerCase();
  if (handle !== profile.handle) patch.handle = handle;
  const displayName = draft.displayName.trim();
  if (displayName !== profile.displayName) patch.displayName = displayName;
  const description = draft.description.trim();
  if (description !== profile.description) patch.description = description;
  if (draft.category !== profile.category) patch.category = draft.category;
  return patch;
}

/** The problems a draft has before it is sent, in the account service's own words where they exist. */
export function identityDraftProblems(draft: EditDraft): string[] {
  const problems: string[] = [];
  const handle = checkChannelHandle(draft.handle);
  if (!handle.ok) problems.push(handle.message);
  const name = draft.displayName.trim();
  if (name.length === 0) problems.push('Give the channel a name.');
  else if (name.length > CHANNEL_DISPLAY_NAME_MAX_LENGTH) {
    problems.push(`Channel names are at most ${CHANNEL_DISPLAY_NAME_MAX_LENGTH} characters.`);
  }
  if (draft.description.trim().length > CHANNEL_DESCRIPTION_MAX_LENGTH) {
    problems.push(`Descriptions are at most ${CHANNEL_DESCRIPTION_MAX_LENGTH} characters.`);
  }
  return problems;
}

export function visibilityWord(visibility: ChannelVisibility): string {
  switch (visibility) {
    case 'public':
      return 'Public';
    case 'private':
      return 'Private by link';
    case 'locked':
      return 'Locked with a code';
  }
}

