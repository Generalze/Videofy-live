# P6.1C — Native Call Acceptance Report

- **Repository owner:** masterzee001
- **Date:** 2026-08-15
- **Milestone:** P6.1C — acceptance of the native two-person call (P6.1A + P6.1B combined)
- **Status:** Automated §30.4 criteria pass on a real bilingual call; latency evidence and the
  owner's human quality review remain
- **Runtime profile:** `development-demo` (no commercial claim)

## Headline

A real English↔French call between two participants on the owner's machine sustained a
**14-exchange bilingual conversation** with translated captions and translated voice in both
directions. This is the first sustained multilingual conversation the platform has produced;
every prior call stopped after one utterance because of the defects listed below.

## §30.4 acceptance — evidence call `swift-willow-40` (105 s, real microphones)

| Criterion | Result |
| --- | --- |
| Two devices join one call | PASS — 2 participants |
| A speech → B translated caption and audio | PASS — en→fr captions and clips delivered |
| B speech → A translated caption and audio | PASS — fr→en captions and clips delivered |
| Both translation directions exercised | PASS — `en→fr`, `fr→en` |
| Translated audio delivered for both speakers | PASS — 14 clips |
| Male and Female standard voice selection honored | PASS — `en_US-hfc_female-medium`, `fr_FR-siwis-medium` |
| Translation persists across the call | PASS — 14 delivered captions |
| No session-killing faults | PASS — 0 ingest faults |
| Original audio remains per mix mode | PASS — owner-verified in-call |
| Generated audio never enters STT | PASS — structural (publish peer carries only the raw microphone track) |
| Latency measured and reported honestly | **Open** — instrumentation landed in this wave; numbers require one post-instrumentation call |
| Human voice-quality review of EN/FR voices | **Open — owner-only** |

Sample of the recorded conversation (from the call transcript log):

```
[en→fr] "Can you hear me?"                          => "Vous m'entendez ?"
[fr→en] "Vous m'avez entendu ?"                     => "Did you hear me?"
[fr→en] "Oui je l'ai entendu"                       => "Yes, I heard it."
[en→fr] "let's try something else"                  => "Essayons autre chose."
[en→fr] "It's nice to know that it's working okay again."
                                                    => "C'est bon de savoir que ça marche à nouveau."
```

Verify any call with `node p61c-verdict.mjs <call-code>` against
`services/realtime-gateway/uploads/call-logs/`.

## Defects this milestone had to fix first (all owner-reported from live testing)

Every one was found by the owner using the product, not by the automated suites — the suites had
generated contiguous, gapless chunk timelines that real speech never produces.

1. **VAD gap rejection (dominant).** Chunk acceptance demanded each chunk start exactly where the
   previous ended. Correct for programme media, fatal for calls: every natural pause is a gap, so
   utterance 2 onward was rejected permanently. Calls now accept forward gaps; overlap still fails.
2. **Fatal per-chunk failure.** One bad chunk moved the session out of `processing`, after which
   every later chunk was refused for the rest of the call. Calls now record the fault and continue.
3. **Sequence contiguity.** Expected sequence was the count of stored chunks, so one drop stalled
   everything after it. Calls now require strictly increasing sequence and tolerate gaps.
4. **Window-fit compression.** The programme lip-fit (`length_scale` pre-fit + `atempo`) squeezed
   call translations into the source window, making them fast and clipped. Calls use natural pacing.
5. **Same-language silence.** "Translated" mode suppressed the original voice while waiting for a
   translation that never comes in a same-language pair. The original voice is now the delivery.
6. **CORS.** The gateway allow-list omitted the call app's origin, so joining failed outright.
7. **Silent playback failure.** A browser-rejected clip produced neither audio nor a prompt; the
   playback state now surfaces the enable-audio recovery.

## Delivered in this wave

- **Honest latency instrumentation.** `deliveryLatencyMs` on every delivered caption and clip:
  wall-clock ms from the end of the captured speech segment (last audio sample of the VAD chunk
  reaching the gateway) to the moment the gateway emitted the payload to the recipient. Includes
  staging, gateway queue wait, media-ingest STT/translation/TTS and routing; excludes
  browser→gateway transport and client playback. **Null when unknown — never estimated.** The
  definition string ships in every `call-summary` record so no reader has to guess.
  `sinceChunkSubmittedMs` is logged alongside as the same measure without gateway queue wait.
- **Recency-preserving backpressure.** When speech outpaces the pipeline, call sessions now evict
  the OLDEST queued chunk instead of discarding the newest audio; programme sessions keep
  reject-new byte-identically. Queue accounting is exact, and a pre-existing leak (a partially
  enqueued batch keeping its reservation after a throw) was fixed.
- **Call summary record** on teardown: per-recipient delivery counts, dropped/evicted/faulted
  counts, and median/p90 latency.
- **Call transcript log** (owner request): one JSONL per call with joins, captions (original and
  translation), voice clips, faults, and the summary. Development-only, off unless
  `CALL_TRANSCRIPT_LOG_DIR` is set, since call content is written to disk (§23).

## Explicitly not claimed

- **Camera video.** Not a §30.4 criterion; server-relaying video on the demonstration machine is a
  performance risk and belongs in its own scoped wave.
- **Commercial readiness.** Unchanged: `development-demo` only, no language is fully voice-ready,
  and the English HFC voices remain `blocked-noncommercial`.
- **Conference, SDK, external adapters, personal voice.** Later milestones.

## Remaining for P6.1 closure

1. One short call after this wave lands, to record `deliveryLatencyMs` evidence.
2. Owner human voice-quality review of the registered EN/FR voices (the §30.3 approval gate).
3. Owner milestone approval.
