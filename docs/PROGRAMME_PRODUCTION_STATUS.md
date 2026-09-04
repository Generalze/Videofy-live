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

### Where the certification wave got to

Of the four joins the activation order requires, three are done and composed:

1. **The listener can play the delayed path.** `hls.js` for Media Source
   Extensions, native HLS where the platform has it, one controller over both,
   and no route from a protected programme back to the realtime feed — not on
   error, not on an unsupported browser.
2. **The gateway refuses to relay a protected run.** No listener media peer is
   built, existing peers are torn down when a run turns protected, and the
   frame fan-out is checked as well, because a peer created before the answer
   arrived is the leak window.
3. **Delivery mode is authoritative, versioned and fail-closed.** One contract,
   published by the run, read by the gateway, the listener and the console.

The fourth — **real contribution reaching the encoder** — is half done. The
encoder is now started by the broadcast opening rather than by an operator
pressing a button, it revisions its initialisation object across a restart
instead of overwriting one that retained fragments still need, and it
continues programme time rather than restarting it. What is still missing is
the transport itself: the broadcaster publishes over WebRTC to the gateway,
and `PROGRAMME_MEDIA_ORIGIN_INPUT` expects an RTMP or SRT endpoint. Nothing
bridges the two.

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

**A contribution bridge.** The broadcaster publishes over WebRTC to the
gateway; the media origin runs FFmpeg against whatever
`PROGRAMME_MEDIA_ORIGIN_INPUT` names, which is an RTMP or SRT endpoint. For a
protected broadcast those have to be the same media, and today they are not
connected. Two shapes are plausible and this is a decision rather than a
detail:

- a contribution ingest the broadcaster publishes to directly (RTMP/SRT from
  the operator console or an encoder), with WebRTC used only for the live
  path; or
- a relay that republishes the gateway's received tracks into the origin's
  input.

Until one exists, `PROGRAMME_MEDIA_DELIVERY=delayed` stays refused at boot and
every run is TRUE LIVE. Everything downstream of the bridge — encoder,
segments, store, timeline, cursor, egress, access, gateway refusal, listener
player — is built, composed and proven, and can be exercised today by pointing
the template at any RTMP or SRT source.

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
| *(nothing)* | — | Both entries that stood here are now composed. |

### Both are now composed

**The C7 advertising authority** reads campaigns, creatives and impressions
from persistent storage, decides which advert runs, places it on the timeline,
and records the impression idempotently so a reconnect does not bill an
advertiser twice. The operator's only contribution is offering a break; there
is no column, route or body field by which they select an advertiser, a
campaign, a creative or a priority.

**The writer authority** is a lease on the same volume as the journal it
protects, with races decided by exclusive create. The store checks the volume
rather than its own memory, because the process that matters is the one whose
own fence has only ever seen its own token. Losing a lease fails the
broadcast; a run this process cannot claim is failed closed before anything is
written.

The remaining limit is honest and stated in the code: a file lease coordinates
writers **on one host**. Two machines with separate disks each see their own
lease and both win. That is why the single-instance deployment invariant still
matters, and what would replace it is a coordinator both hosts can see
across processes, which is worse than no fence, because it would read as
protection.

---

## Configuration this subsystem depends on

| Variable | Effect when unset |
| --- | --- |
| `PROGRAMME_MEDIA_ORIGIN_INPUT` | No programme media is produced. The playlist is empty, and no protective delay is possible. Said at boot. |
| `PROGRAMME_SAFETY_DELAY_MS` | Every run is TRUE LIVE. Setting it above zero is currently refused by the plane check, because the original is still delivered live. |
| `PROGRAMME_MEDIA_DELIVERY` | Defaults to `live`. `delayed` is declined at boot until the gateway enforces it. |
| `PROGRAMME_MEDIA_SPOOL` | **No protected media is held.** There is no fallback: the spool used to be derived from `AUDIO_CHUNK_DIR`, which falls back to a path relative to the working directory — under `ProtectSystem=strict` that lands in the read-only code tree. Both the gateway and this service read this one variable. |
| `PROGRAMME_SPOOL_BITRATE_BPS` | Capacity is checked against 3.5 Mbit/s. An estimate, and named as one: the encoder is constant-quality, so the real figure only exists once a run produces one. |
| `PROGRAMME_SPOOL_CONCURRENT_RUNS` | One protected broadcast. The disk requirement multiplies by this. |
| `ACCOUNT_SERVICE_URL` | Visibility cannot be resolved; **no audience is admitted**. Said at boot. |
| `INTERNAL_WEBRTC_TOKEN` | Same as above, and the gateway cannot be recognised. |
| `OPERATOR_CONSOLE_ACCOUNT_IDS` | Nobody may operate a programme, including starting a producer. |

