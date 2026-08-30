# Investor demo runbook -- Videofy Live

Written 30 August 2026, for hours of presentation to investors. The point of
this document is that nothing in the room is a surprise: every beat names what
must already be true, how long it takes, what the audience actually sees, and
what to say when a provider is slow.

One rule sits above the rest and is repeated where it bites:
**never present a language as good because a request succeeded.** ElevenLabs
and Azure both return HTTP 200 with fluent-sounding audio for Yoruba, Hausa and
Igbo, and a speaker of those languages hears a multilingual voice reading
unfamiliar orthography with the wrong sounds. Every server signal is green and
the product is wrong. "Enable everything" is a true statement about the picker;
it is not a statement about quality, and the two must not be blurred in front
of people who will later check.

---

## 0. Thirty minutes before

Run the readiness check against the exact origin you will demonstrate:

```bash
node scripts/demo-readiness.mjs https://staging.consummate7.com
```

It prints a PASS / FAIL / BLOCKED table with status codes and exits non-zero on
any FAIL. It checks, in one command, every deployment-level fact the beats
below rest on: the three services healthy, all four web surfaces serving a
bundle that actually loads, the language catalogue and how many languages
resolve to each capability state, the synthesis vendors **by name**, the relay
reachable and not behind the ordinary Cloudflare proxy, a channel directory
with a handle and an avatar, `/streams/<handle>` resolving, the operator
console served with programme control refusing anonymous callers, and whether
the services agree on one deployed build.

* **READY** -- proceed.
* **NOT READY** -- read the FAIL rows. Each one names the symptom in the
  language of the fix. Do not start the demo on a red row and hope; every red
  row here is a failure that presents itself as a blank page, silence, or a
  call that will not connect, which is exactly the kind of thing that consumes
  ten minutes in front of an audience.
* **BLOCKED** -- the script could not determine that fact from outside the box.
  Blocks do not stop the demo, but each has a by-hand fallback named in its own
  row; the two that matter are called out in beats 2 and 5.

Also do these, because no script can:

| | |
| --- | --- |
| Browsers | Two windows on separate profiles (or two machines). A call needs two participants and they must not share a microphone. |
| Audio | Speakers on the presenting machine, microphone permitted, and the OTHER window muted -- two unmuted windows in one room is feedback, and it sounds like a product defect. |
| Network | Prefer wired or a known Wi-Fi. Two participants behind the same NAT connect peer-to-peer; the relay covers the rest and is checked above. |
| Accounts | See the table in section 1. Sign both in BEFORE the audience arrives and leave the tabs open. |
| Tabs | Open every URL in section 6 in advance, in order, and leave them loaded. Typing a URL on stage is dead air. |

---

## 1. The origin, and the accounts

**Which deployment.** Today the demonstrable origin is
`https://staging.consummate7.com`. Production (`consummate7.com`) is a
documented cutover that has **not been run** -- see
`docs/PRODUCTION_CUTOVER_RUNBOOK.md`. If asked, the honest sentence is: *"this
is our staging environment, which runs the same code and the same providers;
production cutover is a written procedure we execute when we choose to, not a
thing left to build."*

**What must be true before you start:**

| precondition | how to confirm | why the demo needs it |
| --- | --- | --- |
| Two signed-in accounts, email-verified | both browser windows show the app, not the sign-in screen | a call needs two people; email verification is what grants hosting |
| One of them on the operator allowlist | `/operator/` admits it rather than answering `403` | programme control is allowlisted by account id (`OPERATOR_CONSOLE_ACCOUNT_IDS`), fail-closed by design |
| A channel with a handle and an avatar | the readiness check's CHANNELS rows | beat 4 opens `/streams/<handle>`; a channel with no avatar reads as unfinished |
| Target languages configured on the deployment | the readiness check's LANGUAGES rows | this is the list you may pick from, and the list you may claim |
| A real translation chain | LANGUAGES row *"names real vendors (not mock, not off)"* | a mock chain produces confident silence with every signal green |

**On trust states.** An account here may display `verification_required` while
being perfectly able to host calls, conferences and programmes. That is
correct, not a fault: hosting is granted by verified **email** alone, while the
full state also waits on phone and identity verification, which are switched
`off` until a provider is chosen. If it appears on screen and somebody asks,
that one sentence is the whole answer. The mechanism, with the lines that prove
it, is in `docs/PRODUCTION_CUTOVER_RUNBOOK.md`.

