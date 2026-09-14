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

Deepgram support and accuracy collection through the shipped adapter:

```bash
sudo node --env-file=/etc/videofy/media-ingest.env scripts/certify/deepgram.mjs --language-support en,fr,es,pt,ha,ig,yo,pcm --languages en,es,yo --out /tmp/videofy-programme-language-surface/deepgram-live-stt.json
```

Do not read the `language-support` result as accuracy. For fr, pt, ha, ig and pcm, add approved spoken fixtures before marking STT accuracy complete.

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
