# Contabo staging readiness — C-AI1.1F

What has to be true of the deployment before live commercial traffic touches it,
and which of those things the code now enforces rather than merely documents.

Nothing here contains a credential value. Every secret appears as a NAME.

## Topology

```
                internet
                    │  443/tcp only
              ┌─────▼─────┐
              │   Caddy   │   HTTPS + WSS terminator, publicly trusted cert
              └─────┬─────┘
                    │  127.0.0.1
          ┌─────────▼─────────┐
          │ realtime-gateway  │  public-facing service; holds no provider key
          └─────────┬─────────┘
                    │  private network / loopback ONLY
          ┌─────────▼─────────┐
          │   media-ingest    │  provider credentials live here and only here
          └───────────────────┘
```

`media-ingest` is **never** internet-exposed. It holds every commercial
credential, and it is the only process that talks to Deepgram, Google or
ElevenLabs. The gateway holds none of them, which is what makes the gateway the
process that may face the internet.

## Separate processes, and no shared disk for live audio

The two services were coupled by a filesystem until C-AI1.1E: the gateway wrote
a WAV and media-ingest read it back by path. That made them one machine by
construction. Live audio now crosses a socket, so they can be separate
processes, separate containers, or separate hosts.

**Uploaded programmes still need shared storage** and that has not changed. A
programme somebody uploaded has a complete file, is processed by the batch path,
and is served back by the generated-audio route. Its storage requirement is
independent of the live path and must be provisioned separately — removing the
live path's disk coupling did not remove this one.

## Environment names

Values are never recorded here, in the repository, in logs, or in a shell
history. Names only.

### realtime-gateway

| Name | Required | What it decides |
| --- | --- | --- |
| `MEDIA_INGEST_URL` | yes | Internal media API base. |
| `MEDIA_INGEST_REALTIME_INGRESS_URL` | for live | Realtime ingress WSS. Absent means the live path is not cut over. |
| `INTERNAL_WEBRTC_TOKEN` | yes | The shared internal credential. Same value both services. |
| `AI_RUNTIME_PROFILE` | yes | Decides what an absent ingress MEANS. See below. |

### media-ingest

| Name | Required | What it decides |
| --- | --- | --- |
| `INTERNAL_WEBRTC_TOKEN` | yes | Must match the gateway's. |
| `STREAMING_TRANSCRIPTION_PROVIDER` | for live | `off` \| `mock` \| `deepgram-nova` \| `deepgram-flux`. |
| `STREAMING_SYNTHESIS_PROVIDER` | optional | `off` \| `mock` \| `elevenlabs`. `off` means captions only. |
| `DEEPGRAM_API_KEY` | with Deepgram | Credential. |
| `DEEPGRAM_MODEL` | optional | Defaults per dialect. |
| `ELEVENLABS_API_KEY` | with ElevenLabs | Credential. |
| `ELEVENLABS_DEFAULT_VOICE_ID` | with ElevenLabs | Vendor voice for the default. |
| `ELEVENLABS_MODEL` | optional | Defaults to `eleven_flash_v2_5`. |
| `GOOGLE_TRANSLATE_PROJECT_ID` | with Google | The RESOURCE project. |
| `GOOGLE_CLOUD_QUOTA_PROJECT` | optional | The BILLING project. Absent uses the credential's own. |
| `GOOGLE_APPLICATION_CREDENTIALS` | **no** | One optional ADC source. Set it only for the service-account-JSON fallback; a WIF deployment sets nothing. See below. |
| `AZURE_SPEECH_KEY` / `AZURE_SPEECH_REGION` | with Azure | Comparator TTS only. |

### Google authentication on Contabo

**Contabo is not Google Cloud.** There is no Google compute metadata server on a
Contabo VPS, so metadata-server ADC — the mechanism that makes this effortless
on GCE, GKE and Cloud Run — is simply not available here. Stating otherwise
would send whoever sets this up looking for an identity endpoint that does not
exist on the host.

The realistic options, in order:

| Option | When | Notes |
| --- | --- | --- |
| **Workload Identity Federation** (external-account ADC) | **preferred** | No long-lived key on the box. ADC reads an external-account credential configuration; the box proves its identity to an external provider and exchanges that for short-lived Google tokens. |
| **Service-account JSON**, server-side | temporary fallback, until WIF is completed | Runtime-only, least privilege, readable by the service user alone, never committed, never in an image layer. This is the one case where `GOOGLE_APPLICATION_CREDENTIALS` is legitimately set. |
| `gcloud auth application-default login` | **development only** | A human user credential. Never on staging or production. |

`GOOGLE_APPLICATION_CREDENTIALS` remains **one optional ADC source and never a
registry requirement**. That distinction is what the C-AI1.1F auth refactor
exists for: a WIF deployment sets no such variable, and the old model would have
marked it `disabled` for lacking a file it deliberately was not using.

