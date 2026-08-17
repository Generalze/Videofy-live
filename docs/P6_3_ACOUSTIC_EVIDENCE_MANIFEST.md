# P6.3 acoustic evidence manifest

Provenance record for the forensic evidence behind the P6.3 acoustic-recapture root-cause
classification. **The evidence itself is deliberately not in this repository** — see Storage.

```
Evidence captured:  2026-08-17
System baseline:    7f9a553
Root cause:         ACOUSTIC PLAYBACK RECAPTURE (closed)
```

## Call logs

| File | SHA-256 |
| --- | --- |
| `gentle-atlas-54.jsonl` | `31adc9acec9874cfd0a7e6dde6d18fccd154500a9c2a970cf78e5904126324a3` |
| `swift-ember-69.jsonl` | `8227826a24251e8d12fb02d95879e6c83aa77c55c597d82e8dec89e57a0d9b76` |

`gentle-atlas-54` is the acceptance failure. `swift-ember-69` is the controlled A/B: the
loudspeaker was silenced in software for 653 s (25 captions, 0 recaptures) and then restored
(40 s, 5 captions, 1 recapture), with everything else held constant.

## Referenced WAV corpus

118 files across the four revision-scoped session directories that the analysis and its
controls used. Retained whole per directory rather than curated, because the same-call chunks
are the controls — the same-microphone/different-utterance baseline that makes the
cross-microphone correlation meaningful comes from within these sets.

| Directory | Files |
| --- | --- |
| `call_gentle-atlas-54_participant_1_r2` | 21 |
| `call_gentle-atlas-54_participant_2_r1` | 8 |
| `call_swift-ember-69_participant_1_r3` | 58 |
| `call_swift-ember-69_participant_2_r2` | 31 |

Per-file hashes are in `SHA256SUMS.txt` inside the evidence directory. Verify with
`sha256sum -c SHA256SUMS.txt`.

## Supporting artefacts

| File | SHA-256 |
| --- | --- |
| `rig-topology.md` | `10eeac9d27fe3a35b55553247c21bdb7948a9e5713123270995875d807ca471e` |
| `recapture-loop-report.html` | `254e99ff14b1cec0c5f6c0ed28675e0fc2a4d438694b576cb4121738b4091ee2` |
| `P6_3_FIX_IMPLEMENTATION_PROMPT.md` | `a1cbb71536b0d491e61b208c367858c9340f0e3ac9b8a25eb79583359a366ae6` |

## Storage

Private development evidence, held outside version control at:

```
videofy-evidence/p6.3-recapture-2026-08-17/
```

Raw audio and full call transcripts are **intentionally not committed**. `.gitignore:185`
already excludes `uploads/`, and that rule stays. Call content is a development and demo aid
under Architecture §23, never a retention mechanism, and it does not belong in git history
where it cannot be withdrawn.

This manifest is the only part of the evidence that is versioned. Its purpose is to let a
future reader prove that the artefacts they hold are the ones the classification was made
from.

## Interpretation baseline

Pre-W1 / W2 / W3 / W4 / W5A instrumentation. Three limitations travel with this corpus and
must be carried into any comparison:

**Known timing limitation.** `capturedAtMs` is stamped at segment close, after end-silence, so
reconstructed voiced-ends sit roughly 500 ms later than the truth, and the bias is
close-reason dependent (near zero on a max-duration close). The error understates playback
overlap; true containment is greater than the recorded gaps suggest. W2 fixes the instrument,
not this data.

**Known rig limitation.** Every recording is one machine, two browser contexts. No two-device
recording, no real-room separation, no headphone control, and no T1 configuration — one
laptop with its own speaker and genuinely remote peers — exists in this corpus at all. For
`gentle-atlas-54` the rig is inferred rather than measured, and at least one apparent
two-microphone observation is in fact one signal reaching two capture contexts. See
`rig-topology.md`.

**Consequence.** No co-location threshold may be calibrated on this corpus. It is a
qualitative existence proof of the mechanism, not a quantitative basis for a detector.

## Do not rewrite

These logs must not be regenerated, migrated, or corrected to match W2's timestamp scheme.
They are an immutable snapshot of `7f9a553` semantics, and their value is precisely that they
predate the instrumentation. Comparisons against the M1 corpus are comparisons *across* that
boundary and must account for it explicitly rather than erase it.

## Purpose

Preserve immutable evidence for comparison with the M1 real-device corpus and later acoustic
measurements. Referenced by the P6.3 fix brief, whose first precondition is verifying this
freeze is intact before any source file is modified.
