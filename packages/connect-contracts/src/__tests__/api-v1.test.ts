/** @owner masterzee001 */
import { describe, expect, it } from 'vitest';
import {
  CALL_METADATA_MAX_BYTES,
  CallResourceSchema,
  CallStateResponseSchema,
  CapabilitiesResponseSchema,
  CreateCallRequestSchema,
  DISPLAY_NAME_MAX_LENGTH,
  IssuedJoinTokenSchema,
  JOIN_TOKEN_DEFAULT_TTL_SECONDS,
  JOIN_TOKEN_MAX_TTL_SECONDS,
  JoinParticipantEchoSchema,
  JoinTokenRequestSchema,
  JoinTokenResponseSchema,
  LanguageTagSchema,
  UpdateCallModeRequestSchema,
} from '../index.js';

const participant = {
  subject: 'customer_8291',
  displayName: 'Ada',
  speakLanguage: 'en',
  hearLanguage: 'es',
};

describe('POST /v1/calls request', () => {
  it('accepts every type/mode combination', () => {
    for (const type of ['personal', 'conference'] as const) {
      for (const mode of ['normal', 'translated'] as const) {
        expect(CreateCallRequestSchema.safeParse({ type, mode }).success).toBe(true);
      }
    }
  });

  it('refuses unknown type or mode values and unknown keys', () => {
    expect(CreateCallRequestSchema.safeParse({ type: 'webinar', mode: 'normal' }).success).toBe(false);
    expect(CreateCallRequestSchema.safeParse({ type: 'personal', mode: 'loud' }).success).toBe(false);
    expect(
      CreateCallRequestSchema.safeParse({ type: 'personal', mode: 'normal', owner: 'me' }).success,
    ).toBe(false);
    expect(CreateCallRequestSchema.safeParse({ type: 'personal' }).success).toBe(false);
  });

  it('accepts metadata up to exactly the byte cap', () => {
    // {"pad":"<n chars>"} serializes to n + 10 ASCII bytes.
    const atCap = { pad: 'x'.repeat(CALL_METADATA_MAX_BYTES - 10) };
    expect(JSON.stringify(atCap)).toHaveLength(CALL_METADATA_MAX_BYTES);
    expect(
      CreateCallRequestSchema.safeParse({ type: 'personal', mode: 'normal', metadata: atCap }).success,
    ).toBe(true);
  });

  it('refuses metadata one byte over the cap', () => {
    const overCap = { pad: 'x'.repeat(CALL_METADATA_MAX_BYTES - 9) };
    expect(
      CreateCallRequestSchema.safeParse({ type: 'personal', mode: 'normal', metadata: overCap })
        .success,
    ).toBe(false);
  });

  it('counts metadata bytes, not characters', () => {
    // 510 two-byte characters: 518 JSON characters but 1028 bytes.
    const multibyte = { p: 'é'.repeat(510) };
    expect(JSON.stringify(multibyte).length).toBeLessThan(CALL_METADATA_MAX_BYTES);
    expect(
      CreateCallRequestSchema.safeParse({ type: 'personal', mode: 'normal', metadata: multibyte })
        .success,
    ).toBe(false);
  });
});

