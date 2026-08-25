# Videofy-Live — Subprocessor Register

**Document:** `docs/privacy/SUBPROCESSOR_REGISTER.md`
**Status:** DRAFT — populated from deployed facts, awaiting vendor confirmations
**Version:** 0.1
**Date:** 25 August 2026
**Governing position:** DP-130 (BLOCK RELEASE), DP-131/132/133 (transfers), DP-061 (no training)

> **What this is and is not.** Every row's *technical* fields — what the vendor is, what reaches it, where it processes — were taken from the deployed system and the adapter code, not from memory. Every row's *contractual* fields — DPA status, training permission, breach SLA — are **UNCONFIRMED** and can only be completed by someone with access to the vendor accounts.
>
> An unconfirmed row is not a completed register. DP-130 stays unsatisfied until the contractual columns are filled, and §27 of the positions document is explicit that no blank template may be represented as compliance evidence.

---

## 1. Register

### 1.1 Deepgram — speech recognition

| Field | Value |
|---|---|
| Provider | Deepgram, Inc. |
| Service | Streaming speech-to-text (`nova-3`) |
| Data categories | **Call audio.** No account identifier, address, phone number or participant id — verified in the adapter |
| Purpose | Transcribing speech so it can be translated. Core service function |
| Processing locations | United States (confirm region options) |
| Retention at provider | **UNCONFIRMED** — ask for zero-retention / no-storage mode |
| Content training allowed | **UNCONFIRMED — must be NO.** DP-061 |
| DPA status | **NOT SIGNED** |
| Security review | Not done |
| Breach notification SLA | **UNCONFIRMED** — target ≤ 24 h (DP-142) |
| Nigeria transfer basis | **NOT ESTABLISHED** (DP-131) |
| EU transfer basis | **NOT ESTABLISHED** — SCCs or DPF certification (DP-132) |
| UK transfer basis | **NOT ESTABLISHED** (DP-133) |
| Approval date | — |
| Owner | Zoe |

### 1.2 ElevenLabs — speech synthesis and personal voice

| Field | Value |
|---|---|
| Provider | ElevenLabs, Inc. |
| Service | Text-to-speech; **personal voice synthesis (DP-055)** |
| Data categories | Translated text; **enrolment audio**; **derived voice models** |
| Purpose | Speaking the translation, optionally in the speaker's own voice |
| Processing locations | United States (confirm) |
| Retention at provider | **UNCONFIRMED.** Voice models persist at the provider by design — see the deletion requirement below |
| Content training allowed | **UNCONFIRMED — must be NO.** DP-061, DP-160 |
| DPA status | **NOT SIGNED** |
| Security review | Not done |
| Breach notification SLA | **UNCONFIRMED** |
| Nigeria transfer basis | **NOT ESTABLISHED** |
| EU transfer basis | **NOT ESTABLISHED** |
| UK transfer basis | **NOT ESTABLISHED** |
| Approval date | — |
| Owner | Zoe |

> **The highest-risk row in this register.** This is the only vendor that holds a *derived model of a person's voice* rather than transient content, and it is the only one where deletion has to be proven rather than assumed. DP-055.5 requires that account closure or consent withdrawal deletes the model **at ElevenLabs**, tested end to end. Until that test exists, an erasure request cannot be honestly answered.

### 1.3 Cloudflare — edge, DNS, TLS

| Field | Value |
|---|---|
| Provider | Cloudflare, Inc. |
| Service | DNS, TLS termination, proxy/CDN |
| Data categories | IP addresses, request metadata, TLS-terminated traffic |
| Purpose | Availability, TLS, abuse resistance |
| Processing locations | Global edge |
| Retention at provider | Per Cloudflare policy — **UNCONFIRMED** |
| Content training allowed | N/A |
| DPA status | **UNCONFIRMED** — Cloudflare publishes a standard DPA requiring acceptance |
| Breach notification SLA | Per DPA |
| Transfer bases | **NOT ESTABLISHED** |
| Owner | Zoe |

### 1.4 Contabo — hosting

| Field | Value |
|---|---|
| Provider | Contabo GmbH |
| Service | Virtual private server `c7-eu-01`; hosts the application **and the PostgreSQL database** |
| Data categories | Everything the service persists: accounts, credentials (hashed), organizations, memberships, invitations, security logs, **local database backups** |
| Purpose | Running the service |
| Processing locations | **European Union** |
| Retention at provider | Under Videofy's control; backups local to the same disk |
| Content training allowed | N/A |
| DPA status | **UNCONFIRMED** |
| Breach notification SLA | **UNCONFIRMED** |
| Nigeria transfer basis | **NOT ESTABLISHED** — Nigerian personal data is hosted in the EU (DP-131) |
| EU transfer basis | N/A — processing is in the EEA |
| Owner | Zoe |

### 1.5 Resend (Amazon SES) — transactional email

| Field | Value |
|---|---|
| Provider | Resend, using Amazon SES |
| Service | Email verification and password-reset delivery |
| Data categories | Recipient email address; message body containing a one-time link |
| Purpose | Proving control of an address; account recovery |
| Processing locations | **`eu-west-1` (Ireland)** — intra-EEA |
| Retention at provider | Delivery logs — **UNCONFIRMED** |
| Content training allowed | N/A |
| DPA status | **UNCONFIRMED** |
| Breach notification SLA | **UNCONFIRMED** |
| Nigeria transfer basis | **NOT ESTABLISHED** |
| EU transfer basis | N/A — intra-EEA, which is why this vendor is the lowest-risk row here |
| Owner | Zoe |

---

## 2. What only the account holder can complete

Each of these needs someone signed in to the vendor's dashboard or contracting portal. None can be established from the codebase.

| # | Action | Vendor | Why it is BLOCK RELEASE |
|---|---|---|---|
| 1 | Accept/sign the DPA | All five | DP-130; a processor without a DPA is an undocumented processor |
| 2 | Turn **off** any content-training or model-improvement setting, and get it in writing | Deepgram, ElevenLabs | DP-061 is PROHIBITED by default; "provider contract permits private-content training" is an explicit release blocker |
| 3 | Confirm zero-retention / no-storage mode | Deepgram | Minimises what a provider breach could expose |
| 4 | Confirm whether an **EU processing region** is available | Deepgram, ElevenLabs | Using one would remove the largest transfer question in this register outright, and is worth real money |
| 5 | Establish the transfer mechanism | All non-EEA | SCCs, or DPF certification where the vendor holds it |
| 6 | Confirm breach notification terms | All five | DP-142 targets ≤ 24 h to Videofy |

---

## 3. Change control

A new production vendor that receives personal data is a **Class B** change under §25 and requires a privacy review *before* code that sends it data is merged. Adding a row here after deployment is not compliance; it is a record of a gap.

Removing a vendor requires confirming deletion of anything it holds, including derived artefacts such as voice models.
