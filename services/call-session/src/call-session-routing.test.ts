/** @owner masterzee001 */
import { describe, expect, it } from 'vitest';

import {
  CallSessionStore,
  type CallCaptionSourceEvent,
  type CallGeneratedAudioSourceEvent,
  type CallJoinInput,
  type CallJoinResult,
} from './call-session-store.js';

function joinInput(overrides: Partial<CallJoinInput> = {}): CallJoinInput {
  return {
    callId: 'call-1',
    displayName: 'Zoe',
    speakLanguage: 'en',
    hearLanguage: 'en',
    captionsEnabled: true,
    voiceGender: 'female',
    audioMode: 'translated',
    ...overrides,
  };
}

function mustJoin(store: CallSessionStore, overrides: Partial<CallJoinInput> = {}): CallJoinResult {
  const result = store.createOrJoin(joinInput(overrides));
  if (!result.ok) {
    throw new Error(`expected join to succeed, got ${result.code}: ${result.message}`);
  }
  return result;
}

/**
 * Zoe speaks en / hears en; Carlos speaks es / hears es. After the pair joins,
 * the membership-change bump leaves Zoe at mediaRevision 2 and Carlos at 1.
 */
function translatedPair(store: CallSessionStore): { zoe: CallJoinResult; carlos: CallJoinResult } {
  const zoe = mustJoin(store, { displayName: 'Zoe', speakLanguage: 'en', hearLanguage: 'en' });
  const carlos = mustJoin(store, {
    displayName: 'Carlos',
    speakLanguage: 'es',
    hearLanguage: 'es',
    voiceGender: 'male',
  });
  return { zoe, carlos };
}

function captionEvent(overrides: Partial<CallCaptionSourceEvent> = {}): CallCaptionSourceEvent {
  return {
    sourceLanguage: 'en',
    targetLanguage: 'es',
    originalText: 'hello there',
    translatedText: 'hola',
    sequence: 7,
    mediaRevision: 2,
    languageRevision: 1,
    startMs: 1200,
    endMs: 2400,
    isFinal: true,
    ...overrides,
  };
}

function audioEvent(
  overrides: Partial<CallGeneratedAudioSourceEvent> = {},
): CallGeneratedAudioSourceEvent {
  return {
    targetLanguage: 'es',
    voiceId: 'es_ES-sharvard-male',
    audioUrl: 'https://media.local/clips/42.ogg',
    sequence: 7,
    startMs: 1200,
    durationMs: 900,
    mediaRevision: 2,
    languageRevision: 1,
    ...overrides,
  };
}

describe('CallSessionStore.routeCaption', () => {
  it('delivers a translated caption to the other participant with speaker identity', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);

    const deliveries = store.routeCaption('call-1', zoe.participantId, captionEvent());
    expect(deliveries).toEqual([
      {
        recipientParticipantId: carlos.participantId,
        payload: {
          callId: 'call-1',
          speakerParticipantId: zoe.participantId,
          speakerDisplayName: 'Zoe',
          sourceLanguage: 'en',
          targetLanguage: 'es',
          originalText: 'hello there',
          translatedText: 'hola',
          sequence: 7,
          mediaRevision: 2,
          languageRevision: 1,
          startMs: 1200,
          endMs: 2400,
          isFinal: true,
        },
      },
    ]);
  });

  it('delivers the original text with null targetLanguage to same-language recipients', () => {
    const store = new CallSessionStore();
    const zoe = mustJoin(store, { displayName: 'Zoe', speakLanguage: 'en', hearLanguage: 'en' });
    const sam = mustJoin(store, { displayName: 'Sam', speakLanguage: 'en', hearLanguage: 'en' });

    const deliveries = store.routeCaption(
      'call-1',
      zoe.participantId,
      captionEvent({ targetLanguage: null, translatedText: null }),
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.recipientParticipantId).toBe(sam.participantId);
    expect(deliveries[0]?.payload).toMatchObject({
      sourceLanguage: 'en',
      targetLanguage: null,
      originalText: 'hello there',
      translatedText: null,
    });
  });

  it('compares primary language subtags so regional variants still match', () => {
    const store = new CallSessionStore();
    const zoe = mustJoin(store, { displayName: 'Zoe', speakLanguage: 'en', hearLanguage: 'en' });
    const sam = mustJoin(store, { displayName: 'Sam', speakLanguage: 'en', hearLanguage: 'en' });

    // A pipeline emitting 'en-US' must still count as the recipient's 'en'.
    const deliveries = store.routeCaption(
      'call-1',
      zoe.participantId,
      captionEvent({ sourceLanguage: 'en-US', targetLanguage: null, translatedText: null }),
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.recipientParticipantId).toBe(sam.participantId);
    expect(deliveries[0]?.payload).toMatchObject({ targetLanguage: null });
  });

  it('never echoes a caption back to the speaker', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);

    const fromZoe = store.routeCaption('call-1', zoe.participantId, captionEvent());
    const fromCarlos = store.routeCaption(
      'call-1',
      carlos.participantId,
      captionEvent({
        sourceLanguage: 'es',
        targetLanguage: 'en',
        translatedText: 'hi',
        mediaRevision: 1, // Carlos joined second and was never bumped.
      }),
    );
    expect(fromZoe.map((d) => d.recipientParticipantId)).toEqual([carlos.participantId]);
    expect(fromCarlos.map((d) => d.recipientParticipantId)).toEqual([zoe.participantId]);
  });

  it('returns no deliveries while the speaker is alone in the call', () => {
    const store = new CallSessionStore();
    const zoe = mustJoin(store);
    expect(
      store.routeCaption('call-1', zoe.participantId, captionEvent({ mediaRevision: 1 })),
    ).toEqual([]);
  });

  it('rejects stale mediaRevision and stale languageRevision events', () => {
    const store = new CallSessionStore();
    const { zoe } = translatedPair(store);

    // Zoe is at mediaRevision 2 after the membership bump; revision 1 is stale.
    expect(
      store.routeCaption('call-1', zoe.participantId, captionEvent({ mediaRevision: 1 })),
    ).toEqual([]);
    expect(
      store.routeCaption('call-1', zoe.participantId, captionEvent({ languageRevision: 2 })),
    ).toEqual([]);
  });

  it('rejects events from before a resume and accepts the bumped revision', () => {
    const store = new CallSessionStore();
    const { zoe } = translatedPair(store);
    store.markDisconnected('call-1', zoe.participantId);
    store.createOrJoin(
      joinInput({
        displayName: 'Zoe',
        resumeParticipantId: zoe.participantId,
        resumeToken: zoe.resumeToken,
      }),
    );

    // Resume moved Zoe from 2 to 3; pre-resume events must not route.
    expect(
      store.routeCaption('call-1', zoe.participantId, captionEvent({ mediaRevision: 2 })),
    ).toEqual([]);
    expect(
      store.routeCaption('call-1', zoe.participantId, captionEvent({ mediaRevision: 3 })),
    ).toHaveLength(1);
  });

  it('does not deliver an untranslated event to a recipient who needs translation', () => {
    const store = new CallSessionStore();
    const { zoe } = translatedPair(store);

    // Interim original-only caption: Carlos hears es, so nothing routes yet.
    const deliveries = store.routeCaption(
      'call-1',
      zoe.participantId,
      captionEvent({ targetLanguage: null, translatedText: null }),
    );
    expect(deliveries).toEqual([]);
  });

  it('does not deliver to disconnected recipients', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);
    store.markDisconnected('call-1', carlos.participantId);

    expect(store.routeCaption('call-1', zoe.participantId, captionEvent())).toEqual([]);
  });

  it('returns no deliveries for unknown calls or speakers', () => {
    const store = new CallSessionStore();
    translatedPair(store);
    expect(store.routeCaption('ghost-call', 'participant_1', captionEvent())).toEqual([]);
    expect(store.routeCaption('call-1', 'participant_99', captionEvent())).toEqual([]);
  });
});

