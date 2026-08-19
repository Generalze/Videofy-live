/** @owner masterzee001 */
import { describe, expect, it } from 'vitest';
import { CALL_EVENTS } from '@videofy-live/call-client-core';
import type { CallLanguage, CallParticipantSummary } from '@videofy-live/call-client-core';
import type { CallSnapshot, CallParticipantView, CallCaptionView } from '@videofy-live/connect-contracts';
import { createVideofyClientWith } from '../client';
import { buildTestToken, makeHarness, okJoinAck, settle, wireSnapshot } from './fakes';

type WireParticipant = CallParticipantSummary & { subject?: string };

function remoteParticipant(overrides: Partial<WireParticipant> = {}): WireParticipant {
  return {
    participantId: 'participant_2',
    displayName: 'Ben',
    speakLanguage: 'en',
    hearLanguage: 'en',
    joined: true,
    subject: 'customer_1177',
    ...overrides,
  };
}

async function joinedCall() {
  const harness = makeHarness();
  harness.socket.respond = (event) => (event === CALL_EVENTS.JOIN ? okJoinAck() : undefined);
  const client = createVideofyClientWith(harness.config, harness.deps);
  const call = await client.join({ token: buildTestToken() });
  return { harness, call };
}

describe('snapshot emission', () => {
  it('emits a fresh immutable snapshot on every state broadcast', async () => {
    const { harness, call } = await joinedCall();
    const seen: CallSnapshot[] = [];
    call.on('state', (snapshot) => seen.push(snapshot));

    harness.socket.fire(
      CALL_EVENTS.STATE,
      wireSnapshot({
        participants: [...wireSnapshot().participants!, remoteParticipant()],
      }),
    );
    harness.socket.fire(CALL_EVENTS.STATE, wireSnapshot());

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]).not.toBe(seen[1]);
    for (const snapshot of seen) {
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.participants)).toBe(true);
      expect(Object.isFrozen(snapshot.self)).toBe(true);
    }
    expect(seen[0]!.participants).toHaveLength(1);
    expect(seen[1]!.participants).toHaveLength(0);
    call.dispose();
  });

  it('emits granular participant events from roster diffs', async () => {
    const { harness, call } = await joinedCall();
    const joined: CallParticipantView[] = [];
    const left: CallParticipantView[] = [];
    const updated: CallParticipantView[] = [];
    call.on('participantJoined', (p) => joined.push(p));
    call.on('participantLeft', (p) => left.push(p));
    call.on('participantUpdated', (p) => updated.push(p));

    const withBen = wireSnapshot({
      participants: [...wireSnapshot().participants!, remoteParticipant()],
    });
    harness.socket.fire(CALL_EVENTS.STATE, withBen);
    expect(joined).toHaveLength(1);
    expect(joined[0]!.participantId).toBe('participant_2');
    expect(joined[0]!.subject).toBe('customer_1177');
    expect(joined[0]!.connected).toBe(true);

    harness.socket.fire(
      CALL_EVENTS.STATE,
      wireSnapshot({
        participants: [...wireSnapshot().participants!, remoteParticipant({ joined: false })],
      }),
    );
    expect(updated).toHaveLength(1);
    expect(updated[0]!.connected).toBe(false);

    harness.socket.fire(CALL_EVENTS.STATE, wireSnapshot());
    expect(left).toHaveLength(1);
    expect(left[0]!.participantId).toBe('participant_2');
    call.dispose();
  });

  it('emits callModeChanged when the authoritative call mode flips', async () => {
    const { harness, call } = await joinedCall();
    const modes: string[] = [];
    call.on('callModeChanged', ({ mode }) => modes.push(mode));

    harness.socket.fire(CALL_EVENTS.STATE, wireSnapshot({ callMode: 'normal' }));
    harness.socket.fire(CALL_EVENTS.STATE, wireSnapshot({ callMode: 'translated' }));

    expect(modes).toEqual(['normal', 'translated']);
    call.dispose();
  });

  it('merges captions into the bounded ring and emits caption events', async () => {
    const { harness, call } = await joinedCall();
    const captions: CallCaptionView[] = [];
    call.on('caption', (caption) => captions.push(caption));

    harness.socket.fire(CALL_EVENTS.CAPTION, {
      callId: 'connect_projtest_abc123def456',
      speakerParticipantId: 'participant_2',
      speakerDisplayName: 'Ben',
      sourceLanguage: 'en',
      targetLanguage: 'es',
      originalText: 'Hello',
      translatedText: 'Hola',
      sequence: 1,
      mediaRevision: 1,
      languageRevision: 1,
      startMs: 0,
      endMs: 800,
      isFinal: true,
    });

    expect(captions).toHaveLength(1);
    expect(captions[0]!.text).toBe('Hola');
    expect(captions[0]!.language).toBe('es');
    expect(captions[0]!.final).toBe(true);
    const snapshot = call.getSnapshot();
    expect(snapshot.captions).toHaveLength(1);
    expect(snapshot.captions[0]!.displayName).toBe('Ben');
    // The transcript quotes the finals.
    expect(call.getTranscript()).toContain('Ben: Hola');
    call.dispose();
  });
});

