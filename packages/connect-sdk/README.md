# @videofy/connect

The browser SDK for **Videofy Connect**: put live translated calls in your own
product. Your server creates a call and mints a single-use join token through
the Connect REST API (`@videofy/server-sdk`); your web client hands that token
to this SDK and receives a live call object.

```ts
import { createVideofyClient } from '@videofy/connect';

const client = createVideofyClient({ baseUrl: 'https://gateway.example.com' });

// `token` came from YOUR server, which minted it via the Connect API.
const call = await client.join({ token, media: { microphone: true } });

call.on('state', (snapshot) => render(snapshot));
call.on('caption', (caption) => showCaption(caption));
call.on('audioBlocked', () => showEnableAudioButton());   // call.enableAudio() inside a tap
call.on('needsNewJoinToken', () => askYourServerForANewToken());

call.attachVideo(participantId, videoElement);
// ... later
call.leave();
```

## The state model

`getSnapshot()` returns an immutable `CallSnapshot`; a fresh one accompanies
every `state` event. Each remote participant carries a `deliveryState`
describing how you currently hear them: `original` (their own voice),
`translated` (their translated voice replaces it) or `reduced` (their voice
held quietly underneath a live interpretation).

Events: `state`, `participantJoined`, `participantLeft`, `participantUpdated`,
`callModeChanged`, `caption`, `connectionChanged`, `audioBlocked`,
`needsNewJoinToken`, `error`.

## Choosing what you hear

Three audio modes decide how you hear cross-language speakers — a local
choice that never affects anyone else's ears: `setAudioMode('translated')`
(their translated voice, the default), `'interpretation'` (their original
held quietly under the translation) or `'original'`. `setHearLanguage('fr')`
switches your language mid-call; `setCaptions(true)` turns on live captions
(delivered as `caption` events in your hear-language); `getTranscript()`
returns the printable transcript so far.

## Tokens are single-use

A join token admits one person to one call once. When the SDK emits
`needsNewJoinToken` the credential in hand is finished — after a reaped seat
or a service restart no retry can succeed; your server must mint a fresh
token before that person can join again.

## Reconnection

Network drops, tab suspensions and pocketed phones are handled inside the
SDK: it resumes the same seat automatically and reports progress through
`connectionChanged` (`reconnecting`, `restoring`, `suspended`, back to
`connected`). `leave()` surrenders the seat deliberately; `dispose()` only
releases resources (the seat can still be resumed within the grace window).

## Audio autoplay

Browsers require a user gesture before audio can play. Listen for
`audioBlocked` and call `enableAudio()` from inside a tap or click — it
unlocks both translated voices and the other participants' original voices.

## Errors

`join()` and every rejecting method throw `VideofyConnectError`: a `code`
from the Connect error taxonomy plus `retryable` (whether the same attempt
may succeed later). Mid-call conditions arrive as `error` events carrying
the same `{ code, message, retryable }` shape.

## Documentation

The full developer documentation — quickstart, worked examples, the
authentication model, lifecycle and reconnection, and the error reference —
lives in `docs/connect/` of the Videofy repository.