---

## 2. The order

Five beats, roughly 20 minutes of product with room for questions. The order is
deliberate: it opens with the thing that is hardest to fake (two humans, two
languages, live), then widens to one-to-many, then shows the control surface
behind it, then the public front door, then reach.

| # | beat | surface | time |
| --- | --- | --- | --- |
| 1 | A live translated call between two people | `/call/` | 4-5 min |
| 2 | A programme, and a listener choosing a language | `/operator/` + `/listen/` | 5-6 min |
| 3 | The operator console driving it | `/operator/` | 3-4 min |
| 4 | C7 Streams, and a channel page | `/` and `/streams/<handle>` | 3 min |
| 5 | The phone | web surfaces, standing in | 2 min |

---

### Beat 1 -- A live translated call between two people

**Time:** 4-5 minutes.

**Must be true beforehand:** both accounts signed in, in two windows, on two
audio devices or with one muted. Both languages picked in the readiness check's
demonstrable list (section 5). The relay row PASSED.

**What you do.** In window A, open `<ORIGIN>/call/`, create a call and choose
**Translated** rather than Normal. Set the speaking language and the language
to hear. Share the code (or the join link) into window B, join, and choose a
different hearing language there. Speak two or three ordinary sentences --
short ones, with a pause; not a list of numbers.

**What the audience sees.** Two people in one call, each hearing the other in
their own language, with captions running alongside. Say what is happening
while it happens: the speech is recognised, translated and re-spoken as audio,
and the other side's original voice is ducked underneath rather than replaced
by silence.

**Normal versus Translated is the business model, so say it.** Normal mode is a
free call on every channel; the translation engine is retired when a call is
normal. Translation is the billable unit -- it is metered where translation
happens, per second, not per seat. Choosing the mode on screen is the perfect
moment to say that in one sentence.

**If a provider is slow.** The first translated sentence of a session can take
noticeably longer than the ones after it: several vendors scale capacity to
zero and take a moment to come back. Say so plainly -- *"the first sentence
warms the path; watch the second"* -- and keep talking. Do not repeat the
sentence into the silence; a second sentence arriving normally is a better
demonstration than a first sentence repeated.

**Fallback if the call will not connect.** Two windows on the same machine
connect peer-to-peer and almost always succeed. If they do not, do not debug on
stage: switch to beat 2, which does not need a mesh, and come back to the call
at the end if there is time.

---

### Beat 2 -- A programme, and a listener choosing a language

**Time:** 5-6 minutes.

