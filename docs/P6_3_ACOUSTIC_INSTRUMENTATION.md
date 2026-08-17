# P6.3 — acoustic recapture instrumentation (W1–W5A)

```
Branch     p6.3/acoustic-instrumentation
Baseline   7f9a553
Evidence   1e05567 (manifest) — verified before any source file was touched
Scope      W1, W2, W3, W4, W5A. Nothing else.
State      instrumentation complete; STOP. Next is M1, not W6.
```

This wave adds **measurement only**. It suppresses nothing, routes nothing differently,
binds no participants and produces no `roomId`. Its purpose is to make the M1 real-device
corpus *interpretable* — every one of these five exists because without it a specific
measurement in that corpus would be uninterpretable or simply absent.

A green build here is the signal to **stop coding and collect the corpus**. It says the
measurements are trustworthy. It says nothing about which fix is correct, and the whole
point of the ordering is that we do not yet know.

## What shipped

### W1 — capture-settings provenance

`apps/call-web/src/callCapture.ts` (new), wired at `App.tsx`.

The call app requested `{ audio: true }` and inspected nothing, while
`apps/operator-web/src/broadcasterCapture.ts` has stated its capture contract since P3.
That is why, when acceptance failed, no call log could say what echo cancellation had been
doing and it had to be measured by hand from a live browser afterwards.

Now requested: `echoCancellation: { ideal: 'all' }`, `noiseSuppression`, `autoGainControl`,
`channelCount: { ideal: 1 }`. **`ideal`, never `exact`** — `exact: 'all'` rejects with
`OverconstrainedError` on any browser without the string form, and the participant then
cannot join at all.

`track.getSettings()` is read back and forwarded as `call:capture-settings`, at join and
again on `devicechange`. One record per participant per reading.

**Device labels are recorded; device ids are not.** A label names hardware, which is what
M1's rig question needs. An id is a stable per-origin identifier that would correlate one
person across every call they join, which nothing here needs.

### W2 — truthful timing and voiced extent

`webrtc-transcription-chunker.ts`, `webrtc-transcription-bridge.ts`.

`capturedAtMs` was stamped at segment **close** and read downstream as "when the speech
ended". Those differ by the end-silence window — and, the part that made it uncorrectable,
**by a different amount depending on why the segment closed**. A constant could have been
subtracted out; this could not. The error ran in the direction that understates playback
overlap.

Five wall clocks now travel on every VAD chunk, each meaning exactly one thing:

| | field | meaning |
|---|---|---|
| 1 | `firstCapturedSampleAtMs` | first sample of the segment |
| 2 | `lastVoicedSampleAtMs` | last sample **above the speech gate** |
| 3 | `lastRetainedSampleAtMs` | last sample actually kept — (2) plus the retained post-roll |
| 4 | `vadClosedAtMs` | when the VAD decided it was over |
| 5 | `gatewayReceivedAtMs` | receive time of the frame that closed it |

plus `closeReason`, which is what makes (4) − (2) interpretable at all. Fields 6 and 7 —
playback start and end per recipient — live in the W4 ledger, because they are per
recipient and this chunk is not.

Absent on fixed-interval programme chunking, which has no voiced extent. Reporting one
would be exactly the class of invented millisecond this replaces.

`capturedAtMs` is kept, with its documentation corrected, because the existing
gateway-to-delivery latency figures measure something else and are unaffected.

Also: the chunker's `endSilenceMs` fallback said 650 while `config.ts` said 700. One
number, one default.

### W3 — input sample-rate provenance

`webrtc-audio-ingest-bridge.ts`, `webrtc-media-peer-registry.ts`, `call-runtime.ts`.

The rate was recorded on every frame and then dropped before anything could read it. It is
now on the bridge snapshot, the peer snapshot (so the diagnostics endpoint stops hiding
it), and stamped once per participant into the call log.

Needed because changing the resampler changes correlation statistics: without this, after
any such change you cannot tell which corpus recordings need their acoustic measurements
rerun.

### W4 — dual-path playback ledger

`call-playback-ledger.ts` (new), `call-runtime.ts`, `callAudioQueue.ts`, `App.tsx`.

**Two interval streams per recipient, not one.**

- **Path A** — generated clips. Discrete, with an identity and a duration. The gateway
  registers each clip against its recipients at emit; the client reports actual start and
  end.
- **Path B** — the raw fan-out of somebody else's live microphone. Continuous, unbounded,
  no identity, no duration — and played by the **same loudspeaker**. Driven by the remote
  audio element's own `play`/`pause`/`stalled` transitions crossed with the mix policy: in
  `translated` mode `originalVolume` is 0 and it is not audible however much data flows.

A ledger recording only clips would leave Path B unmeasurable, and Path B cannot be told
apart from genuine same-language speech without knowing when the remote original stream
was audible.

`roomAudibleAt()` unions both.

**Missing reports stay missing.** A clip emitted but never confirmed keeps
`actualStartAtMs: null` and is counted in `playbackClipsUnreported`. It is never backfilled
from emit time — substituting the emit time would convert an absence of evidence into a
fabricated measurement, which is the failure mode this whole wave exists to remove.

Client reports sit behind `requireBinding` (NG6): a socket may only report **its own**
loudspeaker, and the gateway aggregates because the consequence lands on a *different*
participant's microphone — something no client can see.

Clip identity is **derived on both sides** from the same event fields rather than passed
as an opaque id, so a disagreement surfaces immediately as an unknown-clip report instead
of as a ledger that is quietly always empty.

### W5A — co-location feature observation

