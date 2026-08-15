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
| Latency measured and reported honestly | PASS — see "Measured latency" below |
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

## Measured latency

Recorded from the gateway call log on a real two-browser EN↔FR call after the
speech-recognition GPU move and the streaming-partials wave (call `partial-9888`, 7/7 criteria):

| Measure | Median | p90 | n |
| --- | --- | --- | --- |
| Final caption delivered | 541 ms | 3303 ms | 58 |
| Interim caption delivered | 470 ms | 791 ms | 80 |
| Translated audio clip delivered | 1173 ms | 4086 ms | 29 |

Read honestly, which is the point of the criterion:

- **Steady state meets §22.** Excluding the opening, final captions sit at 530 ms and audio at
  roughly a second — inside the 1–3 s target.
- **The p90 is not steady state.** It is dominated by the first few utterances of the call, which
  pay for lazily-loaded models: the first six finals averaged 1651 ms against 530 ms for the
  remaining 52. Per-call warm-up now removes about 360 ms of that; the rest is inherent to loading
  a translation pair and a voice on demand.
- **Latency statistics sample finals only.** Interim captions are faster by construction, and
  including them would flatter the number without anything being faster.
- **A separate ceiling exists.** Delivery holds at roughly 1.2 caption events per second and falls
  behind at ~2.4, because the models are shared across participants while backpressure is
  per-session. Documented in the [call runtime design note](P6_1B_CALL_RUNTIME_DESIGN.md); not yet
  resolved, and not hidden inside these percentiles.

Per-stage provider timings on the same hardware (RTX 5060 Laptop, `cuda`/`float16`): speech
recognition ~400–500 ms, translation ~400–800 ms, speech synthesis ~615 ms median. An earlier
1.8 s synthesis figure no longer holds — moving recognition to the GPU freed the CPU that the
voice engine competes for.

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

## Correction: browser acceptance runs were not measuring what they claimed (2026-08-15)

The two-browser harness used Chrome/Edge's `--use-fake-device-for-media-capture` with
`--use-file-for-fake-audio-capture` to play known speech into a call. **On this machine that flag
has no effect**: `enumerateDevices()` returns only real hardware, and `getUserMedia` hands back
`"Default - Microphone Array (Intel Smart Sound Technology)"` with or without the flag. Every
browser acceptance run therefore captured the room, not the speech file.

That explains behaviour previously read as flakiness — runs "passed" when ambient noise crossed the
VAD threshold and speech recognition hallucinated plausible text on it, and "failed" when the room
was quiet. The recurring `"Subtitles directed by the community of Amara.org"` line in earlier
transcripts is a well-known Whisper hallucination on near-silence, and should have been the tell.

What this does and does not invalidate:

- **Still sound.** The transport, routing, caption delivery, voice selection, mix modes, revision
  handling and fault behaviour were all exercised by real two-browser calls, and the delivery
  counts and latency figures are real measurements of real deliveries.
- **Not established by those runs.** That the *right words* survived the pipeline. Content accuracy
  was never actually under test, because the input was not the intended audio.

Content correctness is now verified deterministically instead, by submitting known speech directly
to media-ingest and asserting on the transcript and the translation (`pipeline-verify.mjs`). A pass
means the words really did survive:

| Pair | Utterances transcribed | Exact word match | Translated | Voice generated |
| --- | --- | --- | --- | --- |
| en→fr | 4/4 | 4/4 | 4/4 | 4 clips |
| en→es | 4/4 | 4/4 | 4/4 | 4 clips |
| es→en | 4/4 | 4/4 | 4/4 | 4 clips |
| fr→en | 4/4 | 3/4 | 4/4 | 4 clips |

The one fr→en miss is a recognition slip on synthesised speech ("part à huit heures" heard as
"Pare à 8h"); the translation remains sensible. Sample: "Quiero confirmar que la traducción funciona
en ambas direcciones." → "I want to confirm that the translation works in both directions."

**Browser-level acceptance with known audio remains open** and is an owner action: it needs either a
machine where the fake-device flag works, a virtual audio cable routed into the browser, or a human
simply speaking into a call. This is exactly the human-verification gate that cannot be self-served.

## Defect this correction uncovered: es→en translation was dead

Verifying Spanish properly immediately exposed a real fault that the browser harness could never
have found. Spanish recognition was perfect while **every es→en translation failed**, so a Spanish
speaker would have been captioned in Spanish and never translated for an English listener — the
explicit P6.1A/P6.1B criterion.

The cause was a corrupt local model cache, not code: `models--Helsinki-NLP--opus-mt-es-en/refs/`
was empty, so with downloads disabled the Hugging Face resolver could not map the repo id to its
snapshot and handed the tokenizer `None` for `source.spm`, surfacing as
`"OPUS-MT translation failed. expected str, bytes or os.PathLike object, not NoneType"`. Every other
pair had a `refs/main`. Writing the missing ref restored it, and es→en now translates correctly.

Worth noting for operations: the failure was *reported* honestly — it landed in the session's
`monitoring.lastError` — but nothing surfaces a per-pair translation outage at the call level, so
one language pair can be completely dead while the call looks healthy.

## Explicitly not claimed

- **Camera video.** Not a §30.4 criterion; server-relaying video on the demonstration machine is a
  performance risk and belongs in its own scoped wave.
- **Commercial readiness.** Unchanged: `development-demo` only, no language is fully voice-ready,
  and the English HFC voices remain `blocked-noncommercial`.
- **Conference, SDK, external adapters, personal voice.** Later milestones.

## Remaining for P6.1 closure

Both remaining items are owner actions; nothing automated is outstanding.

1. Owner human voice-quality review of the registered EN/FR voices (the §30.3 approval gate).
2. Owner milestone approval.