describe('join-token request', () => {
  it('accepts a minimal participant and applies the locked defaults', () => {
    const parsed = JoinTokenRequestSchema.parse({ participant });
    expect(parsed.participant.voiceGender).toBe('female');
    expect(parsed.participant.audioMode).toBe('translated');
    expect(parsed.participant.captionsEnabled).toBe(true);
    expect(parsed.expiresInSeconds).toBeUndefined();
  });

  it('keeps explicit preferences instead of defaults', () => {
    const parsed = JoinTokenRequestSchema.parse({
      participant: {
        ...participant,
        audioMode: 'interpretation',
        captionsEnabled: false,
        voiceGender: 'male',
      },
      expiresInSeconds: 600,
    });
    expect(parsed.participant.audioMode).toBe('interpretation');
    expect(parsed.participant.captionsEnabled).toBe(false);
    expect(parsed.participant.voiceGender).toBe('male');
    expect(parsed.expiresInSeconds).toBe(600);
  });

  it('enforces the TTL ceiling of 900 and rejects non-positive or fractional lifetimes', () => {
    expect(JOIN_TOKEN_DEFAULT_TTL_SECONDS).toBe(300);
    expect(JOIN_TOKEN_MAX_TTL_SECONDS).toBe(900);
    expect(JoinTokenRequestSchema.safeParse({ participant, expiresInSeconds: 1 }).success).toBe(true);
    expect(JoinTokenRequestSchema.safeParse({ participant, expiresInSeconds: 900 }).success).toBe(true);
    for (const bad of [0, -30, 901, 3600, 300.5, '300']) {
      expect(JoinTokenRequestSchema.safeParse({ participant, expiresInSeconds: bad }).success).toBe(
        false,
      );
    }
  });

  it('trims display names and enforces the 80-character cap after trimming', () => {
    const trimmed = JoinTokenRequestSchema.parse({
      participant: { ...participant, displayName: '  Ada  ' },
    });
    expect(trimmed.participant.displayName).toBe('Ada');
    expect(
      JoinTokenRequestSchema.safeParse({
        participant: { ...participant, displayName: 'x'.repeat(DISPLAY_NAME_MAX_LENGTH) },
      }).success,
    ).toBe(true);
    for (const bad of ['', '   ', 'x'.repeat(DISPLAY_NAME_MAX_LENGTH + 1)]) {
      expect(
        JoinTokenRequestSchema.safeParse({ participant: { ...participant, displayName: bad } })
          .success,
      ).toBe(false);
    }
  });

  it('enforces subject bounds while treating the value as opaque', () => {
    expect(
      JoinTokenRequestSchema.safeParse({ participant: { ...participant, subject: 'u'.repeat(128) } })
        .success,
    ).toBe(true);
    expect(
      JoinTokenRequestSchema.safeParse({
        participant: { ...participant, subject: 'über-id ✓' },
      }).success,
    ).toBe(true);
    for (const bad of ['', 'u'.repeat(129), 42]) {
      expect(
        JoinTokenRequestSchema.safeParse({ participant: { ...participant, subject: bad } }).success,
      ).toBe(false);
    }
  });

  it('checks the BCP-47 shape of both languages', () => {
    for (const good of ['en', 'es', 'fr', 'en-US', 'zh-Hant', 'es-419']) {
      expect(LanguageTagSchema.safeParse(good).success).toBe(true);
      expect(
        JoinTokenRequestSchema.safeParse({ participant: { ...participant, speakLanguage: good } })
          .success,
      ).toBe(true);
    }
    for (const bad of ['', 'e', 'english', 'en_US', 'en-', '-en', 'en--US', 'en US', 'a'.repeat(36)]) {
      expect(LanguageTagSchema.safeParse(bad).success).toBe(false);
      expect(
        JoinTokenRequestSchema.safeParse({ participant: { ...participant, hearLanguage: bad } })
          .success,
      ).toBe(false);
    }
  });

  it('refuses unknown keys at both levels', () => {
    expect(
      JoinTokenRequestSchema.safeParse({ participant, role: 'operator' }).success,
    ).toBe(false);
    expect(
      JoinTokenRequestSchema.safeParse({ participant: { ...participant, isOwner: true } }).success,
    ).toBe(false);
  });
});

describe('join-token response', () => {
  const echo = {
    ...participant,
    audioMode: 'translated',
    captionsEnabled: true,
    voiceGender: 'female',
  };

  it('exposes only token and expiresAt as the credential surface', () => {
    expect(
      IssuedJoinTokenSchema.safeParse({ token: 'opaque.credential', expiresAt: '2026-08-18T12:05:00.000Z' })
        .success,
    ).toBe(true);
    expect(
      IssuedJoinTokenSchema.safeParse({
        token: 'opaque.credential',
        expiresAt: '2026-08-18T12:05:00.000Z',
        claims: {},
      }).success,
    ).toBe(false);
  });

  it('requires the participant echo to be fully resolved — no unapplied defaults', () => {
    expect(
      JoinTokenResponseSchema.safeParse({
        token: 'opaque.credential',
        expiresAt: '2026-08-18T12:05:00.000Z',
        participant: echo,
      }).success,
    ).toBe(true);
    const { voiceGender: _omitted, ...unresolved } = echo;
    expect(JoinParticipantEchoSchema.safeParse(unresolved).success).toBe(false);
    expect(
      JoinTokenResponseSchema.safeParse({
        token: 'opaque.credential',
        expiresAt: '2026-08-18T12:05:00.000Z',
        participant: unresolved,
      }).success,
    ).toBe(false);
  });

  it('requires a well-formed UTC expiry', () => {
    expect(
      JoinTokenResponseSchema.safeParse({
        token: 'opaque.credential',
        expiresAt: 'in five minutes',
        participant: echo,
      }).success,
    ).toBe(false);
  });
});