`call-acoustic-rooms.ts` (new), fed from `handleMediaAudioFrame`.

Per candidate pair, on a timer: correlation, lag, low/mid/high band coherence, concurrent
voiced duration, compared duration, and provenance for both sides from W1/W3.

**Anti-alias then decimate.** Every sample is integrated into its output envelope frame;
none is sampled and none discarded. That is precisely the property `resampleLinear` lacks —
it keeps every third sample and throws the other two away, so out-of-band energy folds into
the speech band. Box-car integration is not brick-wall, but nothing passes unfiltered.

**Envelope extraction is the only frame-path work. The correlator runs on a 2 s timer.**

Measured, 48 kHz, two participants:

```
p50   0.0018 ms per 10 ms frame
p99   0.0042 ms per 10 ms frame     (0.04% of the frame budget)
correlator  5.5 ms, off the frame path, every 2 s
```

**It does nothing with the answer.** No `roomId`, no binding, no fan-out exclusion, no
gating, no declared threshold. `grep -rn roomId` over all non-test source returns nothing.
Every reference to the observer in `call-runtime.ts` is a write, a lifecycle call, or a
cost read; none reads a feature back.

The `hypothesis` field (`room-acoustics` / `shared-capture` / `inconclusive`) is recorded
so M5 has something to score. It is read by nothing. The spectral-tilt separation behind it
is what M1 must confirm or refute on real hardware, not a rule implemented now.

## Why the numbers are not thresholds

Cross-microphone arrival-time correlation is the only detector in the investigation that
survived measurement — r = 0.710 at −3.19 ms against |r| ≤ 0.23 for seven controls. That
justifies **computing** the feature. It is nowhere near enough to act on: roughly 1.5
usable observations, from one call, on one machine, and one of the two apparent
observations turned out to be a shared capture device rather than a room.

The unit tests assert loose ranges deliberately, never candidate thresholds. Writing one
into a test would smuggle in the decision M5 exists to make.

### One thing the tests found

The first version of the W5A fixture gave two "independent" speakers the same syllable
envelope and differed only in the noise seed. They correlated at **0.96**.

That is not a bug in the observer — it correlates *envelopes*, so anything sharing a rhythm
correlates whatever the underlying audio. It is a real property M5 must characterise on the
corpus: a co-location score keyed on speech rhythm will also fire on two remote people who
fall into the same cadence. Recorded here rather than asserted in code, because it is a
hypothesis about a failure mode and this wave does not get to assert those.

## Verification

```
gateway tests            261 passed (20 files)
repo test                all passed
typecheck / lint / build exit 0
VAD source harness       9/9 PASS
grep roomId (non-test)   no matches
```

Deterministic frame-path equivalence lives in
`services/realtime-gateway/src/__tests__/call-acoustic-instrumentation.test.ts`: the same
scripted frame sequence is driven through the runtime with the observer active and with it
stubbed out, asserting the frames reaching the transcription bridge and the fan-out are
deep-equal in content, order and count. It must fail if anyone later moves correlation,
gating or allocation onto the frame path — the road by which "observation only" quietly
stops being true.

W2's timing test drives an injected clock and asserts the stamped voiced extent to ±10 ms
for **both** close reasons, including that `vadClosedAtMs − lastVoicedSampleAtMs` is ≥690 ms
on an end-silence close and ≤10 ms on a max-duration close — the close-reason dependence
that made the old single stamp uncorrectable.

## Also corrected

`services/media-ingest/src/transcription-provider.ts` — the causal comment was accurate
about the session it cited but read as a complete account of the phenomenon class, and sent
a later investigation down the wrong path. It now records both defects explicitly:

- **Defect A** — near-silence / recogniser fabrication. Mitigated by the VAD voiced-fraction
  rule and `speech-confidence.ts`.
- **Defect B** — acoustic recapture. Addressed by nothing in that file, and by no Whisper
  setting: the audio really was spoken, just not by a person.

The existing fixes are untouched. They address a real failure mode.

## Not done, deliberately

W5B (room binding), W6 (AEC-referenced render), W7 (fan-out exclusion), W8 (playback gate),
the resampler fix, and any threshold change. W5B is blocked on M1 and M5; W7 and W8 depend
on W5B and therefore cannot run either.

The resampler defect at `webrtc-transcription-chunker.ts` `resampleLinear` remains **open**
and gets its own wave: at 48 kHz → 16 kHz the ratio is exactly 3, `fraction` is always 0,
and it reduces to `output[i] = samples[3i]` with no anti-alias filter. Both VAD harnesses
feed 16 kHz frames, so neither exercises it. W3 now stamps the input rate on each recording
so it can be established whether the path is engaged in production — and so that when it is
fixed, it is known which measurements must be rerun.

## Open observation O1 — still open

```
Human said   "Oui."
Playback     "Yes."
Observed     "c'est ça, c'est ça, c'est ça, c'est ça."
```

Its immediate mechanism is **not established**. Not classified as Path A (the clip playing
was "Yes.", which does not match), not classified as Path B (the speaker said "Oui.", not
"c'est ça"), not made into a third defect class, not filtered, not tuned around, and not
explained in a source comment. Revisit only if M1 / W2 / W4 evidence resolves it.

## Next

**M1 — the real physical-device corpus.** W1–W4 and W5A must be running during collection:
M5 derives its calibration from exactly these features, and a threshold derived from a
separately reimplemented analysis would mean the production extractor was never the thing
validated.

Configuration 3 — one laptop with its own speaker and genuinely remote participants — has
never been tested, is probably the representative customer configuration, and is the only
topology W6 cures outright.
