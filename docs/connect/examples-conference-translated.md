# Example: conference, translated

Up to **four** people in one translated call, each speaking and hearing their
own language. This example adds what conferences need over personal calls: a
roster, per-participant video tiles, and server-side control of the call.

## Server

```js
import { createVideofyConnect } from '@videofy/server-sdk';

const videofy = createVideofyConnect({
  apiKey: process.env.VIDEOFY_API_KEY,
  baseUrl: 'http://localhost:3001',
});

const call = await videofy.calls.create({
  type: 'conference',          // 4 seats
  mode: 'translated',
  metadata: { meetingId: 'standup-142' },
});

const people = [
  { subject: 'user_ana',   displayName: 'Ana',   language: 'es' },
  { subject: 'user_ben',   displayName: 'Ben',   language: 'en' },
  { subject: 'user_chloe', displayName: 'Chloé', language: 'fr' },
];

const tokens = {};
for (const person of people) {
  const grant = await videofy.joinTokens.create(call.callId, {
    participant: {
      subject: person.subject,
      displayName: person.displayName,
      speakLanguage: person.language,
      hearLanguage: person.language,
    },
  });
  tokens[person.subject] = grant.token;
}
```

### Watching the roster from your server

```js
const state = await videofy.calls.state(call.callId);
// { callId, type, mode, participants: [{ participantId, subject,
//   displayName, speakLanguage, hearLanguage, connected }] }
for (const participant of state.participants) {
  console.log(participant.subject, participant.connected ? 'in call' : 'reconnecting');
}
```

`connected: false` marks a seat whose participant dropped and may still
recover — see [Lifecycle & reconnection](lifecycle-reconnect.md).

### Server-side control

```js
// Project authority: flip the whole call's mode…
await videofy.calls.setMode(call.callId, 'normal');
await videofy.calls.setMode(call.callId, 'translated');

// …and end it for everyone. Idempotent: ending an ended call restates the outcome.
await videofy.calls.end(call.callId, { idempotencyKey: 'standup-142-end' });
```

Every participant's client sees `callModeChanged` on a mode change, and an
`ended` connection state when the call is ended.

## Browser

```js
import { createVideofyClient } from '@videofy/connect';

const client = createVideofyClient({ baseUrl: 'http://localhost:3001' });
const call = await client.join({ token, media: { microphone: true, camera: true } });

call.on('audioBlocked', () => showEnableAudioButton(() => call.enableAudio()));
```

### Video tiles from the snapshot

```js
function renderTiles(snapshot) {
  ensureTile(snapshot.self.participantId, `${snapshot.self.displayName} (you)`);
  call.attachVideo(snapshot.self.participantId, tileVideo(snapshot.self.participantId));

  for (const participant of snapshot.participants) {
    ensureTile(participant.participantId, participant.displayName);
    if (participant.video.enabled) {
      call.attachVideo(participant.participantId, tileVideo(participant.participantId));
    }
    tileBadge(participant.participantId).textContent =
      participant.connected ? participant.deliveryState : 'reconnecting…';
  }
}

call.on('state', renderTiles);
call.on('participantLeft', (participant) => {
  call.detachVideo(participant.participantId);
  removeTile(participant.participantId);
});
```

`deliveryState` is **per speaker, per listener**: Ana may hear Ben
`translated` while Chloé hears him `original` — each client's snapshot
describes its own ears.

### Captions in a many-voice room

```js
call.setCaptions(true);
call.on('caption', (caption) => {
  // One growing line per captionId; displayName says who is speaking.
  upsertCaptionLine(caption.captionId,
    `${caption.displayName}: ${caption.text}`, caption.final);
});
```

### Mode change from the owner seat

The participant whose join created the call's first seat is the in-call
owner; everyone else gets `OWNER_REQUIRED`:

```js
try {
  await call.setCallMode('normal');
} catch (error) {
  if (error.code === 'OWNER_REQUIRED') hideModeSwitch();   // not this seat's call
}
```

Your server can always change the mode regardless of seats (previous
section).

### Transcript

```js
const text = call.getTranscript();   // every finalized line so far, all speakers
```

Offer it behind a download button as in the
[personal translated example](examples-personal-translated.md#transcript-download).

## Refusals specific to fuller rooms

| Code | Meaning | Do |
| --- | --- | --- |
| `CALL_FULL` | All 4 conference seats (or 2 personal seats) are taken | Do not retry; tell the user the room is full |
| `DISPLAY_NAME_TAKEN` | Another participant already uses this display name | Mint a fresh token with a different `displayName` |
| `SUBJECT_ALREADY_ACTIVE` | This `subject` is already connected in the call | Close the other session first, or let it finish |

A seat whose participant dropped moments ago still counts against the seat
limit until its recovery window lapses, so a rejoin into a full room can
briefly answer `CALL_FULL` — mint a fresh token and retry after a short wait.
