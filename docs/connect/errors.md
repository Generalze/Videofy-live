# Errors

Every failure in Connect — REST or SDK — speaks one vocabulary: **24 codes,
each with exactly one classification**, so "what should my code do" is
mechanical, never archaeology.

## The envelope

Every `/v1` error response has this exact shape:

```json
{
  "error": {
    "code": "CALL_ENDED",
    "message": "This call has ended.",
    "requestId": "req_1f3a9c2b7d5e4a01",
    "retryable": false
  }
}
```

`retryable` is derived from the code's classification — the two can never
disagree. `requestId` also travels on the `X-Request-Id` response header
(every response, success included); quote it when reporting a problem.

The same codes surface in the SDKs: `VideofyApiError.code` in
`@videofy/server-sdk`; `VideofyConnectError.code` and `error`-event payloads
in `@videofy/connect`.

## The three classifications

| Classification | Meaning | Mechanical response |
| --- | --- | --- |
| **retryable** | The same request may succeed later | Back off and retry |
| **terminal** | Retrying the same request can never succeed | Obtain new state first: a fresh token, a new call, a different mode |
| **user-action** | Only the end user can unblock it | Ask them: grant the permission, plug in a device, pick another name |

## All 24 codes

### Credentials and authorization — all terminal

| Code | HTTP | You see it when | What to do |
| --- | --- | --- | --- |
| `AUTH_INVALID_KEY` | 401 | The API key is missing, malformed, or unknown | Check `Authorization: Bearer vfk_...` and the key itself |
| `AUTH_INVALID_TOKEN` | — | The join token is malformed or fails verification | Mint a fresh token; make sure it reached the browser unmodified |
| `AUTH_EXPIRED_TOKEN` | — | The join token's `expiresAt` has passed | Mint a fresh token; mint closer to the moment of joining |
| `AUTH_TOKEN_USED` | — | The single-use token was already claimed | Mint a fresh token — one token per join attempt, always |
| `FORBIDDEN_PROJECT` | 403 | The project is deactivated (or a token's project is unknown) | Check provisioning; contact the gateway operator |
| `FORBIDDEN_ORIGIN` | — | The browser's origin is not on the project's allowed list | Add the origin at provisioning; then mint a fresh token (the refused one is burned) |

### Call state — all terminal

| Code | HTTP | You see it when | What to do |
| --- | --- | --- | --- |
| `CALL_NOT_FOUND` | 404 | No such call for *this* project — unknown id, another project's call, or any call after a gateway restart | Create a new call; after a restart, mint fresh tokens too |
| `CALL_FULL` | — | All seats are taken (personal 2, conference 4) | Do not retry; tell the user the room is full |
| `CALL_ENDED` | 410 | The call is over — mint, mode change, or join against it | Create a new call for new conversations |
| `SUBJECT_ALREADY_ACTIVE` | — | This `subject` already has a connected seat in the call | Close the other session, or let the user continue there |
| `OWNER_REQUIRED` | — | `setCallMode` from a non-owner seat | Use the owner seat, or change mode from your server |
| `INVALID_MODE` | 400 | The requested call mode is not available (on `/v1`, a non-enum mode is refused earlier as `INVALID_REQUEST`) | Send `normal` or `translated` |

### Requests — all terminal

| Code | HTTP | You see it when | What to do |
| --- | --- | --- | --- |
| `INVALID_LANGUAGE` | 400 | A language outside the supported set (well-formed or not) | Offer only languages from `GET /v1/capabilities` |
| `INVALID_REQUEST` | 400/404 | A body that fails validation — including **unknown keys** (strict schemas catch typos on the first request) — or an unknown `/v1` path | Fix the request; compare against the [OpenAPI description](openapi.md) |
| `IDEMPOTENCY_CONFLICT` | 409 | An `Idempotency-Key` reused with a *different* body | New request, new key; same retry, same body |
| `UNSUPPORTED_CAPABILITY` | 503 | Connect is not enabled on the gateway (all of `/v1`) or token minting is unconfigured; also transcript download disabled, in the client | Not code-fixable: configure/enable the capability, or hide the feature |

### User's device and choices — user-action

| Code | You see it when | What to do |
| --- | --- | --- |
| `DISPLAY_NAME_TAKEN` | Another participant already uses this display name | Mint a fresh token with a different `displayName` |
| `MEDIA_PERMISSION_DENIED` | The user denied microphone or camera permission | Explain why the call needs it; let them re-grant and retry |
| `MEDIA_UNAVAILABLE` | No usable microphone/camera on the device | Ask the user to connect or select a device |

### Transient conditions — retryable

| Code | HTTP | You see it when | What to do |
| --- | --- | --- | --- |
| `CONNECTION_LOST` | — | The connection to the service dropped | The client SDK reconnects on its own; show progress |
| `TRANSLATION_UNAVAILABLE` | — | Translation is temporarily out | Nothing — listeners hear original voices; `deliveryState` reports it |
| `GENERATED_AUDIO_UNAVAILABLE` | — | Translated speech synthesis is temporarily out | Same as above; captions may still flow |
| `RATE_LIMITED` | 429 | The project's request budget is spent | Honor `Retry-After`; see [Limits](limits.md) |
| `INTERNAL` | 500 | Something failed on the service side | Retry with backoff; report the `requestId` if it persists |

Codes without an HTTP status are seen at join time or mid-call through the
client SDK rather than as REST responses.

## Handling patterns

Server (`@videofy/server-sdk`) — branch on class first, code second:

```js
import { VideofyApiError } from '@videofy/server-sdk';

try {
  await videofy.joinTokens.create(callId, { participant });
} catch (error) {
  if (error instanceof VideofyApiError) {
    if (error.retryable) return scheduleRetry();          // RATE_LIMITED, INTERNAL, …
    if (error.code === 'CALL_ENDED') return startNewCall();
    log('connect refusal', error.code, error.requestId);  // terminal: fix state, not the request
  }
  throw error;
}
```

Client (`@videofy/connect`) — the same taxonomy, as exceptions and events:

```js
try {
  await client.join({ token });
} catch (error) {
  // error.code / error.retryable, e.g. AUTH_TOKEN_USED → fetch a fresh token
}

call.on('error', ({ code, message, retryable }) => {
  // Mid-call conditions, e.g. TRANSLATION_UNAVAILABLE (retryable: true)
});
```
