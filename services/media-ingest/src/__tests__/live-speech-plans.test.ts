/**
 * Speech plans are looked up PER SESSION.
 *
 * `liveSpeechPlansFor` used to read `currentSession` -- a single slot holding
 * whichever session last changed state. That is coherent for the programme
 * path, where one stream is processed at a time. A call has one session PER
 * PARTICIPANT, so at most one could ever match and the other silently got no
 * plans: no translation pipeline was built for it and nothing was synthesised.
 * Captions still arrived, because they travel a different path, which made a
 * lookup bug look like a synthesis bug.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProcessingSessionStore } from '../media-session.js';

function store(): ProcessingSessionStore {
  const root = mkdtempSync(join(tmpdir(), 'live-plans-'));
  return new ProcessingSessionStore({
    outputBaseDir: join(root, 'out'),
    webRtcStagingDir: join(root, 'staging'),
    translationSupportedTargetLanguages: ['fr', 'es'],
    textToSpeechSupportedLanguages: ['fr', 'es'],
  });
}

describe('per-session lookup for speech plans', () => {
  let sessions: ReturnType<typeof store>;

  beforeEach(() => {
    sessions = store();
  });

  it('PIN: BOTH participants of a call are retrievable, with their own targets', async () => {
    // The exact shape a call creates: two sessions, live at the same time.
    const first = await sessions.createMediaSession({
      sessionId: 'call_demo_participant_1_r1',
      broadcastId: 'callcast_demo_participant_1_r1',
      broadcasterPeerId: 'peer_backend_media',
      revision: 1,
      targetLanguage: 'fr',
      targetLanguages: ['fr'],
      sourceLanguage: 'en',
      sourceLanguageMode: 'manual',
    });
    const second = await sessions.createMediaSession({
      sessionId: 'call_demo_participant_2_r1',
      broadcastId: 'callcast_demo_participant_2_r1',
      broadcasterPeerId: 'peer_backend_media',
      revision: 1,
      targetLanguage: 'es',
      targetLanguages: ['es'],
      sourceLanguage: 'fr',
      sourceLanguageMode: 'manual',
    });

    // Creating the second must not make the first unreachable. Reading a
    // single "current session" is exactly what did.
    expect(sessions.get(first.id)?.targetLanguages).toEqual(['fr']);
    expect(sessions.get(second.id)?.targetLanguages).toEqual(['es']);
  });

  it('answers null for a session that does not exist', () => {
    expect(sessions.get('call_nope_participant_9_r1')).toBeNull();
  });
});