Each of these is reported in a boot line rather than discovered as a symptom.
A deployment with no media source and one whose encoder is broken both serve
an empty playlist; only the log tells them apart.

---

## Storage on the actual host, inspected rather than inferred

Read from `c7-eu-01` on 3 September 2026. Every line below is something the
machine said, not something the code implies.

**It is not containerised.** systemd units on the host, working directory
`/srv/videofy/app/...`. Docker is installed and runs nothing for Videofy. So
"survives a container restart" and "survives a container recreation" are not
open questions here — they are not failure modes this deployment has.

**One filesystem, one disk.** `/dev/sda1`, ext4, 435 GB with 12% used, mounted
`rw,relatime,discard,errors=remount-ro,commit=30`. `/srv` is not a separate
mount. `lsblk` shows a single `sda`; `/proc/mdstat` reports no array. There is
no redundancy of any kind.

**Where the state lives:** `AUDIO_CHUNK_DIR=/srv/videofy/uploads/audio-chunks`,
which is also the parent of the timeline journals and the programme media
spool. A write / fsync / read-back probe under that filesystem succeeded and
was cleaned up.

### What survives what

| Event | Survives? |
| --- | --- |
| Process restart | Yes. The state is files on a normal filesystem. |
| Container restart or recreation | Not applicable — nothing is containerised. |
| Clean host reboot | Yes. |
| Unclean host loss (power) | Journal and cursor yes; **up to ~30 s of media, no**. |
| Loss of the host or its disk | **No. Nothing survives.** |

**The last row is the one to read twice.** There is no RAID, no replica, and
no backup of the programme spool: `videofy-backup.service` runs
`backup-database.sh` and covers the account database only. A single-host
deployment is a perfectly valid choice, and this document says so rather than
implying a failover that does not exist.

### The asymmetry worth knowing about

`commit=30` means ext4 flushes its journal every thirty seconds. Anything
written with `fsync` is durable immediately — and the timeline journal does
fsync, deliberately. **The media segments do not.** FFmpeg writes them and
nothing forces them to the device, so an unclean power loss can leave a
timeline that references segments whose bytes are gone.

That fails visibly rather than silently: the egress stats a segment before
serving it and answers 410 when it is missing. But it is a real inconsistency
mode, it is asymmetric between the two planes, and closing it means either
fsyncing segments as they complete or accepting the window explicitly.

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
- The route qualification harness is not built.
- The media segments are not fsynced, so an unclean host loss can leave the
  timeline referencing segments whose bytes are gone. It fails visibly, and it
  is not closed.
- Storage and buffer failure injection — torn journal tail, corrupt middle
  record, ENOSPC, lost write permission, fsync failure, missing init, invalid
  keyframe, retention exhaustion — is not built.
- The Programme console pages have not been re-audited against this runtime.
  Pages 06 to 10 in particular describe a delivery model that has since
  changed.
- Deployment to staging has not happened, and no soak has been run.

**This subsystem is not certified.** The word for its current state is
"engineered and internally verified", which is a different and lesser claim.

---

## Retention: what is deleted, what is kept, and what is merely absent

Three states that used to be one, and telling them apart is the whole of this
section.

| Case | Meaning | Response |
| --- | --- | --- |
| Referenced, inside the required window, missing | The material was published to somebody and is gone | **Protection fails** |
| Referenced, older than the window | Retention was entitled to delete it | Normal; counted as `expiredByRetention` |
| On the volume, referenced by nothing | A durable write whose journal append never happened | Orphan; swept after recovery, never before |

