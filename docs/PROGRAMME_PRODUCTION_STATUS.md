# Programme subsystem: what is built, what is proven, what is not

Branch `p8/programme-production-hardening`. This document is written to be
read by somebody deciding whether to deploy, so it separates three things that
are easy to collapse and expensive to confuse:

- **BUILT** — the code exists and compiles.
- **COMPOSED** — a running service constructs it. Code that is built and not
  composed does nothing, and looks identical to code that works.
- **PROVEN** — a test fails when the behaviour is removed. Not "a test exists".

Nothing below is marked proven on the strength of a passing test alone. Where
a claim rests on a mutation check, the check was run and the mutation restored.

---

## The safety delay, end to end

A protected programme is held back by a configured delay, and released to the
audience through one cursor. The parts:

| Part | Built | Composed | Proven |
| --- | --- | --- | --- |
| Canonical timeline, ordered by programme time | yes | yes | yes |
| Output buffer and public cursor | yes | yes | yes |
| Governed planes (delay refused unless every plane is governed) | yes | yes* | yes |
| Journal persistence, append-ordered, fsync | yes | yes | yes |
| Media segment store, retention, run isolation | yes | yes | yes |
| Media producer (encoder to segments to store) | yes | yes | yes |
| Public egress: playlist and segments over HTTP | yes | yes | yes |
| Audience access policy (channel visibility) | yes | yes | yes |

\* The mechanism is composed and enforced. What a deployment *governs* is a
separate setting, and it is the difference between the two modes below.

The central property — **a segment that exists on disk and has not been
published is refused** — is asserted at the HTTP boundary, against a real
spool with real bytes. Removing the cursor check from the authority turns that
test red; it was removed, the test failed, and it was restored.

The second central property — **programme time comes from the media, not a
clock** — is asserted with uneven segment durations (1.96 s, 2.04 s), because
the even case passes against the bug.

### TRUE LIVE and PROTECTED LIVE

These are the only two states an operator needs, and the console derives them
rather than printing a fixed sentence:

- **TRUE LIVE** — nothing is held. What the source sends, the audience
  receives. This is the default (`PROGRAMME_SAFETY_DELAY_MS` unset or zero)
  and is a legitimate choice, not a fault.
- **PROTECTED LIVE** — the audience is behind the source by a delay that is
  being held *right now*, so something said on air can be stopped before it is
  heard.

A delay that is configured but not yet achieved is **neither**, and is
reported as its own state. An operator who reads "protected" while the buffer
is still filling believes they have a net under them, and finds out otherwise
at the only moment it matters.

A protective delay is **refused outright** unless every time-sensitive plane
is held to the cursor. Holding captions while the audience hears the speaker
immediately is worse than holding nothing: it desynchronises the broadcast and
still fails to protect it.

**As things stand, PROTECTED LIVE cannot be reached, and this is enforced
rather than merely noted.** The gateway relays the broadcaster's audio and
video frames straight to each listener peer, on a path the media cursor has no
part in. Producing segments into a spool does not hold the original back. So
plane governance follows `PROGRAMME_MEDIA_DELIVERY`, which cannot be set to
`delayed` — asking for it is logged as an error and ignored, because accepting
it would produce a console reporting PROTECTED LIVE over an audience hearing
the speaker immediately. That is worse than having no protection, because
somebody would rely on it.

### The one blocking item for PROTECTED LIVE

> The gateway must stop relaying original programme media to listeners for a
> run in delayed mode, and listeners must receive it through the cursor-
> governed egress instead. Until then `PROGRAMME_MEDIA_DELIVERY=delayed` stays
> refused, and every run is TRUE LIVE.

Everything else in the delayed path — timeline, cursor, journal, media store,
producer, egress, access — is built, composed and proven. This is the last
join, and it is a cross-service one.

It is left unbuilt deliberately rather than half built. A gateway that refused
to relay, with no player on the other side, is a black screen for the whole
audience; and building the server half behind a flag that stays declined would
be another component that cannot be exercised end to end, which is the exact
pattern the rest of this document is about closing.

#### What it needs, concretely

1. **The gateway has to know the mode.** `MediaStateEvent` is the existing
   channel from media-ingest to the gateway and on to clients; a
   `mediaDelivery: 'live' | 'delayed'` field on it is the smallest addition
   that reaches everybody who needs it. It belongs in `shared-types` so an
   omission is a compiler error rather than an undefined at runtime.
2. **The gateway has to refuse to relay.** Listener media peers are created in
   `services/realtime-gateway/src/webrtc-listener-peer-registry.ts`, driven
   from the backend-media offer path in `gateway.ts`. A run in delayed mode
   must be refused a listener media peer outright — not muted, not paused:
   an attached peer that is expected to stay silent is one bug away from
   carrying a frame.
3. **The listener has to have a player for the delayed path.** There is none
   today: `apps/listener-web` is WebRTC-only and contains no HLS anywhere. It
   needs to fetch the egress playlist, feed fragments through Media Source
   Extensions, and — critically — resume at the *public* position rather than
   the live edge after a dropped connection, which the egress already answers
   with `publicOutputTimeMs`.
