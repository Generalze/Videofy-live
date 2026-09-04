/** @author masterzee001 */
/**
 * A snapshot's revision must describe its own contents.
 *
 * THE REGRESSION THIS PINS. `takeSnapshot` briefly asked its source for a
 * revision and then for the rows -- two independent reads, on the reasoning
 * that those were the smallest operations it used. The smallest set of CALLS is
 * not the smallest COHERENT read, and a writer committing between them produces
 * revision N paired with rows from N+1: a number that is a lie about the thing
 * it labels, with no error anywhere.
 *
 * It matters more here than in most places because that number is what a
 * session pins and what the console shows. A session claiming revision 17 while
 * holding 18's terms cannot be reconciled with anything later, and the operator
 * is told a change applies to the next session when it has already leaked into
 * this one.
 *
 * The interleaving below is CONTROLLED, not timed. A sleep would make this pass
 * or fail by scheduler luck, which is worse than no test.
 */
import { describe, expect, it } from 'vitest';
import { takeSnapshot } from './snapshot.js';
import type { VocabularyRecord } from './store.js';

const CAPS = { sttKeyterms: true, pronunciationHints: false };
const EN_TO_FR = { sourceLanguage: 'en', targetLanguage: 'fr' };

function record(over: Partial<VocabularyRecord> = {}): VocabularyRecord {
  return {
    programmeId: 'prog_A', id: 'v1', term: 'Lagos', canonicalRendering: '',
    language: '*', pronunciationHint: '', doNotTranslate: true, sttKeyterm: true,
    kind: 'place', notes: '', enabled: true, updatedAt: '2026-09-01T00:00:00Z',
    ...over,
  };
}

/**
 * A store whose reads can be parked, so a writer can be made to commit at an
 * exact moment rather than at a lucky one.
 */
function parkableStore() {
  let revision = 1;
  let rows: VocabularyRecord[] = [record({ id: 'a', term: 'Lagos' })];
  let release: (() => void) | null = null;
  let parked: Promise<void> | null = null;

  /** The writer, as a mutation that lands while a read is held open. */
  const commitNextRevision = (): void => {
    revision += 1;
    rows = [...rows, record({ id: 'b', term: 'Kano' })];
  };

  return {
    commitNextRevision,
    get revision() { return revision; },
    get rowCount() { return rows.length; },

    /** Park the next call to this, so the test controls what happens next. */
    armPark(): void {
      parked = new Promise<void>((resolve) => { release = resolve; });
    },
    releasePark(): void {
      release?.();
      release = null;
      parked = null;
    },

    /*
     * THE BROKEN SHAPE: two reads, and the park sits in the WINDOW BETWEEN
     * THEM -- which is the whole defect. The revision is already in the
     * reader's hand; the rows have not been fetched yet.
     */
    broken: {
      async revision(_programmeId: string) {
        return revision;
      },
      async list(_programmeId: string) {
        const held = parked;
        if (held) await held;
        return [...rows];
      },
    },

    /*
     * THE CORRECT SHAPE: one read. Both values are captured in the same
     * synchronous step BEFORE anything can await, which is what a transaction
     * with FOR SHARE buys in Postgres. A writer landing during the call cannot
     * appear in half the answer, because there is no half to appear in.
     */
    atomic: {
      async snapshotRead(_programmeId: string) {
        const taken = { revision, entries: [...rows] };
        const held = parked;
        if (held) await held;
        return taken;
      },
    },
  };
}

/** The implementation as it briefly stood: revision, then rows. */
async function brokenTakeSnapshot(
  source: { revision(id: string): Promise<number>; list(id: string): Promise<readonly VocabularyRecord[]> },
  programmeId: string,
): Promise<{ revision: number; entryCount: number }> {
  const revision = await source.revision(programmeId);
  const rows = await source.list(programmeId);
  return { revision, entryCount: rows.length };
}

describe('the defect, demonstrated', () => {
  it('two independent reads DO produce revision N with rows from N+1', async () => {
    const store = parkableStore();
    store.armPark();

    // The reader begins and is held after observing the revision.
    const reading = brokenTakeSnapshot(store.broken, 'prog_A');
    // The writer commits in that window.
    store.commitNextRevision();
    store.releasePark();

    const result = await reading;
    // Revision 1, but two rows -- the contents of revision 2. This is the
    // incoherent snapshot, reproduced deterministically.
    expect(result.revision).toBe(1);
    expect(result.entryCount).toBe(2);
  });
});

describe('the correction makes that combination impossible', () => {
  it('one atomic read never pairs a revision with another revision rows', async () => {
    const store = parkableStore();
    store.armPark();

    const reading = takeSnapshot(store.atomic, 'prog_A', EN_TO_FR, CAPS);
    store.commitNextRevision();
    store.releasePark();

    const snapshot = await reading;
    // The write happened DURING the read, at exactly the moment that broke the
    // two-call version. The pair still AGREES: either revision 1 with one row,
    // or revision 2 with two. Never 1 with two.
    const coherent =
      (snapshot.revision === 1 && snapshot.doNotTranslate.length === 1) ||
      (snapshot.revision === 2 && snapshot.doNotTranslate.length === 2);
    expect(coherent).toBe(true);
    // And the store really did move on underneath it, so the interleaving was
    // real rather than a write that never landed.
    expect(store.revision).toBe(2);
    expect(store.rowCount).toBe(2);
  });

  it('reads the store exactly once', async () => {
    // Two calls would be two opportunities to interleave, however carefully
    // the second one were written.
    let calls = 0;
    const source = {
      async snapshotRead(_programmeId: string) {
        calls += 1;
        return { revision: 3, entries: [record({ id: 'a' })] };
      },
    };
    await takeSnapshot(source, 'prog_A', EN_TO_FR, CAPS);
    expect(calls).toBe(1);
  });

  it('the revision it reports describes the rows it carries', async () => {
    const source = {
      async snapshotRead() {
        return {
          revision: 7,
          entries: [record({ id: 'a', term: 'Lagos' }), record({ id: 'b', term: 'Kano' })],
        };
      },
    };
    const snapshot = await takeSnapshot(source, 'prog_A', EN_TO_FR, CAPS);
    expect(snapshot.revision).toBe(7);
    expect(snapshot.doNotTranslate.sort()).toEqual(['Kano', 'Lagos']);
  });

  it('still refuses an empty programme scope', async () => {
    const source = { async snapshotRead() { return { revision: 0, entries: [] }; } };
    await expect(takeSnapshot(source, '  ', EN_TO_FR, CAPS)).rejects.toThrow(/programmeId/u);
  });
});
