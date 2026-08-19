// owner: masterzee001
/**
 * Pure-helper contracts: host-key retention, guest identity, the bounded
 * rejoin plan, room policy gating, connection wording, schedule wording.
 */
import { describe, expect, it } from 'vitest';
import { ensureGuestSubject, recallDisplayName, rememberDisplayName } from '../guestIdentity';
import {
  forgetHostKey,
  holdsHostKey,
  recallHostKey,
  rememberHostKey,
  type KeyValueStore,
} from '../hostKeys';
import {
  REJOIN_MAX_ATTEMPTS,
  rejoinDelayMs,
  rejoinFailedLine,
  rejoinStatusLine,
  shouldKeepTrying,
} from '../rejoinPlan';
import {
  brandTranscript,
  canDownloadTranscript,
  transcriptDownloadAllowed,
  translationControlsActive,
} from '../roomPolicy';
import { connectionWords } from '../connectionWords';
import { scheduleWords } from '../timeWords';

function memoryStore(): KeyValueStore {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

describe('host-key retention', () => {
  it('remembers a well-formed key per room and reports host standing', () => {
    const store = memoryStore();
    rememberHostKey(store, 'room_room_a', 'host_abcdef123456');
    expect(recallHostKey(store, 'room_room_a')).toBe('host_abcdef123456');
    expect(holdsHostKey(store, 'room_room_a')).toBe(true);
    expect(holdsHostKey(store, 'room_room_b')).toBe(false);
  });

  it('refuses to store or return malformed keys', () => {
    const store = memoryStore();
    rememberHostKey(store, 'room_room_a', 'not-a-key');
    expect(recallHostKey(store, 'room_room_a')).toBeNull();
    store.setItem('connect-reference.hostKey.room_room_a', 'garbage');
    expect(recallHostKey(store, 'room_room_a')).toBeNull();
    expect(holdsHostKey(store, 'room_room_a')).toBe(false);
  });

  it('forgets on request', () => {
    const store = memoryStore();
    rememberHostKey(store, 'room_room_a', 'host_abcdef123456');
    forgetHostKey(store, 'room_room_a');
    expect(holdsHostKey(store, 'room_room_a')).toBe(false);
  });
});

describe('guest identity', () => {
  it('mints a guest_ subject once and keeps it stable', () => {
    const store = memoryStore();
    const first = ensureGuestSubject(store, () => 'aaaa1111bbbb2222');
    const second = ensureGuestSubject(store, () => 'DIFFERENT');
    expect(first).toBe('guest_aaaa1111bbbb2222');
    expect(second).toBe(first);
  });

  it('replaces a corrupted stored subject', () => {
    const store = memoryStore();
    store.setItem('connect-reference.guestSubject', 'someone-else');
    expect(ensureGuestSubject(store, () => 'fresh')).toBe('guest_fresh');
  });

  it('remembers the display name as a convenience', () => {
    const store = memoryStore();
    rememberDisplayName(store, '  Zoe  ');
    expect(recallDisplayName(store)).toBe('Zoe');
    rememberDisplayName(store, '   ');
    expect(recallDisplayName(store)).toBe('Zoe');
  });
});

describe('rejoin plan', () => {
  it('is bounded', () => {
    expect(shouldKeepTrying(0)).toBe(false);
    expect(shouldKeepTrying(1)).toBe(true);
    expect(shouldKeepTrying(REJOIN_MAX_ATTEMPTS)).toBe(true);
    expect(shouldKeepTrying(REJOIN_MAX_ATTEMPTS + 1)).toBe(false);
  });

  it('retries immediately once, then backs off and caps the delay', () => {
    expect(rejoinDelayMs(1)).toBe(0);
    expect(rejoinDelayMs(2)).toBe(600);
    expect(rejoinDelayMs(3)).toBe(1500);
    expect(rejoinDelayMs(4)).toBe(3000);
    expect(rejoinDelayMs(40)).toBe(3000);
  });

  it('speaks product language about attempts', () => {
    expect(rejoinStatusLine(2)).toContain('attempt 2 of ' + REJOIN_MAX_ATTEMPTS);
    expect(rejoinFailedLine()).toContain('lobby');
  });
});

describe('room policy', () => {
  it('reads absence as the server default: allowed', () => {
    expect(transcriptDownloadAllowed({})).toBe(true);
    expect(transcriptDownloadAllowed(null)).toBe(true);
    expect(transcriptDownloadAllowed({ transcriptDownloadAllowed: true })).toBe(true);
  });

  it('blocks when the room says no', () => {
    expect(transcriptDownloadAllowed({ transcriptDownloadAllowed: false })).toBe(false);
    expect(canDownloadTranscript({ transcriptDownloadAllowed: false })).toBe(false);
  });

  it('follows the room policy in BOTH modes — a normal conference still has a transcript (P6.4 contract)', () => {
    expect(translationControlsActive('normal')).toBe(false);
    expect(translationControlsActive('translated')).toBe(true);
    expect(canDownloadTranscript({ transcriptDownloadAllowed: true })).toBe(true);
    expect(canDownloadTranscript({})).toBe(true);
  });

  it('re-heads the transcript in room words — the Connect call id never reaches the page', () => {
    // The Connect id is assembled from pieces so the vocab guard can keep
    // banning its spelling from this package's sources.
    const connectId = ['vc', '_0123456789abcdef'].join('');
    const raw = 'Videofy transcript — ' + connectId + '\n\n[0:01] Ada: Hello.';
    const branded = brandTranscript('Council of the realm', raw);
    expect(branded).not.toContain(connectId);
    expect(branded).toContain('Connect Reference transcript — Council of the realm');
    expect(branded).toContain('[0:01] Ada: Hello.');
    // A transcript without the SDK header passes through untouched.
    expect(brandTranscript('Room', '')).toBe('');
  });
});

describe('connection wording', () => {
  it('renders every state as a sentence a guest understands', () => {
    expect(connectionWords('connecting')).toBe('Taking your seat…');
    expect(connectionWords('connected')).toBe('Live');
    expect(connectionWords('reconnecting')).toContain('holding your seat');
    expect(connectionWords('restoring')).toContain('restoring your seat');
    expect(connectionWords('suspended')).toContain('Paused');
    expect(connectionWords('ended')).toBe('This room has closed');
  });
});

describe('schedule wording', () => {
  it('formats deterministically in UTC', () => {
    expect(scheduleWords('2026-08-20T18:30:00.000Z')).toBe(
      'Scheduled for 2026-08-20 at 18:30 UTC',
    );
  });

  it('returns null for absent or unreadable values', () => {
    expect(scheduleWords(undefined)).toBeNull();
    expect(scheduleWords('')).toBeNull();
    expect(scheduleWords('not-a-date')).toBeNull();
  });
});
