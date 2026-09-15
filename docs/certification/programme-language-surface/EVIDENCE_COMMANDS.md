# Evidence command plan

These commands are reusable collection commands. They are intentionally not run by this framework.
Run them only on the appropriate qualification host with approved credentials already present.
Credential values must not be printed or copied into reports.

## Setup

```bash
mkdir -p /tmp/videofy-programme-language-surface
```

## Registry and current decisions

```bash
npm run test -w packages/translation-routes
node scripts/qualification/programme-language-surface.mjs --check
```

## Machine translation route evidence

All OPUS-MT directions, using the existing deployed-provider benchmark:

```bash
sudo node scripts/certify/opus.mjs --only en-fr,fr-en,en-es,es-en,en-pt,pt-en,en-ha,ha-en,en-ig,ig-en,en-yo,yo-en --out /tmp/videofy-programme-language-surface/opus-all-routes.json
```

Single-direction rerun form:

```bash
sudo node scripts/certify/opus.mjs --only en-fr --out /tmp/videofy-programme-language-surface/opus-en-fr.json
```

Pidgin is intentionally not listed above because both pcm directions are `provider: unassigned` in the route registry. Do not manufacture a pcm MT result until a real translator is named.

## STT evidence for live surfaces

### Google STT configuration and wiring verification

For Hausa, Igbo and Yoruba, treat Google Cloud Speech-to-Text V2 / Chirp as the candidate provider. This is not a live-accuracy qualification and not a production approval. Verify repo-side wiring first:

```bash
node scripts/qualification/programme-language-surface.mjs --check-google-stt-wiring
```

That check must find a language-routed live recognizer, Deepgram as the general/default route, Google STT for `ha-NG`, `ig-NG` and `yo-NG`, explicit refusal of unsupported source languages such as `pcm`, and non-secret configuration names before any live benchmark is commissioned. Google Translation is already integrated separately; do not use that fact as STT evidence.

Read-only server configuration verification, names only and no secrets:

```bash
ssh c7-claude 'cd /srv/videofy-prod/current && git rev-parse HEAD && node scripts/qualification/programme-language-surface.mjs --check-google-stt-wiring && sudo awk -F= '"'"'/^(STREAMING_TRANSCRIPTION_PROVIDER|DEEPGRAM_API_KEY|DEEPGRAM_MODEL|GOOGLE_STT_PROJECT_ID|GOOGLE_STT_LOCATION|GOOGLE_STT_RECOGNIZER|GOOGLE_STT_MODEL|GOOGLE_CLOUD_QUOTA_PROJECT)=/ {print $1"=<set>"}'"'"' /etc/videofy/media-ingest.env'
```

Deepgram support and accuracy collection through the shipped adapter:

```bash
sudo node --env-file=/etc/videofy/media-ingest.env scripts/certify/deepgram.mjs --language-support en,fr,es,pt,pcm --languages en,es --out /tmp/videofy-programme-language-surface/deepgram-live-stt.json
```

Do not read the Deepgram `language-support` result as accuracy. For ha/ig/yo, Deepgram refusal does not close the STT lane because Google STT V2 / Chirp is the candidate. For fr, pt and pcm, add approved spoken fixtures or a candidate decision before marking STT accuracy complete.

## TTS evidence for live surfaces

General TTS vendors, existing corpus only:

```bash
sudo node scripts/certify/tts.mjs --languages en,es,fr --samples 5 --out /tmp/videofy-programme-language-surface/tts-general.json
```

Nigerian specialist TTS:

```bash
sudo node scripts/certify/naijalingo.mjs --languages ha,ig,yo,pcm --samples 5 --json /tmp/videofy-programme-language-surface/naijalingo-tts.json
```

Portuguese TTS remains missing until a Portuguese corpus and selected voice are added to the TTS certification harness.

## End-to-end STT -> translation -> TTS checks

Existing deterministic language-pair verifier, for pairs already covered by source and target voices:

```bash
node scripts/verify-language-pair.mjs en fr
node scripts/verify-language-pair.mjs fr en
node scripts/verify-language-pair.mjs en es
node scripts/verify-language-pair.mjs es en
```

Every other direction needs fixture and voice work before this verifier can prove the route. Do not substitute browser microphone tests for this proof.
