/** @vitest-environment jsdom */
/** @author masterzee001 */
/**
 * Page 05, end to end, starting from the control an operator actually clicks.
 *
 * WHY IT BEGINS AT THE BUTTON. A proof that calls `controller.save()` directly
 * passes while the console still has no way to create a term -- which is
 * exactly what happened here twice, once at App level and once inside the
 * component. So the first act of this test is a real click in a real DOM, and
 * everything downstream follows from it.
 *
 * The server side is the REAL route handler over the REAL durable port against
 * a Postgres-shaped fake, so revisions, transactions, the optimistic gate and
 * programme scope all behave as they do in production. Only the database driver
 * and the network hop are simulated.
 */
import express from 'express';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VocabularyPage } from './VocabularyPage';
import { INITIAL_STATE, createVocabularyController, type VocabularyState } from '../vocabularyController';
import {
  deleteVocabularyEntry, fetchVocabulary, saveVocabularyEntry,
} from '../vocabularyClient';
import { registerVocabularyRoutes } from '../../../../services/account/src/vocabulary-routes';
import { createPostgresVocabulary } from '../../../../services/account/src/db/programme-vocabulary-postgres';
import { makeFakePool } from './e2eFakePool';

const CAPS = {
  sttKeyterms: true, sttRouteName: 'deepgram-nova nova-3',
  pronunciationHints: false, synthesisRouteName: 'chain',
};

let container: HTMLDivElement;
let root: Root;
let server: Server;
let baseUrl: string;
let pool: ReturnType<typeof makeFakePool>;

beforeEach(async () => {
  pool = makeFakePool();
  const app = express();
  app.use(express.json());
  registerVocabularyRoutes(app, {
    vocabulary: createPostgresVocabulary(pool.pool),
    callerAccountId: () => ({ accountId: 'acct_1' }),
    // The operator owns prog_A and nothing else.
    mayAdminister: async (_accountId, programmeId) => programmeId === 'prog_A',
  });
  server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  await new Promise<void>((r) => server.close(() => r()));
});

/** The console, wired exactly as App.tsx wires it. */
function mountConsole(programmeId = 'prog_A') {
  let state: VocabularyState = INITIAL_STATE;
  const controller = createVocabularyController({
    accountUrl: baseUrl,
    ingestUrl: baseUrl,
    programmeId,
    onState: (next) => {
      state = next;
      draw();
    },
    client: {
      fetchVocabulary,
      // The capability comes from the service in production; pinned here so the
      // test is about vocabulary rather than about media-ingest's boot.
      fetchVocabularyCapabilities: async () => CAPS,
      saveVocabularyEntry,
      deleteVocabularyEntry,
    } as never,
  });

  function draw(): void {
    root.render(
      <VocabularyPage
        snapshot={state.snapshot}
        unavailable={state.unavailable}
        conflict={state.conflict}
        saving={state.saving}
        onReload={() => { void controller.reload(); }}
        onSave={(entry, revision) => { void controller.save(entry, revision); }}
        onDelete={(id, revision) => { void controller.remove(id, revision); }}
      />,
    );
  }

  return { controller, draw, state: () => state };
}

