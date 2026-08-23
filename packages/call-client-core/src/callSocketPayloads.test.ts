import { describe, expect, it } from 'vitest';
import { createInitialCallJoinForm, withSpeakLanguage } from './callJoinForm';
import {
  buildCallAudioModePayload,
  buildCallCaptionLanguagePayload,
  buildCallIcePayload,
  buildCallJoinPayload,
  buildCallLeavePayload,
  buildCallSdpPayload,
  resolveSocketTransportOptions,
} from './callSocketPayloads';
import { CALL_EVENTS } from './callTypes';

function completedForm() {
  return {
    ...createInitialCallJoinForm(),
    displayName: '  Zoe  ',
    callCode: ' Calm River 42 ',
  };
}

describe('buildCallJoinPayload', () => {
  it('builds the call:join payload from the form state', () => {
    expect(buildCallJoinPayload(completedForm())).toEqual({
      callId: 'calm-river-42',
      displayName: 'Zoe',
      speakLanguage: 'en',
      hearLanguage: 'en',
      captionsEnabled: true,
      voiceGender: 'female',
      audioMode: 'translated',
    });
  });

  it('omits the resume credentials on a fresh join', () => {
    const payload = buildCallJoinPayload(completedForm());

    expect('resumeParticipantId' in payload).toBe(false);
    expect('resumeToken' in payload).toBe(false);
  });

  it('includes resumeParticipantId and resumeToken when resuming', () => {
    const payload = buildCallJoinPayload(completedForm(), {
      participantId: 'participant-a',
      resumeToken: 'token-1',
    });

    expect(payload.resumeParticipantId).toBe('participant-a');
    expect(payload.resumeToken).toBe('token-1');
  });

  it('sends nothing about identity when nobody is signed in', () => {
    // Which is most joins. A personal voice is optional and a call never
    // requires one.
    const payload = buildCallJoinPayload(completedForm(), undefined, null);

    expect('sessionToken' in payload).toBe(false);
  });

  it('carries the session token on both join and resume', () => {
    // Resume matters as much as join: a reconnect that dropped the token would
    // silently move the speaker back to a standard voice mid-call.
    const token = 'header.signature';

    expect(buildCallJoinPayload(completedForm(), undefined, token).sessionToken).toBe(token);
    expect(
      buildCallJoinPayload(
        completedForm(),
        { participantId: 'participant-a', resumeToken: 'token-1' },
        token,
      ).sessionToken,
    ).toBe(token);
  });

  it('has NO field for asserting an account, signed in or not', () => {
    // The closure. A client that can name an account can name somebody else's
    // and be spoken in their voice, so the join contract offers evidence and
    // no way to state a conclusion. This is a structural guarantee, not a
    // convention: if the field returns, this fails.
    const anonymous = buildCallJoinPayload(completedForm(), undefined, null);
    const signedIn = buildCallJoinPayload(completedForm(), undefined, 'header.signature');

    for (const payload of [anonymous, signedIn]) {
      expect('voiceOwnerId' in payload).toBe(false);
      expect('accountId' in payload).toBe(false);
      expect(JSON.stringify(payload)).not.toContain('acct_');
    }
  });

  it('carries the hear language that followed the speak language', () => {
    const form = withSpeakLanguage(completedForm(), 'es');
    const payload = buildCallJoinPayload(form);

    expect(payload.speakLanguage).toBe('es');
    expect(payload.hearLanguage).toBe('es');
  });
});

describe('W5 creator intent on the join payload', () => {
  it('includes callType and callMode when the entry flow provides them', () => {
    const payload = buildCallJoinPayload(completedForm(), undefined, null, {
      callType: 'personal',
      callMode: 'normal',
    });

    expect(payload.callType).toBe('personal');
    expect(payload.callMode).toBe('normal');
  });

  it('omits both fields entirely when no intent is given', () => {
    const payload = buildCallJoinPayload(completedForm());

    expect('callType' in payload).toBe(false);
    expect('callMode' in payload).toBe(false);
  });

  it('sends intent alongside resume credentials unchanged; the existing call ignores it', () => {
    const payload = buildCallJoinPayload(
      completedForm(),
      { participantId: 'p1', resumeToken: 'secret-resume-1' },
      null,
      { callType: 'conference', callMode: 'translated' },
    );

    expect(payload.callType).toBe('conference');
    expect(payload.resumeParticipantId).toBe('p1');
  });
});

