/** @owner masterzee001 */
/**
 * Event-map type closure and error-taxonomy pinning.
 *
 * The compile-time assertions prove the public on/off surface covers EXACTLY
 * the contracts event union — a new event added to the contracts package
 * fails this file's type-check until the SDK carries it, and an event the
 * contracts never declared cannot be subscribed at all.
 */
import { describe, expect, it } from 'vitest';
import { CALL_EVENTS } from '@videofy-live/call-client-core';
import {
  CONNECT_ERROR_CODES,
  CONNECT_EVENT_NAMES,
  classifyConnectError,
} from '@videofy-live/connect-contracts';
import type { CallSnapshot, ConnectEventMap, ConnectEventName } from '@videofy-live/connect-contracts';
import { createVideofyClientWith } from '../client';
import { VideofyConnectError } from '../errors';
import { buildTestToken, makeHarness, okJoinAck } from './fakes';
import type { VideofyCall } from '../publicTypes';

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// The first parameter of on()/off() is exactly the contracts event union.
type OnEventName = Parameters<VideofyCall['on']>[0];
const onClosure: MutuallyAssignable<OnEventName, ConnectEventName> = true;
type OffEventName = Parameters<VideofyCall['off']>[0];
const offClosure: MutuallyAssignable<OffEventName, ConnectEventName> = true;

// The event map itself is closed over the same union.
const mapClosure: MutuallyAssignable<keyof ConnectEventMap, ConnectEventName> = true;

// Spot-proof payload types: state carries the snapshot; the two signal-only
// events carry undefined.
const statePayload: MutuallyAssignable<ConnectEventMap['state'], CallSnapshot> = true;
const signalPayloads: MutuallyAssignable<
  ConnectEventMap['audioBlocked'] | ConnectEventMap['needsNewJoinToken'],
  undefined
> = true;

describe('event surface closure', () => {
  it('covers all ten contract events at compile time and runtime', async () => {
    expect(onClosure).toBe(true);
    expect(offClosure).toBe(true);
    expect(mapClosure).toBe(true);
    expect(statePayload).toBe(true);
    expect(signalPayloads).toBe(true);
    expect(CONNECT_EVENT_NAMES).toHaveLength(10);

    const harness = makeHarness();
    harness.socket.respond = (event) => (event === CALL_EVENTS.JOIN ? okJoinAck() : undefined);
    const client = createVideofyClientWith(harness.config, harness.deps);
    const call = await client.join({ token: buildTestToken() });
    // Every declared event name is subscribable and unsubscribable.
    for (const name of CONNECT_EVENT_NAMES) {
      const listener = (): void => {};
      call.on(name, listener);
      call.off(name, listener);
    }
    call.dispose();
  });
});

describe('error taxonomy pinning', () => {
  it('derives retryable from the contracts classification for every code', () => {
    for (const code of CONNECT_ERROR_CODES) {
      const error = new VideofyConnectError(code, 'test');
      expect(error.retryable).toBe(classifyConnectError(code) === 'retryable');
      expect(error.toPublicError()).toEqual({
        code,
        message: 'test',
        retryable: error.retryable,
      });
    }
  });
});
