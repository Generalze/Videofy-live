# Capabilities

Two discovery surfaces tell your code what is available *right now*, so
nothing about languages, sizes, or features needs hard-coding: one on the
API for your server, one on the client snapshot for your UI.

## `GET /v1/capabilities`

Authenticated like every `/v1` endpoint. The response is exactly:

```json
{
  "languages": ["en", "es", "fr"],
  "limits": {
    "personalParticipants": 2,
    "conferenceParticipants": 4
  },
  "features": {
    "personalCall": true,
    "conference": true,
    "video": true,
    "translatedCalls": true,
    "personalVoice": false
  }
}
```

Via the server SDK:

```js
const caps = await videofy.capabilities();

// Populate your language picker from the platform, not a constant:
renderLanguageOptions(caps.languages);

// Gate room size by call type:
const seats = type === 'conference'
  ? caps.limits.conferenceParticipants
  : caps.limits.personalParticipants;
```

Field by field:

- **`languages`** — the BCP-47 tags you may use for `speakLanguage` and
  `hearLanguage`, today `en`, `es`, `fr`. A well-formed tag outside this
  list is refused with `INVALID_LANGUAGE` when minting a token.
- **`limits`** — seat counts by call type: personal **2**, conference **4**.
  A join beyond the limit answers `CALL_FULL`.
- **`features`** — coarse feature flags. All are real today except
  **`personalVoice`, which is reserved and unavailable** (`false`): build no
  UI on it until it turns true in a future release.

### Evolution is additive-only

This shape only ever grows — new languages, new feature flags, higher
limits. Nothing is removed or renamed within v1, and no provider, model, or
internal detail will ever appear here. Read defensively anyway: ignore keys
you do not recognize rather than failing on them.

## The client-side capability: audio output

Browsers differ in whether audio can be routed to a *chosen* output device
(headset vs speakers). The snapshot states which world you are in:

```js
const snapshot = call.getSnapshot();
snapshot.capabilities.audioOutput;   // 'selectable' | 'system-only'
```

Build the device picker only when selection is possible:

```js
const { audioOutput, outputs } = await call.getAudioOutputCapabilities();

if (audioOutput === 'selectable') {
  // outputs: [{ deviceId, label }] — labels may be empty until the user
  // has granted microphone permission.
  showOutputPicker(outputs, async (deviceId) => {
    await call.setAudioOutput(deviceId);   // null returns to the system default
  });
} else {
  // 'system-only' (Firefox, iOS Safari, …): the OS decides. Hide the picker;
  // audio still plays on the system default device.
  hideOutputPicker();
}
```

## Graceful degradation, as a habit

- **Ask, then render.** Feature-gate UI on `capabilities()` and
  `snapshot.capabilities`, not on user-agent sniffing or constants.
- **Absence degrades, never breaks.** `system-only` audio output means no
  picker, not no audio. An unsupported language is a refused *token mint*
  (`INVALID_LANGUAGE` at your server), never a broken call.
- **Transient outages are states, not errors to act on.**
  `TRANSLATION_UNAVAILABLE` and `GENERATED_AUDIO_UNAVAILABLE` are retryable;
  the listener hears original voices in the meantime and each participant's
  `deliveryState` tells you what is actually reaching the ears.
- **Read unions as open.** New enum members and new capability keys may
  arrive; unknown values you merely display are safe to show, unknown values
  you branch on belong in a default arm.
