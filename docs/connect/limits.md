# Limits, rate limits & idempotency

Everything bounded in Connect v1, on one page. All figures are the
development-demo defaults; none are configurable per request.

## Call and participant limits

| Limit | Value | On breach |
| --- | --- | --- |
| Personal call seats | **2** | `CALL_FULL` |
| Conference seats | **4** | `CALL_FULL` |
| Languages | `en`, `es`, `fr` (read from [capabilities](capabilities.md)) | `INVALID_LANGUAGE` |
| Connected seats per `subject` per call | 1 | `SUBJECT_ALREADY_ACTIVE` |

A recently dropped seat keeps counting against the seat limit until its
recovery window lapses — a rejoin into a full room can briefly answer
`CALL_FULL`.

## Request field bounds

| Field | Bound | Notes |
| --- | --- | --- |
| `metadata` (call creation) | ≤ **1024 bytes** of serialized UTF-8 JSON | Opaque to Videofy, echoed back verbatim; the cap is on bytes, not characters |
| `displayName` | 1–**80** characters | Surrounding whitespace is trimmed before the length check |
| `subject` | 1–**128** characters | Opaque; never interpreted |
| Language tags | BCP-47 shape, ≤ 35 characters | Shape-checked in the contract; membership checked against capabilities |

Request bodies are validated **strictly**: an unknown key is refused with
`INVALID_REQUEST`, so a typo surfaces on the first request instead of being
silently ignored.

## Join-token TTL

| | Value |
| --- | --- |
| Default `expiresInSeconds` | **300** |
| Minimum | 1 |
| Maximum | **900** — refused above, never clamped |

`@videofy/server-sdk` refuses out-of-range or non-integer TTLs locally,
before any network traffic. Mint tokens close to the moment of joining;
a token is also spent on first use regardless of remaining lifetime (see
[the join-token lifecycle](auth-security.md#the-join-token-lifecycle)).

## Rate limits

`/v1` applies a **token bucket per project**: capacity **30** requests,
refilling at **10 per second**. Short bursts up to 30 pass; sustained load
above 10 requests/second starts refusing with `429 RATE_LIMITED`.

Response headers tell your client where it stands:

| Header | On | Meaning |
| --- | --- | --- |
| `RateLimit-Limit` | every `/v1` response | The bucket capacity (30) |
| `RateLimit-Remaining` | every `/v1` response | Whole requests left right now |
| `Retry-After` | 429 responses | Seconds to wait before retrying |

`RATE_LIMITED` is retryable by definition — honor `Retry-After` rather than
hammering. The bucket is per *project*, so all your servers share it.

## Idempotency

Every `/v1` **POST** — create call, mint join token, end call — accepts an
`Idempotency-Key` header (in the server SDK: `{ idempotencyKey }` in the
options argument). Use it to make network retries safe:

```js
const call = await videofy.calls.create(
  { type: 'personal', mode: 'translated' },
  { idempotencyKey: `order-${orderId}-call` },
);
// A timeout here? Send the identical request with the identical key:
// you get the ORIGINAL response back, not a second call.
```

The rules:

- **Same key + same body** → the stored original response is replayed, same
  status and body. No duplicate call, token, or end happens.
- **Same key + different body** → refused with `409 IDEMPOTENCY_CONFLICT`.
  A new request needs a new key.
- Replay window: **10 minutes** per key. Keys are up to 255 characters and
  scoped to your project.
- Failed attempts with 4xx outcomes are replayed like successes (the refusal
  is the outcome); **5xx outcomes are never stored** — a retry after an
  `INTERNAL` error gets a fresh attempt.

Choose keys that name the *business intent* (`order-8291-call`,
`meeting-142-end`), not random values per attempt — the whole point is that
a retry reuses the key.

## Where these bounds live

All request/response bounds are encoded in the
[OpenAPI description](openapi.md) and enforced by the same schemas on the
server, and `@videofy/server-sdk` checks them client-side before spending
network or rate budget.
