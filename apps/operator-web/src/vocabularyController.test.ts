/** @author masterzee001 */
/**
 * What the console actually SENDS — the half markup cannot show.
 *
 * Every assertion here is about a request: the revision on a save, the absence
 * of a second attempt after a conflict, a reload being a real GET rather than a
 * number changed locally. The client is injected and records each call, so the
 * tests check what reached the server rather than what the controller believes.
 */
import { describe, expect, it } from 'vitest';
import { createVocabularyController, type VocabularyState } from './vocabularyController';
import {
  VocabularyUnavailableError,
  type SaveOutcome,
  type VocabularyEntryDto,
} from './vocabularyClient';

const CAPS = {
  sttKeyterms: true, sttRouteName: 'deepgram-nova nova-3',
  pronunciationHints: false, synthesisRouteName: 'chain',
};

function entry(over: Partial<VocabularyEntryDto> = {}): VocabularyEntryDto {
  return {
    id: 'lagos', term: 'Lagos', canonicalRendering: '', language: '*',
    pronunciationHint: '', doNotTranslate: true, sttKeyterm: false,
    kind: 'place', notes: '', enabled: true, ...over,
  };
}

function fakeClient(options: {
  unavailable?: boolean;
  conflict?: { expectedRevision: number; currentRevision: number };
} = {}) {
  const calls: { op: string; expectedRevision?: number }[] = [];
  let revision = 5;
  let entries: VocabularyEntryDto[] = [];

  return {
    calls,
    advanceServerSide: (to: number) => { revision = to; },
    client: {
      async fetchVocabulary(_u: string, programmeId: string) {
        calls.push({ op: 'GET' });
        if (options.unavailable) throw new VocabularyUnavailableError();
        return { programmeId, revision, entries };
      },
      async fetchVocabularyCapabilities() {
        calls.push({ op: 'GET-capabilities' });
        return CAPS;
      },
      async saveVocabularyEntry(
        _u: string, _p: string, e: VocabularyEntryDto, expectedRevision: number,
      ): Promise<SaveOutcome> {
        calls.push({ op: 'PUT', expectedRevision });
        if (options.conflict) return { ok: false, conflict: options.conflict };
        entries = [...entries.filter((x) => x.id !== e.id), e];
        revision += 1;
        return { ok: true, revision };
      },
      async deleteVocabularyEntry(
        _u: string, _p: string, entryId: string, expectedRevision: number,
      ): Promise<SaveOutcome> {
        calls.push({ op: 'DELETE', expectedRevision });
        if (options.conflict) return { ok: false, conflict: options.conflict };
        entries = entries.filter((x) => x.id !== entryId);
        revision += 1;
        return { ok: true, revision };
      },
    } as never,
  };
}

function controllerFor(fake: ReturnType<typeof fakeClient>, programmeId: string | null = 'prog_A') {
  const states: VocabularyState[] = [];
  const controller = createVocabularyController({
    accountUrl: 'http://account.test',
    ingestUrl: 'http://ingest.test',
    programmeId,
    onState: (s) => states.push(s),
    client: fake.client,
  });
  return { controller, states, latest: () => controller.state() };
}

const GETS = (fake: ReturnType<typeof fakeClient>) =>
  fake.calls.filter((c) => c.op === 'GET').length;

describe('load performs a real GET', () => {
  it('shows what the server returned', async () => {
    const fake = fakeClient();
    const c = controllerFor(fake);
    await c.controller.reload();
    expect(GETS(fake)).toBe(1);
    expect(c.latest().snapshot?.revision).toBe(5);
    expect(c.latest().loading).toBe(false);
  });

  it('takes the capability from the SERVICE, not from the browser', async () => {
    const fake = fakeClient();
    const c = controllerFor(fake);
    await c.controller.reload();
    expect(fake.calls.some((x) => x.op === 'GET-capabilities')).toBe(true);
    expect(c.latest().snapshot?.capabilities.sttRouteName).toBe('deepgram-nova nova-3');
  });

  it('a 404 means the capability is absent, not a failed request', async () => {
    const fake = fakeClient({ unavailable: true });
    const c = controllerFor(fake);
    await c.controller.reload();
    expect(c.latest().unavailable).toBe(true);
    expect(c.latest().error).toBeNull();
    expect(c.latest().snapshot).toBeNull();
  });

  it('no programme means no request at all', async () => {
    const fake = fakeClient();
    const c = controllerFor(fake, null);
    await c.controller.reload();
    expect(fake.calls).toHaveLength(0);
  });
});