**Must be true beforehand:** the operator account is on the allowlist;
media-ingest reports `status=ok` and `gatewayConnected=true` (the readiness
check's SERVICES rows); the target languages you intend to offer appear in the
catalogue.

**What you do.** In the operator window, open `<ORIGIN>/operator/`, pick the
source, choose the target languages on **02 Source** and **03 Languages**, and
start the programme from **10 Live Control**. In the second window open
`<ORIGIN>/listen/` and join as a viewer, then change the "listen in" language
while the programme is running.

**What the audience sees.** One speaker, many simultaneous target languages,
and a viewer switching between them mid-sentence without rejoining anything.
This is the beat that distinguishes the product from a captioning tool: the
listener is choosing an audio rendering, not a subtitle track.

**What to say while it runs.** Every viewer is served their own language from
one source; adding a language adds a rendering, not a broadcast. That is the
scaling story and it is worth stating once, clearly, rather than implying.

**If a provider is slow.** Translated audio lags the speaker; it is a
pipeline, not a filter. Name the delay before anyone else does and move on --
an unexplained two-second gap looks like a fault, a named one looks like
engineering.

**Fallback.** If audio for a chosen language does not arrive, switch that
viewer to the original-language option and to captions and carry on: captions
and audio come down different paths, and a working caption stream over live
audio still shows the pipeline. Do not switch to a Nigerian language to
"prove" it works -- see section 5.

---

### Beat 3 -- The operator console driving it

**Time:** 3-4 minutes.

**Must be true beforehand:** beat 2's programme still running, or restartable.

**What you do.** Stay in the console and walk the rail: **01 Overview** for
service health, **03 Languages** for the source and target choice, **04 Audio &
Voices**, **08 Access**, **09 Preflight**, **10 Live Control**. Show that
programme control is authenticated: an account not on the allowlist is refused,
and an anonymous request to a control route is refused before the console ever
checks whether the session exists.

**What the audience sees.** A production control surface rather than a demo
page: ten numbered pages, health of each service, and an audit-shaped access
model.

**Say this about the reserved pages.** Three pages -- **05 Programme
Vocabulary**, **06 Quality / Delay**, **07 Advertising** -- are reserved and
carry honest "not yet" copy with no controls, and the quality and delay tiles
read `--` rather than a number. That is deliberate: we do not print a
measurement we have not made. Volunteering that, before someone finds it, is
worth more than the page would have been.

**If asked "what would break here".** The honest answer is the one in the
readiness check: media-ingest not connected to the gateway produces captions
and no audio, and that is precisely why the check runs before the demo rather
than during it.

---

### Beat 4 -- C7 Streams, and a channel page

**Time:** 3 minutes.

**Must be true beforehand:** the readiness check found a listed channel with a
handle **and** an avatar, and `/streams/<handle>` served the listener shell.
Note the handle it printed.

**What you do.** Open `<ORIGIN>/` for the C7 site, then `<ORIGIN>/streams/<handle>`.
Show the channel's identity -- name, @handle, avatar, category, live state and
what is on air -- and that the link is a thing a person can say out loud.

**What the audience sees.** A public front door with a shareable, human URL,
and a directory whose rows carry real identity rather than opaque ids. Links
that already exist keep working; the handle is the readable name on top of
them.

**If a provider is slow.** Nothing here depends on a translation vendor. If the
page is slow it is the CDN, and a reload is a fair thing to do on stage.

**Fallback.** If the channel page is empty, show the directory on `/listen/`
instead -- the same rows, one screen earlier.

---

### Beat 5 -- The phone

**Time:** 2 minutes.

**The APK is held to 1 September**, so the phone is shown through the web
surfaces until then, and this must be said rather than glossed. What exists
today, precisely:

* The mobile app's entire server contract is driven and verified by
  `scripts/mobile-contract-acceptance.mjs` -- the same paths, methods, headers,
  bodies and sequencing the app uses.
* A green run of that suite establishes **"server contract ready for mobile"**.
  It does **not** establish "Android client accepted": nothing in it runs the
  APK, so push delivery, ringing on a locked phone, microphone capture and the
  call screen are outside it. Those are the physical device acceptance held to
  1 September.

**What you do.** Show the web surfaces at a phone-shaped window size, and say
the two sentences above. If you want evidence rather than assertion, have a
recent run of the contract suite on screen -- its summary line names the passed,
failed, blocked and skipped counts, and a blocked check fails that run by
design.

**What NOT to say.** Not "the app is done", not "it is in the store", not a
date beyond 1 September that you have not been given. An investor who is told
"held to 1 September" and then sees it on 1 September has learned something
good about the team.

---

## 3. If something breaks mid-demo

| symptom | what it usually is | what to do, and what to say |
| --- | --- | --- |
| A surface loads blank | the bundle was built with the wrong base, or a stale `index.html` was cached | hard-reload once. Move on. This is a FAIL row in the readiness check, so it should never appear -- if it does, run the check afterwards, not now. |
| A fix you deployed has not appeared | the shell was heuristically cached | hard-reload. Do not deploy again mid-demo. |
| The call will not connect across networks | the relay | move to beat 2. Say: *"peer-to-peer did not find a path; the relay covers that case and we check it before we start."* |
| Translated audio never arrives | the chain is stubbed, or the vendor is cold | switch that viewer to captions plus original audio. Say the pipeline is warming. |
| Audio sounds wrong in a Nigerian language | a general vendor is standing in for the specialist | stop playing it. Say the sentence in section 5. This is the one failure you must NOT talk over. |
| The console refuses an account | it is not on the operator allowlist | use the prepared account. Say: *"programme control is allowlisted and fails closed -- an unknown account gets nothing, which is the behaviour we want."* |

---

## 4. What we do not claim

Have these ready, because volunteering a limit is worth more than being caught
at one:

* **The Android APK** is held to 1 September; the server contract is verified,
  the device is not.
* **Programme quality and delay are not yet measured.** The console prints
  `--` rather than a number, on purpose.
* **Several validation tracks are externally deferred** -- third-party platform
  adapters and their staging validations. Deferred is not the same as done, and
  we do not describe them as certified.
* **Commercial product activation** is deliberately unreachable today: it waits
  on full identity verification, and no KYC vendor is chosen. Nothing in the
  demo depends on it.
* **Language quality is claimed per language, from evidence**, never in
  aggregate. See section 5.

---

## 5. Languages we can demonstrate honestly today

**Read this list, do not recite one from memory.** The deployment publishes its
own capability states, and the readiness check reads them:

```bash
node scripts/demo-readiness.mjs https://staging.consummate7.com
# LANGUAGES section: the state tally, the voice-capable list, and the
# Nigerian-language rows, each with the vendor its audio would come from
```

The same data is readable directly:

```bash
curl -s https://staging.consummate7.com/media/languages/catalogue
```

Each language carries one of four states, and the state is the WEAKEST of its
three stages (speech recognition, translation, speech synthesis). The states
are resolved from evidence grades in `services/ai-registry`, not from whether a
request succeeded:

| state | what the evidence is | what you may say on stage |
| --- | --- | --- |
| `qualified` | a live observation names this language on the running chain | demonstrate it, and call it what it is |
| `available` | the vendor's documentation lists it; nothing here has heard it | demonstrate it, and describe it as supported -- not as proven |
| `limited` | a vendor CLAIM only: listed, never exercised here | do not lead with it; if it comes up, say the claim is the vendor's, not ours |
| `unavailable` | no provider on the chain serves it | it is visible in the picker and refuses to be selected. That is deliberate: a language a person cannot find at all looks like a language we have never heard of |

**The plain sentence about the Nigerian languages.** Yoruba, Hausa, Igbo and
Nigerian Pidgin are served by a specialist vendor, 9jaLingo, when it is
configured on the deployment. **With 9jaLingo configured, they are the real
thing** -- a Nigerian-language model, not a multilingual voice guessing.
**Without it, they are a degraded rendering** -- a general vendor returning
confident, fluent, wrongly-pronounced audio at HTTP 200 -- and they must not be
presented as native quality, must be labelled degraded wherever an operator or
a viewer can see them, and are best not played to an audience at all.

The readiness check reports whether the deployment names the specialist. If
that row comes back **BLOCKED**, the deployment does not publish the fact, and
the answer is not to assume:

```bash
ssh c7-claude 'sudo journalctl -u videofy-media-ingest -n 200 --no-pager | grep -i "specialist"'
```

A line reading *"No Nigerian-language specialist configured"* means degraded.
Until you have read that line, treat these four languages as degraded --
because the only signal that would tell you otherwise is a person who speaks
the language, and there is not one in the loop at 200 OK.

**Why we did it this way, if asked.** General vendors return confident, wrong
Yoruba, Hausa and Igbo, and every server-side signal says fine. We found that
by listening rather than by reading status codes, and we built the routing so
the specialist goes in front for exactly those languages, with the general
vendor behind it as a labelled fallback rather than a silent one. That answer
is a better demonstration of engineering judgement than any language sample.

---

## 6. Every URL, in order

Replace `<ORIGIN>` with the origin you checked. Open them in this order before
the audience arrives.

| # | URL | what it is |
| --- | --- | --- |
| 0 | `<ORIGIN>/health` · `<ORIGIN>/media/health` | services, if you want them on a tab |
| 1 | `<ORIGIN>/call/` | create or join a call; Normal vs Translated |
| 2 | `<ORIGIN>/operator/` | the console (hash routes: `#/overview`, `#/source`, `#/languages`, `#/audio`, `#/vocabulary`, `#/quality`, `#/advertising`, `#/access`, `#/preflight`, `#/live`) |
| 3 | `<ORIGIN>/listen/` | the viewer: channel directory, language choice |
| 4 | `<ORIGIN>/` | the C7 site |
| 5 | `<ORIGIN>/streams/<handle>` | the canonical public channel page |
| -- | `<ORIGIN>/media/languages/catalogue` | the capability list, if somebody wants the receipts |

---

## 7. Related documents

* `docs/PRODUCTION_CUTOVER_RUNBOOK.md` -- the production procedure, including
  why an email-verified account reads `verification_required` and can still
  host everything that matters.
* `docs/MOBILE_CONTRACT_ACCEPTANCE.md` -- what a green mobile contract run does
  and does not establish, and why a blocked check fails it.
* `docs/OPERATOR_GUIDE.md` -- the console in depth.
* `docs/LISTENER_GUIDE.md` -- the viewer surface in depth.
