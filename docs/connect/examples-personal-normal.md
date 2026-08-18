# Example: personal call, normal mode

A plain 1:1 call — two people, one shared language, no translation. This is
the smallest possible integration, and the base the translated examples build
on.

In `normal` mode everyone hears everyone's original voice; translation,
captions and transcripts are inactive. You can switch the same call to
`translated` later without rejoining (shown at the end).

## Server

```js
import { createVideofyConnect } from '@videofy/server-sdk';

const videofy = createVideofyConnect({
  apiKey: process.env.VIDEOFY_API_KEY,
  baseUrl: 'http://localhost:3001',
});

const call = await videofy.calls.create(
  { type: 'personal', mode: 'normal', metadata: { ticketId: 'T-1042' } },
  { idempotencyKey: 'ticket-T-1042-call' },   // safe to retry on a flaky network
);

// One token per person. subject is YOUR stable id for them.
async function mintFor(subject, displayName) {
  const grant = await videofy.joinTokens.create(call.callId, {
    participant: {
      subject,
      displayName,
      speakLanguage: 'en',
      hearLanguage: 'en',
    },
  });
  return grant.token;   // single-use, expires in 300 s by default
}

const agentToken = await mintFor('agent_7', 'Sam');
const customerToken = await mintFor('customer_8291', 'Ada');
```

Languages are still required in `normal` mode — they describe the
participant, and they take effect the moment the call switches to
`translated`.

## Browser

```js
import { createVideofyClient } from '@videofy/connect';

const client = createVideofyClient({
  baseUrl: 'http://localhost:3001',
  // iceServers: [{ urls: 'stun:stun.example.com' }],   // optional STUN/TURN
});

const call = await client.join({
  token,                                   // from YOUR server
  media: { microphone: true, camera: true },
});

// Self-preview and the remote participant's video:
const snapshot = call.getSnapshot();
call.attachVideo(snapshot.self.participantId, document.querySelector('#me'));

call.on('participantJoined', (participant) => {
  call.attachVideo(participant.participantId, document.querySelector('#them'));
});
call.on('participantLeft', (participant) => {
  call.detachVideo(participant.participantId);
});

// Browsers gate audio behind a user gesture:
call.on('audioBlocked', () => showEnableAudioButton(() => call.enableAudio()));

// Camera and microphone toggles. OFF releases the camera — the light goes out.
muteButton.onclick = () => call.setMicrophone(false);
cameraButton.onclick = () => call.setCamera(false);

// Done:
hangUpButton.onclick = () => call.leave();
```

Notes:

- `snapshot.participants` holds the **other** participants only; you are
  `snapshot.self`. In a personal call there is at most one entry.
- `participantId` is the identity Videofy mints for this participation;
  `subject` is yours. Both appear on every participant. See
  [Authentication & security](auth-security.md#subjects-and-participants).
- A second join for a `subject` that is already connected is refused
  (`SUBJECT_ALREADY_ACTIVE`); a personal call with both seats taken refuses
  further joins with `CALL_FULL`.

## Switching the call to translated

Either side of the API can flip the mode mid-call:

```js
// Your server (project authority):
await videofy.calls.setMode(call.callId, 'translated');
```

```js
// Or the owner seat in the browser — the participant whose join created the
// call's first seat. Anyone else is refused with OWNER_REQUIRED.
await call.setCallMode('translated');
```

Every participant sees `callModeChanged` fire and the snapshot's `call.mode`
change; from that moment the translated-call behavior in the
[next example](examples-personal-translated.md) applies.
