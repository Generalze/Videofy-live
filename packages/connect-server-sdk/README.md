# @videofy/server-sdk

Typed server-side SDK for the Videofy Connect v1 API: create calls, mint
single-use join tokens, and manage call state from your backend.

- **Zero runtime dependencies** — uses the global `fetch` built into Node 18+.
- **Contract-validated** — every request is checked before it is sent and every
  response is checked before it reaches your code.
- **Credential-safe** — the API key travels only in the `Authorization` header,
  is never logged, and is redacted from every error the SDK throws.

## Quick start

```js
import { createVideofyConnect } from '@videofy/server-sdk';

const videofy = createVideofyConnect({
  apiKey: process.env.VIDEOFY_API_KEY,
  baseUrl: 'https://connect.example.com',
});

const call = await videofy.calls.create(
  { type: 'personal', mode: 'translated' },
  { idempotencyKey: 'order-8291-call' },
);

const grant = await videofy.joinTokens.create(call.callId, {
  participant: {
    subject: 'customer_8291',
    displayName: 'Ada',
    speakLanguage: 'en',
    hearLanguage: 'es',
  },
  expiresInSeconds: 300, // 1..900, default 300
});
// Hand grant.token to your web client unmodified; it is single-use and short-lived.
```

## API

| Method | HTTP | Purpose |
| --- | --- | --- |
| `calls.create(input, options?)` | `POST /v1/calls` | Create a call (`type`, `mode`, optional `metadata` up to 1 KB) |
| `calls.retrieve(callId)` | `GET /v1/calls/:id` | Fetch a call resource |
| `calls.state(callId)` | `GET /v1/calls/:id/state` | Live participant roster |
| `calls.setMode(callId, mode)` | `PATCH /v1/calls/:id` | Project-authority mode change |
| `calls.end(callId, options?)` | `POST /v1/calls/:id/end` | Project-authority end |
| `joinTokens.create(callId, input, options?)` | `POST /v1/calls/:id/join-tokens` | Mint a single-use join token |
| `capabilities()` | `GET /v1/capabilities` | Languages, limits, and feature flags |

`options.idempotencyKey` is available on every POST and is sent as the
`Idempotency-Key` header: replaying the same key with the same body returns the
original result; the same key with a different body is refused.

Personal calls hold 2 participants and conferences hold 4, and today's
languages are `en`, `es` and `fr` — development-demo scale. Read all of
them from `capabilities()` at runtime rather than hard-coding them.

## Errors

Every failure is typed:

- `VideofyApiError` — the server refused the request. Carries `code` (the
  Connect error taxonomy), `message`, `requestId` (quote it when reporting a
  problem), `retryable` (server-stated: back off and retry the same request),
  and `status`.
- `VideofyContractError` — the server answered outside the v1 contract
  (unexpected shape, invalid JSON). Carries `status`, `requestId` when the
  server sent one, and schema `issues`.
- `VideofyInputError` — the request was refused locally before any network
  traffic (invalid input, out-of-range token TTL, malformed call id). Carries
  field-level `issues`.

```js
import { VideofyApiError } from '@videofy/server-sdk';

try {
  await videofy.joinTokens.create(callId, { participant });
} catch (error) {
  if (error instanceof VideofyApiError && error.code === 'CALL_ENDED') {
    // create a fresh call instead
  }
}
```

## Join tokens

A join token is a short-lived (max 900 s), single-use credential. If a claimed
token fails downstream it is burned — mint a fresh one rather than retrying it.
A gateway restart voids outstanding tokens and live calls; treat
`CALL_NOT_FOUND` after a restart as "create a new call".

## Requirements

Node.js 18 or newer (global `fetch`). Alternatively inject any compatible
`fetch` via `createVideofyConnect({ fetch })` — useful for tests and custom
transports.

## Documentation

The full developer documentation — quickstart, worked examples, the
authentication model, limits and idempotency, the error reference, and the
OpenAPI description — lives in `docs/connect/` of the Videofy repository.
