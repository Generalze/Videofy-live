# P6.3 M1-1 — run sheet

```
Source baseline   56df174   NO CODE CHANGES DURING COLLECTION
Topology          T1 — one laptop with its own speakers, peer genuinely remote
Status            PENDING — needs a real microphone, real speakers,
                  and a genuinely remote person. Not runnable headlessly.
```

T1 has never been represented in any Videofy corpus, is probably the
representative customer configuration, and is the only topology W6 cures
outright. It is therefore first.

## The matrix

Four runs. Only two variables move.

| run | capture profile | speaker level |
|---|---|---|
| A | `browser-default` | LOW |
| B | `browser-default` | HIGH |
| C | `explicit-all` | LOW |
| D | `explicit-all` | HIGH |

Launch with `?capture=browser-default` or `?capture=explicit-all`. The profile is
resolved before the microphone is acquired and is immutable for the session, so the URL
that started a run states its own capture regime.

**Held constant across all four:** same microphone, same output device, same browser,
same physical position, same speech script, same participants.

**Speaker level** — two fixed settings, and record which control was moved:

```
LOW    OS output volume 25%
HIGH   OS output volume 75%
```

The exact percentages matter far less than using the same two every time. Record an SPL
reading if one is available; do not delay M1 turning the room into an acoustics laboratory.

## The script — identical in all four runs

```
 1.  30 s silence, microphone live
 2.  "Yes."
 3.  "Oui."
 4.  "Non."
 5.  "Merci."
 6.  one normal English sentence
 7.  one normal French sentence
 8.  stop talking, remain unmuted, 30 s
 9.  remote participant speaks continuously ~15 s
10.  interrupt during remote playback
11.  repeat the interruption softly
12.  interrupt while translated TTS is playing
13.  30 s silence
```

Steps 2–5 are the utterances the VAD change put at risk (measured voiced duration
290–380 ms). Steps 8 and 13 are the recapture windows. Steps 10–12 are the double-talk
rows that decide whether any later fix has quietly bought silence.

## Ground truth — recorded BY HAND, separately from anything Videofy concluded

One block per run. This is the part no instrument can produce.

```
run                          A / B / C / D
date, time
capture profile requested
speaker-volume setting       LOW / HIGH  (control moved: ................)
SPL if measured

OS and version
browser and version
microphone label
output device label

participants physically remote      YES
headphones                          NO

intentional utterances, with rough wall-clock times
  ..............................................

unexpected captions
  text, rough time, and for each:
    followed generated TTS      /  followed original remote playback
    /  neither  /  UNKNOWN
```

**Record the facts before the attribution.** Do not label something "Path A" because it
happened while TTS was playing. W2 and W4 exist so that determination can be made later
from actual timing rather than from enthusiasm at the console. `UNKNOWN` is a legitimate
and frequently correct answer.

## Interpretation rules

**Asking is not complying.** If a run reports

```
requestedCaptureProfile = explicit-all
granted echoCancellation = true
```

that is **not an explicit-all AEC condition**. It is *explicit-all requested, plain `true`
granted* — its own observed state, and it must be carried as that through the whole
analysis. `scripts/check-instrument-health.mjs` prints this case explicitly.

**A grant is not a cause.** If Chrome does grant `'all'`, that alone does not make any
improvement attributable to `'all'`. The four-run A/B is the evidence; a single run is an
anecdote with good provenance.

## When to stop the corpus

Run `node scripts/check-instrument-health.mjs <call-log.jsonl>` after every run.

**Stop only for instrument failure** — the checker exits non-zero:

```
I1  capture settings missing
I2  requested profile or granted values missing
I3  sample-rate provenance absent
I4  clips delivered but no playback interval reported
I5  impossible ordering — a playback end without a start
I6  log wall clocks going backwards
I7  no audio reached the recogniser
I8  playback accounting inconsistent
```

Then stop, fix the instrument, and restart the corpus. A corpus is not repairable after
the fact, and every later recording would inherit the fault.

**These are RESULTS, not reasons to change code:**

```
lots of recapture          no recapture at all
very high W5A correlation  surprising AEC behaviour
'all' refused              interruptions lost
```

That distinction is going to matter most at exactly the moment the measurements become
uncomfortable, which is why it is written down before any of them exist.

The checker deliberately does not classify captions, count fabrications, decide whether a
caption followed playback, or judge whether a profile helped. It answers one question —
*is the apparatus sound?* — and a checker that offered a verdict would be the first place
this discipline broke.

## After the four runs

Analyse A/B/C/D **as one set** before starting M1-2. That comparison can change what
deserves emphasis in the rest of the corpus without changing any source code.

Source stays frozen at `56df174` throughout.
