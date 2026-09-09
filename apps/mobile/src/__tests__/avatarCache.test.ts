/** @author masterzee001 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  avatarCacheVersion,
  avatarInvalidationVersion,
  invalidateAvatar,
  resetAvatarInvalidationForTests,
  subscribeAvatarInvalidation,
} from '../media/avatarCache';

describe('avatar cache invalidation', () => {
  beforeEach(() => {
    resetAvatarInvalidationForTests();
  });

  it('bumps the cache version for the changed account only', () => {
    expect(avatarCacheVersion('acct_a', 0)).toBe(0);
    invalidateAvatar('acct_a');
    expect(avatarInvalidationVersion('acct_a')).toBe(1);
    expect(avatarCacheVersion('acct_a', 0)).toBe(1);
    expect(avatarCacheVersion('acct_b', 0)).toBe(0);
  });

  it('notifies mounted views for that account', () => {
    const mine = vi.fn();
    const theirs = vi.fn();
    const stopMine = subscribeAvatarInvalidation('acct_a', mine);
    subscribeAvatarInvalidation('acct_b', theirs);

    invalidateAvatar('acct_a');
    expect(mine).toHaveBeenCalledTimes(1);
    expect(theirs).not.toHaveBeenCalled();

    stopMine();
    invalidateAvatar('acct_a');
    expect(mine).toHaveBeenCalledTimes(1);
  });
});
