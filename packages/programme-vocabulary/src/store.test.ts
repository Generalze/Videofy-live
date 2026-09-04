/** @author masterzee001 */
/**
 * Programme isolation, and honest consumer states.
 *
 * The isolation test is the important one. "The console only shows you yours"
 * is a statement about a screen; this is the statement about the data, and it
 * is the one that holds when a consumer forgets to filter.
 */
import { describe, expect, it } from 'vitest';
import {
  consumptionForProgramme,
  createInMemoryVocabularyPort,
  describeFieldStates,
  type VocabularyRecord,
} from './store.js';

function record(over: Partial<VocabularyRecord> = {}): VocabularyRecord {
  return {
    programmeId: 'prog_A', id: 'v1', term: 'Adebayo', canonicalRendering: '',
    language: '*', pronunciationHint: '', doNotTranslate: false, sttKeyterm: false,
    kind: 'person', notes: '', enabled: true, updatedAt: '2026-09-01T00:00:00Z',
    ...over,
  };
}

const CAPS = { sttKeyterms: true, pronunciationHints: false };

describe('programme isolation is a data rule, not a UI filter', () => {
  it("programme B does not inherit programme A's vocabulary", async () => {
    const port = createInMemoryVocabularyPort([
      record({ programmeId: 'prog_A', id: 'a1', term: 'Ọ̀gbẹ́ni Adéyẹmí',
               doNotTranslate: true, sttKeyterm: true }),
    ]);

    const a = await consumptionForProgramme(port, 'prog_A', 'yo', CAPS);
    expect(a.doNotTranslate).toEqual(['Ọ̀gbẹ́ni Adéyẹmí']);
    expect(a.sttKeyterms).toEqual(['Ọ̀gbẹ́ni Adéyẹmí']);

    // The assertion that matters. B configured nothing and must receive
    // nothing -- not A's protected term, not A's keyterm.
    const b = await consumptionForProgramme(port, 'prog_B', 'yo', CAPS);
    expect(b.doNotTranslate).toEqual([]);
    expect(b.sttKeyterms).toEqual([]);
    expect(b.canonical.size).toBe(0);
  });

  it('keeps two programmes separate when both have terms', async () => {
    const port = createInMemoryVocabularyPort([
      record({ programmeId: 'prog_A', id: 'a1', term: 'Adéyẹmí', doNotTranslate: true }),
      record({ programmeId: 'prog_B', id: 'b1', term: 'Chinelo', doNotTranslate: true }),
    ]);
    expect((await consumptionForProgramme(port, 'prog_A', 'yo', CAPS)).doNotTranslate)
      .toEqual(['Adéyẹmí']);
    expect((await consumptionForProgramme(port, 'prog_B', 'ig', CAPS)).doNotTranslate)
      .toEqual(['Chinelo']);
  });

  it('removing a term from one programme leaves the other untouched', async () => {
    const port = createInMemoryVocabularyPort([
      record({ programmeId: 'prog_A', id: 'shared-id', term: 'Adéyẹmí', doNotTranslate: true }),
      record({ programmeId: 'prog_B', id: 'shared-id', term: 'Chinelo', doNotTranslate: true }),
    ]);
    // The same id in two programmes is a realistic accident, and deleting by id
    // alone would take both.
    await port.remove('prog_A', 'shared-id');
    expect((await consumptionForProgramme(port, 'prog_A', 'yo', CAPS)).doNotTranslate).toEqual([]);
    expect((await consumptionForProgramme(port, 'prog_B', 'ig', CAPS)).doNotTranslate)
      .toEqual(['Chinelo']);
  });

  it('refuses an empty programme id rather than guessing', async () => {
    const port = createInMemoryVocabularyPort([record({ doNotTranslate: true })]);
    await expect(consumptionForProgramme(port, '', 'yo', CAPS)).rejects.toThrow(/programmeId/);
    await expect(consumptionForProgramme(port, '  ', 'yo', CAPS)).rejects.toThrow(/programmeId/);
  });
});

describe('persistence round trip', () => {
  it('reads back what was written, scoped to its programme', async () => {
    const port = createInMemoryVocabularyPort();
    await port.upsert(record({ programmeId: 'prog_A', id: 'x', term: 'Abéòkúta',
                               canonicalRendering: 'Abeokuta' }));
    const back = await port.list('prog_A');
    expect(back).toHaveLength(1);
    expect(back[0]?.canonicalRendering).toBe('Abeokuta');
    expect(await port.list('prog_B')).toEqual([]);
  });

  it('updates in place rather than duplicating', async () => {
    const port = createInMemoryVocabularyPort();
    await port.upsert(record({ id: 'x', term: 'Lagos' }));
    await port.upsert(record({ id: 'x', term: 'Lagos', canonicalRendering: 'Èkó' }));
    const back = await port.list('prog_A');
    expect(back).toHaveLength(1);
    expect(back[0]?.canonicalRendering).toBe('Èkó');
  });
});

describe('consumer state is observed, never assumed', () => {
  it('never reports "active" merely because a record was saved', () => {
    const states = describeFieldStates(record({ sttKeyterm: true }), CAPS);
    expect(Object.values(states)).not.toContain('active');
  });

  it('reports unsupported when the provider has no such mechanism', () => {
    const states = describeFieldStates(
      record({ pronunciationHint: 'ah-day-BAH-yo' }),
      { sttKeyterms: true, pronunciationHints: false },
    );
    expect(states.pronunciationHint).toBe('unsupported');
  });

  it('reports consumed when the provider does support it', () => {
    const states = describeFieldStates(
      record({ pronunciationHint: 'ah-day-BAH-yo', sttKeyterm: true }),
      { sttKeyterms: true, pronunciationHints: true },
    );
    expect(states.pronunciationHint).toBe('consumed');
    expect(states.sttKeyterm).toBe('consumed');
  });

  it('reports unconsumed for a field the operator left unset', () => {
    expect(describeFieldStates(record(), CAPS).doNotTranslate).toBe('unconsumed');
  });

  it('a disabled term consumes nothing, whatever is set on it', () => {
    const states = describeFieldStates(
      record({ enabled: false, doNotTranslate: true, sttKeyterm: true,
               canonicalRendering: 'X', pronunciationHint: 'Y' }),
      { sttKeyterms: true, pronunciationHints: true },
    );
    expect(states).toEqual({
      doNotTranslate: 'unconsumed', canonicalRendering: 'unconsumed',
      sttKeyterm: 'unconsumed', pronunciationHint: 'unconsumed',
    });
  });
});