describe('deliveryState mapping', () => {
  function rosterWith(speakLanguage: CallLanguage) {
    // Self hears 'es' (token pref mirrored by the wire snapshot).
    return wireSnapshot({
      participants: [
        ...wireSnapshot().participants!,
        remoteParticipant({ speakLanguage, hearLanguage: 'en' }),
      ],
    });
  }

  it('maps cross-language speakers by audio mode: translated, reduced, original', async () => {
    const { harness, call } = await joinedCall();

    // translated mode: the generated voice IS the delivery -> 'translated'.
    harness.socket.fire(CALL_EVENTS.STATE, rosterWith('en'));
    expect(call.getSnapshot().participants[0]!.deliveryState).toBe('translated');

    // interpretation: original held underneath the translation -> 'reduced'.
    call.setAudioMode('interpretation');
    expect(call.getSnapshot().participants[0]!.deliveryState).toBe('reduced');

    // original mode: no synthetic replacement at all -> 'original'.
    call.setAudioMode('original');
    expect(call.getSnapshot().participants[0]!.deliveryState).toBe('original');
    call.dispose();
  });

  it('keeps a same-language speaker at original in every mode', async () => {
    const { harness, call } = await joinedCall();
    harness.socket.fire(CALL_EVENTS.STATE, rosterWith('es'));
    expect(call.getSnapshot().participants[0]!.deliveryState).toBe('original');
    call.setAudioMode('interpretation');
    expect(call.getSnapshot().participants[0]!.deliveryState).toBe('original');
    call.dispose();
  });

  it('treats a normal-mode call as original delivery regardless of listener mode', async () => {
    const { harness, call } = await joinedCall();
    call.setAudioMode('translated');
    harness.socket.fire(
      CALL_EVENTS.STATE,
      wireSnapshot({
        callMode: 'normal',
        participants: [
          ...wireSnapshot().participants!,
          remoteParticipant({ speakLanguage: 'en' }),
        ],
      }),
    );
    expect(call.getSnapshot().participants[0]!.deliveryState).toBe('original');
    call.dispose();
  });

  it('never lets the internal gain float cross the public surface', async () => {
    const { harness, call } = await joinedCall();
    call.setAudioMode('interpretation');
    harness.socket.fire(CALL_EVENTS.STATE, rosterWith('en'));
    const serialized = JSON.stringify(call.getSnapshot());
    expect(serialized).not.toContain('modeGain');
    expect(serialized).not.toContain('originalGain');
    expect(serialized).not.toContain('0.25');
    call.dispose();
  });
});

describe('self view', () => {
  it('follows the listener preference mutations and emits state for each', async () => {
    const { harness, call } = await joinedCall();
    const states: CallSnapshot[] = [];
    call.on('state', (snapshot) => states.push(snapshot));

    call.setCaptions(false);
    expect(call.getSnapshot().self.captionsEnabled).toBe(false);
    call.setAudioMode('interpretation');
    expect(call.getSnapshot().self.audioMode).toBe('interpretation');
    expect(states.length).toBeGreaterThanOrEqual(2);

    // Hear-language change is ack-gated and NOT applied optimistically: the
    // wire snapshot stays authoritative, so the ack alone keeps the old value
    // until the room broadcast lands.
    harness.socket.respond = (event) =>
      event === CALL_EVENTS.SET_CAPTION_LANGUAGE ? { ok: true } : undefined;
    await call.setHearLanguage('en');
    await settle();
    expect(call.getSnapshot().self.hearLanguage).toBe('es');
    harness.socket.fire(
      CALL_EVENTS.STATE,
      wireSnapshot({
        participants: [
          {
            participantId: 'participant_1',
            displayName: 'Ana',
            speakLanguage: 'es',
            hearLanguage: 'en',
            joined: true,
          },
        ],
      }),
    );
    expect(call.getSnapshot().self.hearLanguage).toBe('en');
    call.dispose();
  });
});

describe('ack snapshot monotonicity (proven defect)', () => {
  it('never regresses a STATE broadcast that raced ahead of the join ack', async () => {
    // The gateway broadcasts STATE on join completion and only acks after an
    // ingest round-trip: a second joiner's broadcast can land on this socket
    // BEFORE our own ack. The ack's snapshot is older by construction and
    // must not shrink the roster back (the one-tile-room incident).
    const harness = makeHarness();
    harness.socket.respond = (event) => {
      if (event !== CALL_EVENTS.JOIN) return undefined;
      // Fresher room state arrives synchronously, ahead of the microtask ack.
      harness.socket.fire(
        CALL_EVENTS.STATE,
        wireSnapshot({
          participants: [...wireSnapshot().participants!, remoteParticipant()],
        }),
      );
      return okJoinAck(); // snapshot: self only — captured before Ben joined
    };
    const client = createVideofyClientWith(harness.config, harness.deps);
    const call = await client.join({ token: buildTestToken() });
    expect(call.getSnapshot().participants).toHaveLength(1);
    expect(call.getSnapshot().participants[0]!.participantId).toBe('participant_2');
    call.dispose();
  });
});
