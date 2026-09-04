/** @author masterzee001 */
/**
 * One session, one revision — and language scoping per consumer.
 *
 * Both invariants exist because they are hard to retrofit once CRUD and a UI
 * are on top, and because both failures are invisible: an internally
 * inconsistent programme reports nothing, and a Portuguese term leaking into
 * English recognition just looks like a bad recogniser.
 */
import { describe, expect, it } from 'vitest';
import {
  createRevisionedInMemoryPort,
  snapshotIsCurrent,
  takeSnapshot,
  type SessionLanguages,
} from './snapshot.js';
import type { VocabularyRecord } from './store.js';

function record(over: Partial<VocabularyRecord> = {}): VocabularyRecord {
  return {
    programmeId: 'prog_A', id: 'v1', term: 'Adéyẹmí', canonicalRendering: '',
    language: '*', pronunciationHint: '', doNotTranslate: false, sttKeyterm: false,
    kind: 'person', notes: '', enabled: true, updatedAt: '2026-09-01T00:00:00Z',
    ...over,
  };
}

const CAPS = { sttKeyterms: true, pronunciationHints: true };
const EN_TO_PT: SessionLanguages = { sourceLanguage: 'en', targetLanguage: 'pt' };

describe('a session consumes ONE revision', () => {
  it('gives every consumer the same revision from one read', async () => {
    const port = createRevisionedInMemoryPort([
      record({ id: 'a', term: 'Adéyẹmí', doNotTranslate: true, sttKeyterm: true,
               canonicalRendering: 'Adeyemi' }),
    ]);
    const snap = await takeSnapshot(port, 'prog_A', EN_TO_PT, CAPS);
    expect(snap.revision).toBe(1);
    expect(snap.programmeId).toBe('prog_A');
    // Both consumers came from the same snapshot object, so they cannot differ.
    expect(snap.sttKeyterms).toContain('Adéyẹmí');
    expect(snap.doNotTranslate).toContain('Adéyẹmí');
  });

  it('an edit does NOT mutate a snapshot already taken', async () => {
    const port = createRevisionedInMemoryPort([
      record({ id: 'a', term: 'Adéyẹmí', doNotTranslate: true }),
    ]);
    const snap = await takeSnapshot(port, 'prog_A', EN_TO_PT, CAPS);

    await port.upsert(record({ id: 'b', term: 'Chinelo', doNotTranslate: true }));

    // The running session keeps what it started with. The alternative -- half
    // the consumers silently refreshing -- is the internally inconsistent
    // programme this whole file exists to prevent.
    expect(snap.doNotTranslate).toEqual(['Adéyẹmí']);
    expect(snap.revision).toBe(1);
  });

  it('reports that the edit applies to the NEXT session, not this one', async () => {
    const port = createRevisionedInMemoryPort([record({ id: 'a', doNotTranslate: true })]);
    const snap = await takeSnapshot(port, 'prog_A', EN_TO_PT, CAPS);

    expect(await snapshotIsCurrent(port, snap)).toMatchObject({
      current: true, appliesFrom: 'this-session',
    });

    await port.upsert(record({ id: 'b', term: 'Chinelo', doNotTranslate: true }));

    expect(await snapshotIsCurrent(port, snap)).toMatchObject({
      current: false, storedRevision: 2, appliesFrom: 'next-session',
    });
  });

  it('a NEW session picks the edit up', async () => {
    const port = createRevisionedInMemoryPort([record({ id: 'a', doNotTranslate: true })]);
    await takeSnapshot(port, 'prog_A', EN_TO_PT, CAPS);
    await port.upsert(record({ id: 'b', term: 'Chinelo', doNotTranslate: true }));

    const next = await takeSnapshot(port, 'prog_A', EN_TO_PT, CAPS);
    expect(next.revision).toBe(2);
    expect(next.doNotTranslate).toContain('Chinelo');
  });

  it('a no-op delete does not move the revision', async () => {
    // Bumping on a delete that removed nothing would tell every running session
    // it is stale, for no change at all.
    const port = createRevisionedInMemoryPort([record({ id: 'a' })]);
    const before = await port.revision('prog_A');
    expect(await port.remove('prog_A', 'does-not-exist')).toBe(false);
    expect(await port.revision('prog_A')).toBe(before);
  });

  it('revisions are per programme, not global', async () => {
    const port = createRevisionedInMemoryPort([
      record({ programmeId: 'prog_A', id: 'a' }),
      record({ programmeId: 'prog_B', id: 'b' }),
    ]);
    await port.upsert(record({ programmeId: 'prog_A', id: 'a2' }));
    // B's sessions must not be told they are stale because A was edited.
    expect(await port.revision('prog_B')).toBe(1);
    expect(await port.revision('prog_A')).toBe(2);
  });
});

