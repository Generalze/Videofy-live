/** @owner masterzee001 */
import { WEBRTC_SIGNALLING_LIMITS } from '@videofy-live/shared-types';
import { describe, expect, it } from 'vitest';
import {
  CallAudioModePayloadSchema,
  CallBoundPayloadSchema,
  CallCaptionLanguagePayloadSchema,
  CallCaptureSettingsPayloadSchema,
  CallIceCandidateInitSchema,
  CallIcePayloadSchema,
  CallJoinPayloadSchema,
  CallPlaybackPayloadSchema,
  CallSdpPayloadSchema,
  CallSetModePayloadSchema,
  CallTranscriptPolicyPayloadSchema,
  CallVideoIcePayloadSchema,
  CallVideoSdpPayloadSchema,
  CallWireObjectSchema,
} from '../wire-schemas.js';

/**
 * Acceptance-parity suite: every case documents the legacy gateway check the
 * schema replaced. A failure here means the schema drifted from the deployed
 * wire behavior — fix the schema, not the test.
 */

describe('CallWireObjectSchema — the legacy `!raw || typeof raw !== "object"` guard', () => {
  it('accepts plain objects AND arrays, exactly like typeof', () => {
    expect(CallWireObjectSchema.safeParse({}).success).toBe(true);
    expect(CallWireObjectSchema.safeParse({ anything: 1 }).success).toBe(true);
    // typeof [] === 'object': the legacy guard let arrays through to the store.
    expect(CallWireObjectSchema.safeParse([]).success).toBe(true);
  });

  it('refuses null, undefined, and every non-object primitive', () => {
    for (const value of [null, undefined, 'x', 0, 1, true, false, Symbol('s'), () => undefined]) {
      expect(CallWireObjectSchema.safeParse(value).success).toBe(false);
    }
  });

  it('passes the value through by reference — no clone, like the cast it replaced', () => {
    const payload = { callId: 'demo', nested: { keep: true } };
    const parsed = CallWireObjectSchema.safeParse(payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBe(payload);
  });
});

describe('join + bound payloads stay object-ness only', () => {
  it('join: field validation stays with the store, so a wrong-typed field still parses', () => {
    // Legacy: this reached the store, whose message 'A display name is
    // required.' is part of the ack contract.
    expect(CallJoinPayloadSchema.safeParse({ callId: 'demo', displayName: 42 }).success).toBe(true);
  });

  it('bound: id equality belongs to the runtime, so foreign ids still parse', () => {
    expect(
      CallBoundPayloadSchema.safeParse({ callId: 'other', participantId: 'participant_9' }).success,
    ).toBe(true);
  });
});

describe('CallCaptionLanguagePayloadSchema', () => {
  it('accepts ANY string — the store owns the vocabulary', () => {
    expect(CallCaptionLanguagePayloadSchema.safeParse({ hearLanguage: 'de' }).success).toBe(true);
  });

  it('refuses a non-string, as the typeof check did', () => {
    expect(CallCaptionLanguagePayloadSchema.safeParse({ hearLanguage: 7 }).success).toBe(false);
    expect(CallCaptionLanguagePayloadSchema.safeParse({}).success).toBe(false);
  });
});

describe('CallAudioModePayloadSchema — deliberately looser than the enum', () => {
  it('accepts an out-of-vocabulary string so the store can answer invalid-audio-mode', () => {
    expect(CallAudioModePayloadSchema.safeParse({ audioMode: 'loudest' }).success).toBe(true);
  });

  it('refuses a non-string', () => {
    expect(CallAudioModePayloadSchema.safeParse({ audioMode: true }).success).toBe(false);
  });
});

describe('CallSetModePayloadSchema — the one gateway-enforced enum', () => {
  it('accepts exactly the two modes', () => {
    expect(CallSetModePayloadSchema.safeParse({ mode: 'normal' }).success).toBe(true);
    expect(CallSetModePayloadSchema.safeParse({ mode: 'translated' }).success).toBe(true);
  });

  it("refuses a mode outside the vocabulary, as the handler's own check did", () => {
    expect(CallSetModePayloadSchema.safeParse({ mode: 'loud' }).success).toBe(false);
  });
});

describe('CallTranscriptPolicyPayloadSchema', () => {
  it('accepts only a boolean allowed', () => {
    expect(CallTranscriptPolicyPayloadSchema.safeParse({ allowed: false }).success).toBe(true);
    expect(CallTranscriptPolicyPayloadSchema.safeParse({ allowed: 'yes' }).success).toBe(false);
  });
});

describe('CallSdpPayloadSchema — legacy readSdp', () => {
  it('accepts a non-empty sdp up to the shared limit', () => {
    expect(CallSdpPayloadSchema.safeParse({ sdp: 'v=0' }).success).toBe(true);
    expect(
      CallSdpPayloadSchema.safeParse({ sdp: 'x'.repeat(WEBRTC_SIGNALLING_LIMITS.sdpMaxLength) })
        .success,
    ).toBe(true);
  });

  it('refuses empty, oversize, and non-string sdp', () => {
    expect(CallSdpPayloadSchema.safeParse({ sdp: '' }).success).toBe(false);
    expect(
      CallSdpPayloadSchema.safeParse({ sdp: 'x'.repeat(WEBRTC_SIGNALLING_LIMITS.sdpMaxLength + 1) })
        .success,
    ).toBe(false);
    expect(CallSdpPayloadSchema.safeParse({ sdp: 42 }).success).toBe(false);
  });
});

describe('CallIceCandidateInitSchema — legacy readCandidate, coercions included', () => {
  it('requires a non-empty, size-limited candidate string', () => {
    expect(CallIceCandidateInitSchema.safeParse({ candidate: 'candidate:1' }).success).toBe(true);
    expect(CallIceCandidateInitSchema.safeParse({ candidate: '' }).success).toBe(false);
    expect(
      CallIceCandidateInitSchema.safeParse({
        candidate: 'x'.repeat(WEBRTC_SIGNALLING_LIMITS.iceCandidateMaxLength + 1),
      }).success,
    ).toBe(false);
  });

  it('coerces wrong-typed sdpMid/sdpMLineIndex to null instead of refusing', () => {
    const parsed = CallIceCandidateInitSchema.parse({
      candidate: 'candidate:1',
      sdpMid: 42,
      sdpMLineIndex: 'zero',
    });
    expect(parsed.sdpMid).toBeNull();
    expect(parsed.sdpMLineIndex).toBeNull();
  });

  it('fills missing sdpMid/sdpMLineIndex with null, like the legacy rebuild', () => {
    const parsed = CallIceCandidateInitSchema.parse({ candidate: 'candidate:1' });
    expect(parsed.sdpMid).toBeNull();
    expect(parsed.sdpMLineIndex).toBeNull();
    expect(parsed.usernameFragment).toBeUndefined();
  });

  it('keeps a string usernameFragment and drops every other type', () => {
    expect(
      CallIceCandidateInitSchema.parse({ candidate: 'c', usernameFragment: 'ufrag' })
        .usernameFragment,
    ).toBe('ufrag');
    expect(
      CallIceCandidateInitSchema.parse({ candidate: 'c', usernameFragment: 9 }).usernameFragment,
    ).toBeUndefined();
  });

  it('keeps NaN for sdpMLineIndex — typeof NaN is number, and the legacy read kept it', () => {
    const parsed = CallIceCandidateInitSchema.parse({ candidate: 'c', sdpMLineIndex: Number.NaN });
    expect(Number.isNaN(parsed.sdpMLineIndex)).toBe(true);
  });

  it('drops unknown keys, as the legacy rebuild dropped them', () => {
    const parsed = CallIceCandidateInitSchema.parse({ candidate: 'c', extra: 'gone' });
    expect('extra' in parsed).toBe(false);
  });
});

describe('audio vs video ICE null handling', () => {
  it('audio ICE refuses a null candidate, as readCandidate did', () => {
    expect(CallIcePayloadSchema.safeParse({ candidate: null }).success).toBe(false);
    expect(CallIcePayloadSchema.safeParse({}).success).toBe(false);
    expect(CallIcePayloadSchema.safeParse({ candidate: { candidate: 'c' } }).success).toBe(true);
  });

  it('video ICE relays null as the end-of-candidates marker', () => {
    expect(
      CallVideoIcePayloadSchema.safeParse({ targetParticipantId: 'participant_2', candidate: null })
        .success,
    ).toBe(true);
    // Absent is NOT the marker: the legacy path fell through to readCandidate
    // and dropped the payload.
    expect(
      CallVideoIcePayloadSchema.safeParse({ targetParticipantId: 'participant_2' }).success,
    ).toBe(false);
    expect(
      CallVideoIcePayloadSchema.safeParse({
        targetParticipantId: 'participant_2',
        candidate: { candidate: '' },
      }).success,
    ).toBe(false);
  });
});

describe('CallVideoSdpPayloadSchema', () => {
  it('requires a string target and a bounded sdp; membership stays with the runtime', () => {
    expect(
      CallVideoSdpPayloadSchema.safeParse({ targetParticipantId: 'participant_2', sdp: 'v=0' })
        .success,
    ).toBe(true);
    expect(CallVideoSdpPayloadSchema.safeParse({ targetParticipantId: 7, sdp: 'v=0' }).success).toBe(
      false,
    );
    expect(
      CallVideoSdpPayloadSchema.safeParse({
        targetParticipantId: 'participant_2',
        sdp: 'x'.repeat(WEBRTC_SIGNALLING_LIMITS.sdpMaxLength + 1),
      }).success,
    ).toBe(false);
  });
});

describe('CallCaptureSettingsPayloadSchema — provenance is recorded, not validated', () => {
  it('requires settings to BE an object and nothing more', () => {
    expect(
      CallCaptureSettingsPayloadSchema.safeParse({ settings: { echoCancellation: 'all' } }).success,
    ).toBe(true);
    expect(CallCaptureSettingsPayloadSchema.safeParse({ settings: 'granted' }).success).toBe(false);
    expect(CallCaptureSettingsPayloadSchema.safeParse({}).success).toBe(false);
  });

  it('keeps the settings object by reference, so the log records what was reported', () => {
    const settings = { echoCancellation: true, futureField: 'kept' };
    const parsed = CallCaptureSettingsPayloadSchema.parse({ settings });
    expect(parsed.settings).toBe(settings);
  });

  it('preserves an unrecognised profile name rather than normalising it away', () => {
    const parsed = CallCaptureSettingsPayloadSchema.parse({
      settings: {},
      requestedCaptureProfile: 'something-nobody-defined',
    });
    expect(parsed.requestedCaptureProfile).toBe('something-nobody-defined');
  });

  it('coerces a missing/wrong-typed profile to null and a foreign reason to join', () => {
    const parsed = CallCaptureSettingsPayloadSchema.parse({
      settings: {},
      requestedCaptureProfile: 42,
      reason: 'because',
    });
    expect(parsed.requestedCaptureProfile).toBeNull();
    expect(parsed.reason).toBe('join');
    expect(CallCaptureSettingsPayloadSchema.parse({ settings: {}, reason: 'device-change' }).reason).toBe(
      'device-change',
    );
  });
});

describe('CallPlaybackPayloadSchema — degrades field by field, never refuses', () => {
  it('coerces every malformed field to its legacy default', () => {
    const parsed = CallPlaybackPayloadSchema.parse({
      stream: 'sideways',
      clipId: 42,
      phase: 'middle',
      atMs: 'now',
    });
    expect(parsed).toMatchObject({ stream: 'generated', clipId: null, phase: 'start', atMs: null });
  });

  it('keeps well-formed fields verbatim', () => {
    const parsed = CallPlaybackPayloadSchema.parse({
      stream: 'remote-original',
      clipId: 'participant_1:es:2:1:1',
      phase: 'end',
      atMs: 55_000,
    });
    expect(parsed).toMatchObject({
      stream: 'remote-original',
      clipId: 'participant_1:es:2:1:1',
      phase: 'end',
      atMs: 55_000,
    });
  });

  it('keeps NaN for atMs — the transcript log records the client clock verbatim', () => {
    const parsed = CallPlaybackPayloadSchema.parse({ atMs: Number.NaN });
    expect(Number.isNaN(parsed.atMs)).toBe(true);
  });

  it('parses an empty report to all defaults, as the legacy reads did', () => {
    expect(CallPlaybackPayloadSchema.parse({})).toMatchObject({
      stream: 'generated',
      clipId: null,
      phase: 'start',
      atMs: null,
    });
  });
});