describe('call resource and state responses', () => {
  const resource = {
    callId: 'vc_0123456789abcdef',
    type: 'conference',
    mode: 'translated',
    createdAt: '2026-08-18T12:00:00.000Z',
  };

  it('accepts a call resource with and without the optional fields', () => {
    expect(CallResourceSchema.safeParse(resource).success).toBe(true);
    expect(
      CallResourceSchema.safeParse({ ...resource, ended: true, metadata: { order: 42 } }).success,
    ).toBe(true);
  });

  it('refuses malformed ids, timestamps, and surface growth', () => {
    expect(CallResourceSchema.safeParse({ ...resource, callId: 'vc_short' }).success).toBe(false);
    expect(CallResourceSchema.safeParse({ ...resource, createdAt: 'yesterday' }).success).toBe(false);
    expect(CallResourceSchema.safeParse({ ...resource, internalId: 'x' }).success).toBe(false);
  });

  it('carries both identities on every participant state entry', () => {
    const state = {
      callId: 'vc_0123456789abcdef',
      type: 'personal',
      mode: 'translated',
      participants: [
        {
          participantId: 'participant_1',
          subject: 'customer_8291',
          displayName: 'Ada',
          speakLanguage: 'en',
          hearLanguage: 'es',
          connected: true,
        },
      ],
    };
    expect(CallStateResponseSchema.safeParse(state).success).toBe(true);
    const first = state.participants[0];
    if (!first) throw new Error('test fixture must contain one participant');
    const { subject: _dropped, ...missingSubject } = first;
    expect(
      CallStateResponseSchema.safeParse({ ...state, participants: [missingSubject] }).success,
    ).toBe(false);
    expect(
      CallStateResponseSchema.safeParse({
        ...state,
        participants: [{ ...first, connected: 'yes' }],
      }).success,
    ).toBe(false);
  });
});

describe('PATCH /v1/calls/:id request', () => {
  it('accepts only a mode change', () => {
    expect(UpdateCallModeRequestSchema.safeParse({ mode: 'normal' }).success).toBe(true);
    expect(UpdateCallModeRequestSchema.safeParse({ mode: 'translated' }).success).toBe(true);
    expect(UpdateCallModeRequestSchema.safeParse({ mode: 'silent' }).success).toBe(false);
    expect(UpdateCallModeRequestSchema.safeParse({ mode: 'normal', type: 'personal' }).success).toBe(
      false,
    );
    expect(UpdateCallModeRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('GET /v1/capabilities response (R9)', () => {
  const r9 = {
    languages: ['en', 'es', 'fr'],
    limits: { personalParticipants: 2, conferenceParticipants: 4 },
    features: {
      personalCall: true,
      conference: true,
      video: true,
      translatedCalls: true,
      personalVoice: false,
    },
  };

  it('accepts the exact R9 document', () => {
    expect(CapabilitiesResponseSchema.parse(r9)).toEqual(r9);
  });

  it('refuses growth anywhere but through this contract', () => {
    expect(CapabilitiesResponseSchema.safeParse({ ...r9, provider: 'internal' }).success).toBe(false);
    expect(
      CapabilitiesResponseSchema.safeParse({
        ...r9,
        limits: { ...r9.limits, maxBitrate: 128 },
      }).success,
    ).toBe(false);
    expect(
      CapabilitiesResponseSchema.safeParse({
        ...r9,
        features: { ...r9.features, recordings: true },
      }).success,
    ).toBe(false);
  });

  it('refuses missing feature keys and malformed limits', () => {
    const { personalVoice: _omitted, ...partialFeatures } = r9.features;
    expect(
      CapabilitiesResponseSchema.safeParse({ ...r9, features: partialFeatures }).success,
    ).toBe(false);
    expect(
      CapabilitiesResponseSchema.safeParse({
        ...r9,
        limits: { personalParticipants: 2.5, conferenceParticipants: 4 },
      }).success,
    ).toBe(false);
    expect(
      CapabilitiesResponseSchema.safeParse({
        ...r9,
        limits: { personalParticipants: 0, conferenceParticipants: 4 },
      }).success,
    ).toBe(false);
    expect(CapabilitiesResponseSchema.safeParse({ ...r9, languages: [] }).success).toBe(false);
    expect(CapabilitiesResponseSchema.safeParse({ ...r9, languages: ['english'] }).success).toBe(
      false,
    );
  });
});
