# Example: personal call, translated

The flagship scenario: a 1:1 call across a language barrier. An
English-speaking support agent and a Spanish-speaking customer each hear the
other in their own language, with live captions and a transcript to keep.

## Server

```js
import { createVideofyConnect } from '@videofy/server-sdk';

const videofy = createVideofyConnect({
  apiKey: process.env.VIDEOFY_API_KEY,
  baseUrl: 'http://localhost:3001',
});

const call = await videofy.calls.create({ type: 'personal', mode: 'translated' });

const agent = await videofy.joinTokens.create(call.callId, {
  participant: {
    subject: 'agent_7',
    displayName: 'Sam',
    speakLanguage: 'en',
    hearLanguage: 'en',
    voiceGender: 'male',        // the generated voice used for Sam's translations
  },
});

const customer = await videofy.joinTokens.create(call.callId, {
  participant: {
    subject: 'customer_8291',
    displayName: 'Ada',
    speakLanguage: 'es',
    hearLanguage: 'es',
    // audioMode: 'translated'  (default)
    // captionsEnabled: true    (default)
    // voiceGender: 'female'    (default)
  },
  expiresInSeconds: 600,        // 1..900; default 300
});
```

The response echoes the participant with **every default resolved**, so what
you log is exactly what the token grants. Supported languages come from
[`GET /v1/capabilities`](capabilities.md) — a well-formed but unsupported tag
is refused with `INVALID_LANGUAGE`.

## Browser: hearing the other side

```js
import { createVideofyClient } from '@videofy/connect';

const client = createVideofyClient({ baseUrl: 'http://localhost:3001' });
const call = await client.join({ token, media: { microphone: true } });

call.on('audioBlocked', () => showEnableAudioButton(() => call.enableAudio()));
```

Three **audio modes** decide how this listener hears cross-language
speakers. The choice is local — it never affects what anyone else hears:

```js
call.setAudioMode('translated');      // their translated voice replaces the original (default)
call.setAudioMode('interpretation');  // original held quietly under the translation
call.setAudioMode('original');        // original voice only, untranslated
```

Each remote participant's snapshot entry reports the result as
`deliveryState: 'translated' | 'reduced' | 'original'` — what you are
actually hearing right now, including the moments translation is still
catching up. Same-language speakers are always `original`.

```js
call.on('participantUpdated', (participant) => {
  badgeFor(participant.participantId).textContent = participant.deliveryState;
});
```

## Changing language mid-call

```js
await call.setHearLanguage('fr');
```

The promise resolves when the change is accepted; the snapshot's
`self.hearLanguage` updates when the call state broadcasts it. From then on
translations and captions for this listener arrive in French.

## Captions

```js
call.setCaptions(true);   // this listener's preference

call.on('caption', (caption) => {
  // captionId is stable while a line grows: replace, do not append,
  // until final === true.
  upsertCaptionLine(caption.captionId,
    `${caption.displayName}: ${caption.text}`, caption.final);
});
```

Captions arrive in the listener's hear-language. The snapshot also carries a
bounded ring of recent captions (`snapshot.captions`, oldest first) so a UI
that mounts late can backfill.

## Transcript download

```js
function downloadTranscript() {
  try {
    const text = call.getTranscript();   // the final transcript so far, printable text
    const blob = new Blob([text], { type: 'text/plain' });
    const link = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: 'call-transcript.txt',
    });
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (error) {
    // UNSUPPORTED_CAPABILITY: transcript download is disabled for this call.
    hideTranscriptButton();
  }
}
```

## If translation falters

`TRANSLATION_UNAVAILABLE` and `GENERATED_AUDIO_UNAVAILABLE` are **retryable**
conditions, not verdicts: the service keeps trying, and meanwhile the
listener hears the speaker's original voice — `deliveryState` tells the
truth throughout. Keep the call up; there is usually nothing to do but show
the state. See [Errors](errors.md).
