import { describe, expect, it } from 'vitest';
import { createInitialCallJoinForm, withSpeakLanguage } from './callFormState';
import {
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

  it('carries the hear language that followed the speak language', () => {
    const form = withSpeakLanguage(completedForm(), 'es');
    const payload = buildCallJoinPayload(form);

    expect(payload.speakLanguage).toBe('es');
    expect(payload.hearLanguage).toBe('es');
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
      PUBLISH_OFFER: 'call:publish:offer',
      PUBLISH_ICE: 'call:publish:ice',
      RECEIVE_OFFER: 'call:receive:offer',
      RECEIVE_ICE: 'call:receive:ice',
      STATE: 'call:state',
      CAPTION: 'call:caption',
      GENERATED_AUDIO: 'call:generated-audio',
      ERROR: 'call:error',
    });
  });
});