Authentication **fails closed**: an unverified external identity is treated as
unusable, so a Google route is refused rather than attempted when nobody has
confirmed ADC actually resolves on the box.

## Fail-closed live policy

`AI_RUNTIME_PROFILE` decides what an absent realtime ingress means:

| Profile | `call/live` | `programme/live` |
| --- | --- | --- |
| `commercial-cloud` / `commercial-local` | **REFUSED** | batch fallback, flagged **degraded** |
| `development-demo` / `videofy-native` | batch fallback, normal | batch fallback, normal |

A commercial call must never silently become a growing-window batch pipeline
because a URL was left unset. That failure looks completely healthy from the
outside and is discovered by reading a bandwidth graph a quarter later.

`programme/uploaded` never reaches this decision — it has a complete file and
takes the batch path by design, not by fallback.

## Health and readiness

Three questions that must not be collapsed into one green light, because they
have three different remedies:

| Question | Failure means | Who fixes it |
| --- | --- | --- |
| **Configuration** — are the required names set? | a deployment mistake | whoever deployed |
| **Authentication** — do credentials/ADC actually resolve? | a credential or IAM problem | whoever owns the cloud account |
| **Provider health** — is the vendor answering? | an outage | nobody here; wait or fail over |

`resolveOperationalState` answers the first two and names which. Provider health
is the third axis in `ProviderRuntimeHealth` and is deliberately independent of
integration stage: an outage does not un-write an adapter.

## Secrets discipline

- Provider credentials are **runtime-only**: process environment, never an image
  layer, never a repository file, never a log line.
- The registry stores env var **names**; a regex on the schema rejects anything
  that looks like a value pasted into the wrong field.
- `resolveOperationalState` takes a presence **predicate**, not the environment,
  so no credential value can pass through that module even by accident.
- Failure messages carry the vendor's response body, which is deliberate and
  safe: those bodies name disabled APIs and missing quota projects, not secrets.

## Public ingress

Primary ingress is HTTPS/WSS through Caddy with a publicly trusted certificate.
Cloudflare is proxied (orange-cloud) with SSL mode **Full (strict)** — never
Flexible. The realtime ingress path is internal and must not be exposed through
the reverse proxy.

## What this does NOT establish

Staging readiness is a property of the deployment, not evidence about providers.
No provider is certified by anything in this document, and the external
validations listed in the C-AI1.1F report remain deferred.

---

## As deployed — Staging #1 (2026-08-22)

Host `c7-eu-01`, Ubuntu 24.04, 8 vCPU / 24 GB / 435 GB. Public name
`staging.consummate7.com`, publicly trusted certificate issued by Let's Encrypt
over HTTP-01 while the record is grey-clouded.

### Path map

One origin, because the SPAs and the APIs share a certificate and a socket.

| Path | Upstream | Notes |
| --- | --- | --- |
| `/` | static `call-web` | |
| `/listen/`, `/operator/` | static SPAs | built with a matching Vite `--base` |
| `/socket.io/*` | realtime-gateway | the WebSocket upgrade |
| `/health` | realtime-gateway | |
| `/auth/*` | account | prefix-stripped |
| `/media/*` | media-ingest | prefix-stripped, `/internal/*` refused |
| `/internal/*` | **refused, 404** | covers the internal API AND the ingress WS |

`account` and `media-ingest` both define `/sessions`. Without distinct prefixes
one silently shadows the other, and the symptom surfaces in whichever product
surface is exercised second.

### What Staging #1 established, and what it did not

Proven against the deployed box: TLS, the WebSocket upgrade, the private-port
policy (3001/3002/3006 unreachable from the internet), two-participant
two-language call establishment, roster broadcast, resume-credential reconnect,
unattended restart after reboot, and graceful SIGTERM.

NOT established: audible translated speech, and no commercial provider was
called. Providers are unchanged — Deepgram, Google, ElevenLabs and Azure
`integrated` (Azure on TTS only), 9jaLingo `configured`, nothing certified.

### The commercial profile cannot start yet, and this is deliberate

Setting `AI_RUNTIME_PROFILE=commercial-cloud` makes media-ingest **refuse to
start**, reporting that no provider is eligible as primary at stage `certified`
or better. That is fail-closed working exactly as intended, and it is stricter
than "a credential is missing": the gate is the INTEGRATION STAGE, not the key.

So turning the commercial route on in staging needs two separate things, and
they are not interchangeable:

1. the owner's vendor credentials on the box, and
2. a deliberate decision about the certification gate — because certification
   requires evidence nobody has gathered yet, and every current observation is
   `sampleCount: 1`.

Running commercial traffic today would mean weakening that gate. That is a
product decision, not a deployment step, and it should be made explicitly rather
than discovered while trying to make a staging call work.