describe('a mutation carries the revision that was on screen', () => {
  it('save sends it', async () => {
    const fake = fakeClient();
    const c = controllerFor(fake);
    await c.controller.reload();
    await c.controller.save(entry(), c.latest().snapshot!.revision);
    expect(fake.calls.find((x) => x.op === 'PUT')?.expectedRevision).toBe(5);
  });

  it('delete sends it too', async () => {
    const fake = fakeClient();
    const c = controllerFor(fake);
    await c.controller.reload();
    await c.controller.remove('lagos', c.latest().snapshot!.revision);
    expect(fake.calls.find((x) => x.op === 'DELETE')?.expectedRevision).toBe(5);
  });

  it('adopts authoritative state by RE-READING, not by patching locally', async () => {
    // The returned revision is not the whole truth: the authoritative snapshot
    // may carry somebody else's entries too.
    const fake = fakeClient();
    const c = controllerFor(fake);
    await c.controller.reload();
    const before = GETS(fake);
    await c.controller.save(entry(), 5);
    expect(GETS(fake)).toBe(before + 1);
    expect(c.latest().snapshot?.revision).toBe(6);
    expect(c.latest().saving).toBe(false);
  });
});

describe('a 409 is an answer, never a retry', () => {
  const CONFLICT = { expectedRevision: 5, currentRevision: 9 };

  it('sets conflict and attempts the save exactly ONCE', async () => {
    const fake = fakeClient({ conflict: CONFLICT });
    const c = controllerFor(fake);
    await c.controller.reload();
    await c.controller.save(entry(), 5);

    expect(c.latest().conflict).toEqual(CONFLICT);
    // A second PUT would be the console resolving the conflict by overwriting.
    expect(fake.calls.filter((x) => x.op === 'PUT')).toHaveLength(1);
    expect(c.latest().saving).toBe(false);
  });

  it('does not re-read, so the operator still sees what they were editing', async () => {
    const fake = fakeClient({ conflict: CONFLICT });
    const c = controllerFor(fake);
    await c.controller.reload();
    const before = GETS(fake);
    await c.controller.save(entry(), 5);
    expect(GETS(fake)).toBe(before);
  });

  it('RELOAD is a real GET, and the new revision comes from it', async () => {
    const fake = fakeClient({ conflict: CONFLICT });
    const c = controllerFor(fake);
    await c.controller.reload();
    await c.controller.save(entry(), 5);
    expect(c.latest().conflict).not.toBeNull();

    fake.advanceServerSide(9);
    const before = GETS(fake);
    await c.controller.reload();

    expect(GETS(fake)).toBe(before + 1);
    expect(c.latest().conflict).toBeNull();
    // 9 came from the server, not from the conflict payload.
    expect(c.latest().snapshot?.revision).toBe(9);
  });

  it('a delete conflict behaves identically', async () => {
    const fake = fakeClient({ conflict: CONFLICT });
    const c = controllerFor(fake);
    await c.controller.reload();
    await c.controller.remove('lagos', 5);
    expect(c.latest().conflict).toEqual(CONFLICT);
    expect(fake.calls.filter((x) => x.op === 'DELETE')).toHaveLength(1);
  });

  it('a subsequent successful save clears the conflict', async () => {
    const fake = fakeClient();
    const c = controllerFor(fake);
    await c.controller.reload();
    await c.controller.save(entry(), 5);
    expect(c.latest().conflict).toBeNull();
  });
});
