/** @author masterzee001 */
/**
 * A push is a wake-up, and a wake-up that cannot ask a question must not
 * answer it.
 *
 * THE DEFECT: the notification listeners run at mount, before `auth.restore()`
 * resolves. A call push arriving then had no session to ask the gateway with,
 * the API returned null, and the routing treated that identically to "the
 * server says no": it dropped the call AND recorded it as handled, so nothing
 * would look at it again. The incoming screen never appeared and the caller
 * rang out against a phone that had woken up and said nothing. On builds
 * without the native module, that was every cold-start call.
 *
 * These tests hold the distinction that fixes it -- "I could not ask" defers,
 * "the answer was no" ignores -- and the dismissal that keeps a stale ring
 * from continuing forever.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  routeCallPush,
  shouldDismissIncoming,
  type PushRouting,
} from '../call/incomingCallRouting';
import type { DirectCallCheck } from '../call/directCallApi';

function ringing(over: Partial<DirectCallCheck> = {}): DirectCallCheck {
  return {
    ring: true,
    state: 'calling',
    mode: 'normal',
    callerAccountId: 'acct_caller',
    callerName: 'Ada',
    ...over,
  };
}

const PUSH = {
  callId: 'call_1',
  fromAccountId: 'acct_push',
  fromName: 'Push Name',
};

describe('cold start: the push arrives before there is a session', () => {
  it('DEFERS rather than dropping, and never asks', async () => {
    const check = vi.fn(async () => null);
    const routing = await routeCallPush({ ...PUSH, hasSession: false, check });

    expect(routing.kind).toBe('defer');
    // Asking without a session is how this became a silent drop.
    expect(check).not.toHaveBeenCalled();
  });

  it('once the session lands, the same push presents the call', async () => {
    // The re-drive: identical input, session now present.
    const check = vi.fn(async () => ringing());
    const routing = await routeCallPush({ ...PUSH, hasSession: true, check });

    expect(routing.kind).toBe('show');
    if (routing.kind !== 'show') throw new Error('unreachable');
    expect(routing.presentation.callId).toBe('call_1');
    expect(routing.presentation.caller.name).toBe('Ada');
    expect(check).toHaveBeenCalledWith('call_1');
  });

  it('and if the call died while the app was starting, it stays silent', async () => {
    const check = vi.fn(async () => ringing({ ring: false, state: 'no_answer' }));
    const routing = await routeCallPush({ ...PUSH, hasSession: true, check });

    expect(routing.kind).toBe('ignore');
    if (routing.kind !== 'ignore') throw new Error('unreachable');
    expect(routing.reason).toMatch(/no_answer/u);
  });
});

describe('a stale push never rings', () => {
  it.each(['ended', 'declined', 'busy', 'no_answer', 'unavailable', 'network'])(
    'stays silent for a call that is %s',
    async (state) => {
      const routing = await routeCallPush({
        ...PUSH,
        hasSession: true,
        check: async () => ringing({ ring: false, state }),
      });
      expect(routing.kind).toBe('ignore');
    },
  );
});

describe('an unanswerable question is not an answer', () => {
  it('defers when the gateway cannot be reached, rather than ringing on silence', async () => {
    /*
     * A device that rings when it could not check is a device that rings for
     * calls that ended minutes ago. Only the server knows.
     */
    const routing = await routeCallPush({
      ...PUSH,
      hasSession: true,
      check: async () => null,
    });
    expect(routing.kind).toBe('defer');
  });

  it('refuses a push with no call id outright', async () => {
    const routing = await routeCallPush({
      ...PUSH,
      callId: '   ',
      hasSession: true,
      check: async () => ringing(),
    });
    expect(routing.kind).toBe('ignore');
  });
});

describe('the server names win over the push payload', () => {
  it('uses the push name only where the server left the field empty', async () => {
    const routing: PushRouting = await routeCallPush({
      ...PUSH,
      hasSession: true,
      check: async () => ringing({ callerName: '', callerAccountId: '' }),
    });
    if (routing.kind !== 'show') throw new Error('expected show');
    expect(routing.presentation.caller.name).toBe('Push Name');
    expect(routing.presentation.caller.accountId).toBe('acct_push');
  });

  it('carries the mode the server reports', async () => {
    const routing = await routeCallPush({
      ...PUSH,
      hasSession: true,
      check: async () => ringing({ mode: 'translated' }),
    });
    if (routing.kind !== 'show') throw new Error('expected show');
    expect(routing.presentation.mode).toBe('translated');
  });
});

describe('the ring screen comes down when the call is over', () => {
  it('dismisses once the server says it is no longer ringing', () => {
    // The caller hung up, or the person answered on another phone.
    expect(shouldDismissIncoming(ringing({ ring: false, state: 'ended' }))).toBe(true);
  });

  it('keeps ringing while the call is still live', () => {
    expect(shouldDismissIncoming(ringing())).toBe(false);
  });

  it('does NOT dismiss on a failed poll', () => {
    /*
     * One unanswered poll on a moving train must not cancel a call that is
     * still ringing. Only the server saying so takes the screen down.
     */
    expect(shouldDismissIncoming(null)).toBe(false);
  });
});
