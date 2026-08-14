# ADR-007 — Training-data consent and provenance

Repository owner: masterzee001

**Status:** Accepted  
**Covers:** ADR-016, ADR-017

Dataset and model lineage is mandatory. Each dataset version records source and rights, consent basis where applicable, allowed purposes, commercial-training permission, personal-data status, retention policy, hash manifest and training approval.

Customer communications and personal-voice enrollment are not training data by default. Service consent and training consent are separate; any contribution requires separate, explicit, revocable rights/consent and technical separation from normal communications. Raw audio, reusable embeddings and secrets do not enter ordinary logs.

See [native-model lineage](008-videofy-native-model-lineage.md).