describe('signalling payload builders', () => {
  it('builds the leave payload', () => {
    expect(buildCallLeavePayload('calm-river-42', 'participant-a')).toEqual({
      callId: 'calm-river-42',
      participantId: 'participant-a',
    });
  });

  it('builds an sdp payload for the publish and receive offers', () => {
    expect(buildCallSdpPayload('calm-river-42', 'participant-a', 'v=0')).toEqual({
      callId: 'calm-river-42',
      participantId: 'participant-a',
      sdp: 'v=0',
    });
  });

  it('builds trickle ice payloads including end-of-candidates', () => {
    const candidate = { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 };

    expect(buildCallIcePayload('calm-river-42', 'participant-a', candidate)).toEqual({
      callId: 'calm-river-42',
      participantId: 'participant-a',
      candidate,
    });
    expect(buildCallIcePayload('calm-river-42', 'participant-a', null).candidate).toBeNull();
  });
});

describe('resolveSocketTransportOptions', () => {
  it('pins polling without upgrade when requested', () => {
    expect(resolveSocketTransportOptions('polling')).toEqual({
      transports: ['polling'],
      upgrade: false,
    });
  });

  it('uses the default transports otherwise', () => {
    expect(resolveSocketTransportOptions(undefined)).toEqual({});
    expect(resolveSocketTransportOptions('websocket')).toEqual({});
  });
});

describe('call socket contract', () => {
  it('matches the P6.1B call:* event names exactly', () => {
    expect(CALL_EVENTS).toEqual({
      JOIN: 'call:join',
      LEAVE: 'call:leave',
      END: 'call:end',
      ENDED: 'call:ended',
      PUBLISH_OFFER: 'call:publish:offer',
      PUBLISH_ICE: 'call:publish:ice',
      RECEIVE_OFFER: 'call:receive:offer',
      RECEIVE_ICE: 'call:receive:ice',
      // P6.4-W2: which remote speaker each receive slot carries. Addressed to
      // the one listener it describes, never broadcast.
      RECEIVE_TRACKS: 'call:receive:tracks',
      SET_CAPTION_LANGUAGE: 'call:caption-language',
      // P6.3 acoustic instrumentation. Both are client-to-gateway REPORTS with
      // no ack and no consequence for routing: one records what the browser
      // granted, the other records when this participant's own loudspeaker was
      // audible. Neither carries audio.
      CAPTURE_SETTINGS: 'call:capture-settings',
      PLAYBACK: 'call:playback',
      STATE: 'call:state',
      CAPTION: 'call:caption',
      GENERATED_AUDIO: 'call:generated-audio',
      TRANSLATED_AUDIO_FRAME: 'call:translated-audio-frame',
      ERROR: 'call:error',
      // W5: call-global mode change, owner authority only.
      SET_MODE: 'call:mode:set',
      // W5.1: a listener's own mid-call Audio Mode — planning authority,
      // because the TTS planner reads it live.
      SET_AUDIO_MODE: 'call:audio-mode:set',
      // Owner-only transcript-download policy.
      SET_TRANSCRIPT_POLICY: 'call:transcript-policy:set',
      GOVERNANCE: 'call:governance',
      // V1: P2P video mesh signalling, relayed peer-to-peer by the gateway.
      // Video never touches STT/media-ingest.
      VIDEO_OFFER: 'call:video:offer',
      VIDEO_ANSWER: 'call:video:answer',
      VIDEO_ICE: 'call:video:ice',
    });
  });
});

describe('buildCallAudioModePayload', () => {
  it('names the participant whose preference moves, so the gateway can refuse anyone else', () => {
    expect(buildCallAudioModePayload('demo', 'participant_3', 'original')).toEqual({
      callId: 'demo',
      participantId: 'participant_3',
      audioMode: 'original',
    });
  });
});

describe('buildCallCaptionLanguagePayload', () => {
  it('names the participant whose captions move, so the gateway can refuse anyone else', () => {
    expect(buildCallCaptionLanguagePayload('demo', 'participant_1', 'fr')).toEqual({
      callId: 'demo',
      participantId: 'participant_1',
      hearLanguage: 'fr',
    });
  });
});
