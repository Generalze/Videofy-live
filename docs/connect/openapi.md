# OpenAPI description

The Connect v1 REST API ships as a machine-readable **OpenAPI 3.1**
document:

- **Copy for reading here:** [`docs/connect/openapi.json`](openapi.json)
- **Source of truth:** `packages/connect-contracts/openapi.json` in the
  Videofy repository — generated from the same contract schemas the server
  validates with, and drift-tested against them. If the two files ever
  differ, the package file wins; this docs copy is refreshed from it.

## What it covers

All seven endpoints, with request/response schemas, security scheme
(`Authorization: Bearer` project key), and the shared error envelope:

| Operation | Method & path |
| --- | --- |
| Create a call | `POST /v1/calls` |
| Fetch a call | `GET /v1/calls/{callId}` |
| Live participant state | `GET /v1/calls/{callId}/state` |
| Mint a join token | `POST /v1/calls/{callId}/join-tokens` |
| Change call mode | `PATCH /v1/calls/{callId}` |
| End a call | `POST /v1/calls/{callId}/end` |
| Capabilities | `GET /v1/capabilities` |

Two conventions to know when reading it:

- **Errors are modeled once.** Every operation's non-2xx outcome is the same
  `ErrorEnvelope` schema (`default` response); the code-by-code meaning
  lives in [Errors](errors.md).
- **Headers are first-class.** `X-Request-Id` (correlation, in and out) and
  `Idempotency-Key` (POST replay safety, see [Limits](limits.md)) appear as
  parameters/headers on the operations they apply to.

## Using it

- **Explore:** point Swagger UI, Redoc, or your editor's OpenAPI plugin at
  the file.
- **Generate clients:** any OpenAPI 3.1-capable generator works. For
  JavaScript/TypeScript servers, prefer [`@videofy/server-sdk`](../../packages/connect-server-sdk/README.md)
  over generated code — it adds contract validation, typed errors, local
  input refusal, and API-key redaction that a generator will not.
- **Validate in CI:** if you build your own client in another language,
  contract-test it against this document so drift surfaces in CI rather
  than in production.

The server base URL is gateway-relative (`/v1` is served by the Videofy
gateway process; the development demo listens on port 3001).