function type(name: string, value: string): void {
  const input = container.querySelector<HTMLInputElement>(`[name="${name}"]`);
  if (input === null) throw new Error(`no field named ${name}`);
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function check(name: string): void {
  const box = container.querySelector<HTMLInputElement>(`[name="${name}"]`);
  if (box === null) throw new Error(`no checkbox named ${name}`);
  act(() => box.click());
}

function clickText(text: RegExp): void {
  const button = [...container.querySelectorAll('button')]
    .find((b) => text.test(b.textContent ?? ''));
  if (button === undefined) throw new Error(`no button matching ${text}`);
  act(() => button.click());
}

/** Let the real HTTP round trip and the re-read settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await act(async () => { await new Promise((r) => setTimeout(r, 5)); });
  }
}

describe('operator creates a term, and it reaches the database', () => {
  it('click -> PUT with the displayed revision -> persisted -> revision advances', async () => {
    const console_ = mountConsole();
    await act(async () => { await console_.controller.reload(); });
    await settle();

    expect(container.textContent).toMatch(/Revision/u);
    const shownBefore = console_.state().snapshot!.revision;
    expect(shownBefore).toBe(0);

    // THE OPERATOR ACTION.
    type('term', 'Ọ̀gbẹ́ni Adéyẹmí');
    check('doNotTranslate');
    check('sttKeyterm');
    clickText(/add term/iu);
    await settle();

    // Persisted, and the displayed revision advanced from the server's answer.
    const after = console_.state().snapshot!;
    expect(after.revision).toBe(1);
    expect(after.entries).toHaveLength(1);
    expect(after.entries[0]).toMatchObject({
      term: 'Ọ̀gbẹ́ni Adéyẹmí', doNotTranslate: true, sttKeyterm: true,
    });

    // And it is in the durable store, not just in the page.
    const durable = await createPostgresVocabulary(pool.pool).snapshotRead('prog_A');
    expect(durable.revision).toBe(1);
    expect(durable.entries[0]?.term).toBe('Ọ̀gbẹ́ni Adéyẹmí');
  });

  it('survives a restart: a NEW port over the same storage reads it back', async () => {
    const console_ = mountConsole();
    await act(async () => { await console_.controller.reload(); });
    await settle();
    type('term', 'Abéòkúta');
    type('canonicalRendering', 'Abeokuta');
    clickText(/add term/iu);
    await settle();

    // A fresh port is what a process restart looks like to the database.
    const afterRestart = createPostgresVocabulary(pool.pool);
    const back = await afterRestart.snapshotRead('prog_A');
    expect(back.revision).toBe(1);
    expect(back.entries[0]?.canonicalRendering).toBe('Abeokuta');
  });
});

describe('a stale save conflicts, and the operator recovers by reloading', () => {
  it('PUT once, 409, message shown, no retry, then a real reload', async () => {
    const console_ = mountConsole();
    await act(async () => { await console_.controller.reload(); });
    await settle();

    type('term', 'Lagos');
    clickText(/add term/iu);
    await settle();
    expect(console_.state().snapshot!.revision).toBe(1);

    // SOMEBODY ELSE saves, straight against the durable port.
    await createPostgresVocabulary(pool.pool).upsert({
      programmeId: 'prog_A', id: 'other', term: 'Kano', canonicalRendering: '',
      language: '*', pronunciationHint: '', doNotTranslate: false, sttKeyterm: false,
      kind: 'place', notes: '', enabled: true, updatedAt: new Date().toISOString(),
    }, 1);

    // This operator is now editing revision 1 while the server is on 2.
    type('term', 'Ibadan');
    clickText(/add term/iu);
    await settle();

    expect(container.textContent)
      .toMatch(/Vocabulary changed since you opened this page/u);
    expect(container.textContent).toMatch(/Reload the latest revision before saving/u);
    // Nothing of this operator's landed, and the other person's survived.
    const durable = await createPostgresVocabulary(pool.pool).snapshotRead('prog_A');
    expect(durable.revision).toBe(2);
    expect(durable.entries.map((e) => e.term).sort()).toEqual(['Kano', 'Lagos']);

    // RELOAD is a real GET.
    clickText(/reload revision 2/iu);
    await settle();
    expect(console_.state().conflict).toBeNull();
    expect(console_.state().snapshot!.revision).toBe(2);
    expect(container.textContent).toMatch(/Kano/u);
  });
});

describe('delete from the UI removes it durably', () => {
  it('click Remove -> DELETE with the displayed revision -> gone', async () => {
    const console_ = mountConsole();
    await act(async () => { await console_.controller.reload(); });
    await settle();
    type('term', 'Lagos');
    clickText(/add term/iu);
    await settle();
    expect(console_.state().snapshot!.entries).toHaveLength(1);

    clickText(/remove/iu);
    await settle();

    expect(console_.state().snapshot!.entries).toHaveLength(0);
    const durable = await createPostgresVocabulary(pool.pool).snapshotRead('prog_A');
    expect(durable.entries).toEqual([]);
    expect(durable.revision).toBe(2);
  });
});

describe('another programme inherits nothing', () => {
  it('a term saved on prog_A is absent from prog_B', async () => {
    const console_ = mountConsole();
    await act(async () => { await console_.controller.reload(); });
    await settle();
    type('term', 'Ọ̀gbẹ́ni Adéyẹmí');
    clickText(/add term/iu);
    await settle();

    const other = await createPostgresVocabulary(pool.pool).snapshotRead('prog_B');
    expect(other.entries).toEqual([]);
    expect(other.revision).toBe(0);
  });
});

describe('no vocabulary API means no editable page', () => {
  it('a 404 shows the capability as unavailable and offers no form', async () => {
    // A deployment with no durable storage does not register the routes.
    const bare = express();
    const bareServer = bare.listen(0);
    await new Promise<void>((r) => bareServer.once('listening', r));
    const url = `http://127.0.0.1:${(bareServer.address() as AddressInfo).port}`;

    let state: VocabularyState = INITIAL_STATE;
    const controller = createVocabularyController({
      accountUrl: url, ingestUrl: url, programmeId: 'prog_A',
      onState: (next) => {
        state = next;
        root.render(
          <VocabularyPage
            snapshot={next.snapshot}
            unavailable={next.unavailable}
            conflict={null} saving={false}
            onReload={vi.fn()} onSave={vi.fn()} onDelete={vi.fn()} />,
        );
      },
      client: {
        fetchVocabulary,
        fetchVocabularyCapabilities: async () => CAPS,
        saveVocabularyEntry, deleteVocabularyEntry,
      } as never,
    });
    await act(async () => { await controller.reload(); });
    await settle();

    expect(state.unavailable).toBe(true);
    expect(container.textContent).toMatch(/durable storage is not configured/u);
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('table')).toBeNull();
    await new Promise<void>((r) => bareServer.close(() => r()));
  });
});
