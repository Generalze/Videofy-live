/** @author masterzee001 */
/**
 * C-AI1.1F pins: translated audio reaches the adapter that can play it, and
 * never one that cannot.
 */
import { describe, expect, it } from 'vitest';
import type { TranslatedMediaPayload } from '@videofy-live/adapter-wire';
import {
  TranslatedEgressRouter,
  type TranslatedEgressTarget,
} from '../translated-egress-router.js';

function target() {
  const sent: { streamId: number; payload: TranslatedMediaPayload }[] = [];
  let accept = true;
  const value: TranslatedEgressTarget = {
    sendTranslatedMedia: (streamId, payload) => {
      if (!accept) return false;
      sent.push({ streamId, payload });
      return true;
    },
  };
  return { value, sent, refuse: () => { accept = false; } };
}

const payload: TranslatedMediaPayload = {
  targetLanguage: 'es',
  segmentId: 'seg_1',
  generation: 1,
  sequence: 0,
  final: false,
  samples: Int16Array.from([1, 2, 3]),
};

describe('the mapping is recorded, never derived', () => {
  it('PIN: a registered leg receives its own stream id', () => {
    const router = new TranslatedEgressRouter();
    const adapter = target();
    router.register('cs_1', 'p_1', adapter.value, 42);

    expect(router.send('cs_1', 'p_1', payload, 1000)).toBe('sent');
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0]?.streamId).toBe(42);
  });

  it('PIN: a session with no adapter leg is an ordinary answer, not a failure', () => {
    const router = new TranslatedEgressRouter();
    // Most sessions are browser-only. Treating that as an error would fill the
    // log with the normal case and hide the abnormal one.
    expect(router.send('cs_browser', 'p_1', payload, 1000)).toBe('no-adapter-listener');
  });

  it('PIN: forgetting a leg stops audio going down a dead socket', () => {
    const router = new TranslatedEgressRouter();
    const adapter = target();
    router.register('cs_1', 'p_1', adapter.value, 7);
    router.forget('cs_1', 'p_1');

    // Stream ids are reassigned after a reconnect, so a stale entry would send
    // one call's translated audio into another call's stream.
    expect(router.send('cs_1', 'p_1', payload, 1000)).toBe('no-adapter-listener');
    expect(adapter.sent).toHaveLength(0);
  });

  it('PIN: a dropped connection forgets every leg it carried at once', () => {
    const router = new TranslatedEgressRouter();
    const adapter = target();
    const other = target();
    router.register('cs_1', 'p_1', adapter.value, 1);
    router.register('cs_1', 'p_2', adapter.value, 2);
    router.register('cs_2', 'p_3', other.value, 3);

    router.forgetTarget(adapter.value);
    expect(router.size).toBe(1);
    expect(router.send('cs_1', 'p_1', payload, 0)).toBe('no-adapter-listener');
    expect(router.send('cs_2', 'p_3', payload, 0)).toBe('sent');
  });

  it('PIN: two legs of one session are distinct, not merged', () => {
    const router = new TranslatedEgressRouter();
    const a = target();
    const b = target();
    router.register('cs_1', 'p_1', a.value, 1);
    router.register('cs_1', 'p_2', b.value, 2);

    router.send('cs_1', 'p_1', payload, 0);
    // A conference has several SIP participants; one leg's audio must not be
    // delivered to another's endpoint.
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(0);
    expect(router.participantsFor('cs_1').sort()).toEqual(['p_1', 'p_2']);
  });

  it('a refused send is reported rather than swallowed', () => {
    const router = new TranslatedEgressRouter();
    const adapter = target();
    router.register('cs_1', 'p_1', adapter.value, 1);
    adapter.refuse();
    expect(router.send('cs_1', 'p_1', payload, 0)).toBe('send-failed');
  });

  it('participantsFor does not leak other sessions', () => {
    const router = new TranslatedEgressRouter();
    const adapter = target();
    router.register('cs_1', 'p_1', adapter.value, 1);
    router.register('cs_10', 'p_9', adapter.value, 2);
    // A prefix match on the session id alone would return p_9 here, because
    // 'cs_1' is a prefix of 'cs_10'.
    expect(router.participantsFor('cs_1')).toEqual(['p_1']);
  });
});