describe('language scope per consumer', () => {
  it('a Portuguese term does not reach English recognition', async () => {
    const port = createRevisionedInMemoryPort([
      record({ id: 'pt', term: 'saudação', language: 'pt', sttKeyterm: true }),
      record({ id: 'en', term: 'Consummate 7', language: 'en', sttKeyterm: true }),
    ]);
    const snap = await takeSnapshot(port, 'prog_A', EN_TO_PT, CAPS);

    // The recogniser hears the SOURCE. Offering it a Portuguese-only term
    // merely because the programme also outputs Portuguese is the leak.
    expect(snap.sttKeyterms).toEqual(['Consummate 7']);
    expect(snap.sttKeyterms).not.toContain('saudação');
  });

  it('a canonical rendering applies to the TARGET language only', async () => {
    const port = createRevisionedInMemoryPort([
      record({ id: 'pt', term: 'Lagos', language: 'pt', canonicalRendering: 'Lagos' }),
      record({ id: 'fr', term: 'Lagos', language: 'fr', canonicalRendering: 'Lagos (FR)' }),
    ]);
    const snap = await takeSnapshot(port, 'prog_A', EN_TO_PT, CAPS);
    expect(snap.canonical.get('Lagos')).toBe('Lagos');
    expect([...snap.canonical.values()]).not.toContain('Lagos (FR)');
  });

  it('a pronunciation hint follows the TARGET voice, not every route', async () => {
    const port = createRevisionedInMemoryPort([
      record({ id: 'pt', term: 'Adéyẹmí', language: 'pt', pronunciationHint: 'a-de-YEH-mi' }),
      record({ id: 'yo', term: 'Adéyẹmí', language: 'yo', pronunciationHint: 'ah-DEH-yeh-mee' }),
    ]);
    const snap = await takeSnapshot(port, 'prog_A', EN_TO_PT, CAPS);
    expect(snap.pronunciation.get('Adéyẹmí')).toBe('a-de-YEH-mi');
  });

  it('a * term reaches both sides', async () => {
    const port = createRevisionedInMemoryPort([
      record({ id: 'any', term: 'Consummate 7', language: '*',
               doNotTranslate: true, sttKeyterm: true }),
    ]);
    const snap = await takeSnapshot(port, 'prog_A', EN_TO_PT, CAPS);
    expect(snap.sttKeyterms).toContain('Consummate 7');
    expect(snap.doNotTranslate).toContain('Consummate 7');
  });

  it('do-not-translate spans the direction, so a target-tagged name is still protected', async () => {
    const port = createRevisionedInMemoryPort([
      record({ id: 'pt', term: 'Adéyẹmí', language: 'pt', doNotTranslate: true }),
    ]);
    const snap = await takeSnapshot(port, 'prog_A', EN_TO_PT, CAPS);
    // The name must survive whether it appears in the English source or is
    // expected in the Portuguese output.
    expect(snap.doNotTranslate).toContain('Adéyẹmí');
  });

  it('an unrelated language contaminates nothing', async () => {
    const port = createRevisionedInMemoryPort([
      record({ id: 'yo', term: 'Ọ̀gbẹ́ni', language: 'yo',
               doNotTranslate: true, sttKeyterm: true, pronunciationHint: 'aw-BEH-ni' }),
    ]);
    const snap = await takeSnapshot(port, 'prog_A', EN_TO_PT, CAPS);
    expect(snap.sttKeyterms).toEqual([]);
    expect(snap.doNotTranslate).toEqual([]);
    expect(snap.pronunciation.size).toBe(0);
  });
});

describe('programme scope still holds', () => {
  it('refuses a snapshot with no programme', async () => {
    const port = createRevisionedInMemoryPort([record()]);
    await expect(takeSnapshot(port, '  ', EN_TO_PT, CAPS)).rejects.toThrow(/programmeId/);
  });

  it("does not take another programme's terms", async () => {
    const port = createRevisionedInMemoryPort([
      record({ programmeId: 'prog_A', id: 'a', doNotTranslate: true, sttKeyterm: true }),
    ]);
    const snap = await takeSnapshot(port, 'prog_B', EN_TO_PT, CAPS);
    expect(snap.doNotTranslate).toEqual([]);
    expect(snap.sttKeyterms).toEqual([]);
    expect(snap.revision).toBe(0);
  });
});
