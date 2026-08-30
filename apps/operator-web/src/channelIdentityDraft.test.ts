/** @author masterzee001 */
import { describe, expect, it } from 'vitest';
import { identityDraftProblems, identityPatch } from './channelIdentityDraft';

const PROFILE = {
  channelId: 'ch_1',
  ownerAccountId: 'acct_1',
  handle: 'sunday_service',
  displayName: 'Sunday Service',
  description: '',
  category: null,
  visibility: 'public' as const,
  avatarUrl: null,
  bannerUrl: null,
  createdAt: 0,
  updatedAt: 0,
};

describe('Edit channel', () => {
  it('sends only the fields that changed, with the handle folded the way the service stores it', () => {
    expect(identityPatch(PROFILE, { handle: '@Sunday_Service', displayName: 'Sunday Service', description: '', category: null })).toEqual({});
    expect(identityPatch(PROFILE, { handle: 'sunday_live', displayName: ' Sunday Service ', description: 'Weekly', category: 'faith' })).toEqual({
      handle: 'sunday_live',
      description: 'Weekly',
      category: 'faith',
    });
  });

  it('refuses a bad handle or a blank name before anything is sent', () => {
    expect(identityDraftProblems({ handle: 'ab', displayName: 'x', description: '', category: null })).toHaveLength(1);
    expect(identityDraftProblems({ handle: 'admin', displayName: 'x', description: '', category: null })).toEqual(['That handle is reserved.']);
    expect(identityDraftProblems({ handle: 'fine_one', displayName: '  ', description: '', category: null })).toEqual(['Give the channel a name.']);
    expect(identityDraftProblems({ handle: 'fine_one', displayName: 'x', description: '', category: null })).toEqual([]);
  });
});