The required window is derived from the same `retentionWindowMs` the retention
policy prunes by, so the two cannot drift. It extends **past the cursor**: a
restart that recovered only what was already public would restore the current
manifest and run out the moment the cursor advanced.

**Two halves of this policy were unwired until 4 September 2026.** `prune`
existed, was tested, and was called by nothing outside its own tests; and every
deployment constructed the store with the sink whose `discard` returns true
without touching a file. The window never shrank, in memory or on the volume,
and a long broadcast filled the disk behind a green console. Both halves are
now joined and the join is asserted against the filesystem.

**Initialisation objects are reference-counted, never aged.** A fragment
decodes only with the init object of its generation, and that object is by
definition the oldest file in its directory. Deleting generation G while one
retained fragment still names it destroys the retained window instead of
trimming it — discovered by an audience mid-reconnect.

**Orphan cleanup is never "delete what is not in memory".** After a restart
nothing is in memory, and that rule would delete the entire retained window of
every recovered broadcast a moment before its audience needed it. The sweep
refuses to run on a run recovery has not reconstructed, takes the authoritative
reference set as its input, and leaves anything inside a ten-minute grace
period alone.

**Capacity is a separate fact from writability.** Fifty megabytes free is
writable and is not a forty-five second safety buffer. It is checked at startup
against `bitrate x retention seconds x concurrent runs x margin`, and again
every thirty seconds while a run is live, with the exhaustion horizon projected
from the trend rather than awaited as ENOSPC.

**The one remedy that is never taken is shortening the delay.** It would
reliably free space, and it would put an audience closer to live than the
people relying on the protection were told. When the volume cannot hold the
promise, the promise fails loudly and the delay stays where it is.

---

## Certification history: what each red gate actually caught

Kept because the *cause* matters as much as the colour, and two of these are
easy to remember wrongly.

### `0702202` — CI #88 red

```text
CI failure          service-boots.test.ts, EADDRINUSE on a fixed port
first-run no-leak   PASSED, all 13 tests, in the same run
relay fail-open     found by a later code audit, NOT by this CI failure
```

The boot harness collided on a port because the previous probe's child had not
released its socket. It says nothing about the product. The Programme relay
defect below was real, serious, and discovered independently by reading the
code — treating the red gate as evidence of it would have been luck rather
than method.

A gate that fails for reasons unrelated to what it guards is worse than no
gate: it teaches everybody to re-run CI.

### The relay fail-open, found by audit

Two defaults, both of which read as reasonable:

```text
mayRelayFrames()    absence from the FORBIDDEN set = permission
mayRelayRealtime()  absence of a programme run     = "an ordinary call"
```

So an unclassified backend media session relayed by default, and a broadcaster
frame arriving before the operator configuration reached the audience. The
window was the one a safety delay exists to cover.

**And the test written to catch it could not.** It called `admitSession` and
then produced frames, proving "unknown delivery after admission is safe" and
never "media arriving before admission is safe". That is the second test in
this wave to agree with the defect it was guarding; the first asserted
`toContain('return !this.sawDelayedDelivery;')`.

The correction moves the invariant to the media boundary rather than expecting
the announcement to win a race: the set lists what has been positively OPENED,
an unbound session is classified by the deployment policy, and before any
classification the answer is no.

### Two locks, at different scopes

```text
DEPLOYMENT POLICY   pinned for the gateway process
                    a contradicting one is a FAULT, not a change
                    new programme admission refused while in conflict
                    active protected runs stay protected

RUN DELIVERY MODE   pinned for the programmeRunId, both directions
                    readiness may change; the mode may not
```

### Connection liveness is not delivery authority

```text
media-ingest disconnects
→ a pinned LIVE policy is NOT erased
→ trueLiveCapable stays true (that route never ran through ingest)
→ protectedLiveCapable becomes false (spool, cursor and egress live there)

gateway restarts with no policy reacquired
→ deliveryAuthorityKnown false
→ no programme original media relays at all
```

Accepted deliberately: losing programme availability is preferable to exposing
a protected broadcast at realtime. `/health` reports the three facts separately
because they disagree, and the disagreement is the useful part.