describe('CallSessionStore.routeGeneratedAudio', () => {
  it('delivers generated audio to the matching-language recipient with the voice id', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);

    const deliveries = store.routeGeneratedAudio('call-1', zoe.participantId, audioEvent());
    expect(deliveries).toEqual([
      {
        recipientParticipantId: carlos.participantId,
        payload: {
          callId: 'call-1',
          speakerParticipantId: zoe.participantId,
          targetLanguage: 'es',
          voiceId: 'es_ES-sharvard-male',
          audioUrl: 'https://media.local/clips/42.ogg',
          sequence: 7,
          startMs: 1200,
          durationMs: 900,
          mediaRevision: 2,
          languageRevision: 1,
        },
      },
    ]);
  });

  it('delivers regardless of which voice id the pipeline used', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);

    const deliveries = store.routeGeneratedAudio(
      'call-1',
      zoe.participantId,
      audioEvent({ voiceId: 'es_ES-sharvard-female' }),
    );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.recipientParticipantId).toBe(carlos.participantId);
    expect(deliveries[0]?.payload).toMatchObject({ voiceId: 'es_ES-sharvard-female' });
  });

  it('matches recipient language on the primary subtag', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);

    const deliveries = store.routeGeneratedAudio(
      'call-1',
      zoe.participantId,
      audioEvent({ targetLanguage: 'es-ES' }),
    );
    expect(deliveries.map((d) => d.recipientParticipantId)).toEqual([carlos.participantId]);
  });

  it('never delivers back to the speaker and skips non-matching languages', () => {
    const store = new CallSessionStore();
    const { zoe } = translatedPair(store);

    // Target 'en' only matches the speaker's own hearing language; no recipient.
    const deliveries = store.routeGeneratedAudio(
      'call-1',
      zoe.participantId,
      audioEvent({ targetLanguage: 'en', voiceId: 'en_US-hfc_female-medium' }),
    );
    expect(deliveries).toEqual([]);
  });

  it('rejects stale mediaRevision and stale languageRevision events', () => {
    const store = new CallSessionStore();
    const { zoe } = translatedPair(store);

    expect(
      store.routeGeneratedAudio('call-1', zoe.participantId, audioEvent({ mediaRevision: 1 })),
    ).toEqual([]);
    expect(
      store.routeGeneratedAudio('call-1', zoe.participantId, audioEvent({ languageRevision: 0 })),
    ).toEqual([]);
  });

  it('does not deliver to disconnected recipients', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);
    store.markDisconnected('call-1', carlos.participantId);

    expect(store.routeGeneratedAudio('call-1', zoe.participantId, audioEvent())).toEqual([]);
  });

  it('returns no deliveries for unknown calls or speakers', () => {
    const store = new CallSessionStore();
    translatedPair(store);
    expect(store.routeGeneratedAudio('ghost-call', 'participant_1', audioEvent())).toEqual([]);
    expect(store.routeGeneratedAudio('call-1', 'participant_99', audioEvent())).toEqual([]);
  });

  it('stops routing entirely once the call has ended', () => {
    const store = new CallSessionStore();
    const { zoe, carlos } = translatedPair(store);
    store.leave('call-1', carlos.participantId);
    store.leave('call-1', zoe.participantId);

    expect(store.routeGeneratedAudio('call-1', zoe.participantId, audioEvent())).toEqual([]);
    expect(store.routeCaption('call-1', zoe.participantId, captionEvent())).toEqual([]);
    expect(store.activeCallCount()).toBe(0);
  });
});