4. **The two must fail closed together.** A viewer whose client cannot play
   the delayed path must be told so, not silently handed the live feed. The
   safest ordering is: build the player first, prove it against the existing
   egress with `delivery` still `live`, and only then let the flag be accepted.

The order matters. Accepting the flag before step 3 turns a working broadcast
into a blank one; building step 3 first costs nothing, because the egress it
plays from is already there and already tested.

### What the audience path actually does today

1. An operator starts a producer for a run. The input is built from
   `PROGRAMME_MEDIA_ORIGIN_INPUT`, a template owned by the deployment, with
   `{runId}` substituted. **A caller cannot name the input.** An operator
   choosing the input would be asking the service to read whatever sits at
   that address and broadcast it.
2. FFmpeg produces fMP4 segments with keyframes forced at every boundary.
3. A segment is registered when the packager's playlist lists it, never when
   its file appears — a file that exists is still being written into.
4. The cursor releases segments once the delay has been served.
5. `GET /programmes/:runId/playlist.m3u8` renders only released segments.
6. `GET /programmes/:runId/segments/:segmentId` re-asks the cursor at fetch.

---

## What is deliberately refused

These are not gaps. They are decisions, and each one is a refusal chosen over
a guess:

- **Visibility that cannot be established refuses the viewer.** A channel with
  no profile, or an account service that will not answer for one it has never
  answered for, produces a refusal. Publishing somebody's private broadcast is
  the one failure with no recovery.
- **A locked channel refuses.** The join code lives with the gateway; this
  service has never held one. Enforcing a control it cannot check would be a
  lie, so it declines instead.
- **A private channel admits the link-holder.** Private was defined as "a
  doorbell without a sign, not a lock". Refusing here would enforce a control
  the tier does not claim.
- **An encoder that dies fails the broadcast.** A frozen cursor with a healthy
  status is indistinguishable from a programme that happens to be silent.
- **A campaign longer than the break is refused, never trimmed.** Trimming
  cuts a creative mid-sentence and still bills for it.

---

## What is BUILT and NOT COMPOSED

Stated plainly, because this repository's recurring defect is exactly this,
and an inventory that omits it is worse than none.

| Component | State | Why it is not composed |
| --- | --- | --- |
| `createC7AdvertisingAuthority`, `offerBreakOpportunity` | built, tested, not composed | There is no campaign store and no break scheduling surface. Composing a decision engine over an empty campaign list would produce a route that always answers "no advert" and reads as working. |
| `InMemoryRunWriterLease` | built, tested, not composed | See below. |

### The lease, and the condition attached to it

`JournalTimelineStore` applies `FenceGuard` to every write, but nothing calls
`writeUnder`, so **the store currently writes unfenced**. That is correct for
the deployment as it stands — one media-ingest process, systemd, one host —
and it is the honest behaviour for a deployment that has not adopted leases.

It stops being correct the moment two writers can exist. Specifically:

> **Before a second media-ingest instance is run anywhere — a second host, a
> blue/green overlap, a restart that leaves the old process alive — a lease
> must be acquired per run and passed to `writeUnder`, and the in-memory lease
> must be replaced with one both processes can see.**

`InMemoryRunWriterLease` cannot see another process and says so in its own
documentation. Composing it today would produce a fence that fences nothing
across processes, which is worse than no fence, because it would read as
protection.

---

## Configuration this subsystem depends on

| Variable | Effect when unset |
| --- | --- |
| `PROGRAMME_MEDIA_ORIGIN_INPUT` | No programme media is produced. The playlist is empty, and no protective delay is possible. Said at boot. |
| `PROGRAMME_SAFETY_DELAY_MS` | Every run is TRUE LIVE. Setting it above zero is currently refused by the plane check, because the original is still delivered live. |
| `PROGRAMME_MEDIA_DELIVERY` | Defaults to `live`. `delayed` is declined at boot until the gateway enforces it. |
| `ACCOUNT_SERVICE_URL` | Visibility cannot be resolved; **no audience is admitted**. Said at boot. |
| `INTERNAL_WEBRTC_TOKEN` | Same as above, and the gateway cannot be recognised. |
| `OPERATOR_CONSOLE_ACCOUNT_IDS` | Nobody may operate a programme, including starting a producer. |

Each of these is reported in a boot line rather than discovered as a symptom.
A deployment with no media source and one whose encoder is broken both serve
an empty playlist; only the log tells them apart.

---

## What has NOT been done

Human validation. Nothing in this document has been watched by a person on a
real device, and no part of it has run on staging. In particular:

- No end-to-end run has been performed with a real broadcaster source through
  the real encoder into a real player.
- The real encoder has not been put under load. The *egress* path has: several
  hundred requests through a bounded client pool while the cursor advances,
  asserting both failure directions — nothing served ahead of the cursor, and
  nothing offered by a manifest then refused. One encoder per broadcast is
  asserted there too. What is unmeasured is FFmpeg itself, and many concurrent
  runs on one host.
- The Programme console pages have not been re-audited against this runtime.
- Deployment to staging has not happened, and no soak has been run.

**This subsystem is not certified.** The word for its current state is
"engineered and internally verified", which is a different and lesser claim.
