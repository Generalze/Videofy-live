/** @vitest-environment jsdom */
/** @author masterzee001 */
/**
 * A REAL click, in a real DOM, reaching a real handler.
 *
 * Page 05 shipped with `onSave` wired from App and nothing inside the component
 * that called it -- the eighth unwired seam in this project, and the second I
 * produced myself. Static markup could not have caught it: the callback was
 * present in the props and absent from every control.
 *
 * So this renders into jsdom and dispatches genuine events. No testing library:
 * React's own DOM renderer plus real `click` and `input` events is enough, and
 * one dev dependency is a smaller change to this app's testing architecture
 * than three.
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VocabularyPage, type VocabularyEntryView } from './VocabularyPage';

const CAPS = {
  sttKeyterms: true, sttRouteName: 'deepgram-nova nova-3',
  pronunciationHints: false, synthesisRouteName: 'chain',
};

function entry(over: Partial<VocabularyEntryView> = {}): VocabularyEntryView {
  return {
    id: 'lagos', term: 'Lagos', canonicalRendering: '', language: '*',
    pronunciationHint: '', doNotTranslate: false, sttKeyterm: false,
    kind: 'place', notes: '', enabled: true, ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // React needs this flag to keep act() quiet in a non-test-renderer setup.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(element: React.ReactElement): void {
  act(() => {
    root.render(element);
  });
}

/** Type into a controlled input the way a browser does. */
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
  const input = container.querySelector<HTMLInputElement>(`[name="${name}"]`);
  if (input === null) throw new Error(`no checkbox named ${name}`);
  act(() => input.click());
}

function clickText(text: RegExp): void {
  const button = [...container.querySelectorAll('button')]
    .find((b) => text.test(b.textContent ?? ''));
  if (button === undefined) throw new Error(`no button matching ${text}`);
  act(() => button.click());
}

const NOOP = { onReload: vi.fn(), onDelete: vi.fn() };

describe('an operator can actually create a term', () => {
  it('there IS a save control, and clicking it calls onSave', () => {
    // The assertion that would have failed before this commit.
    const onSave = vi.fn();
    render(<VocabularyPage
      snapshot={{ programmeId: 'prog_A', revision: 7, entries: [], capabilities: CAPS }}
      {...NOOP} onSave={onSave} />);

    type('term', 'Ọ̀gbẹ́ni Adéyẹmí');
    clickText(/add term/iu);

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ term: 'Ọ̀gbẹ́ni Adéyẹmí' });
  });

  it('carries the revision CURRENTLY ON SCREEN', () => {
    const onSave = vi.fn();
    render(<VocabularyPage
      snapshot={{ programmeId: 'prog_A', revision: 41, entries: [], capabilities: CAPS }}
      {...NOOP} onSave={onSave} />);
    type('term', 'Lagos');
    clickText(/add term/iu);
    expect(onSave.mock.calls[0]?.[1]).toBe(41);
  });

  it('carries the toggles the operator set', () => {
    const onSave = vi.fn();
    render(<VocabularyPage
      snapshot={{ programmeId: 'prog_A', revision: 7, entries: [], capabilities: CAPS }}
      {...NOOP} onSave={onSave} />);
    type('term', 'Lagos');
    type('canonicalRendering', 'Èkó');
    check('doNotTranslate');
    check('sttKeyterm');
    clickText(/add term/iu);
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      term: 'Lagos', canonicalRendering: 'Èkó', doNotTranslate: true, sttKeyterm: true,
    });
  });

  it('a blank term cannot be submitted', () => {
    const onSave = vi.fn();
    render(<VocabularyPage
      snapshot={{ programmeId: 'prog_A', revision: 7, entries: [], capabilities: CAPS }}
      {...NOOP} onSave={onSave} />);
    clickText(/add term/iu);
    expect(onSave).not.toHaveBeenCalled();
  });

  it('the UI cannot generate a kind the API refuses', () => {
    render(<VocabularyPage
      snapshot={{ programmeId: 'prog_A', revision: 7, entries: [], capabilities: CAPS }}
      {...NOOP} onSave={vi.fn()} />);
    const options = [...container.querySelectorAll('select[name="kind"] option')]
      .map((o) => o.getAttribute('value'));
    expect(options).toEqual(['person', 'place', 'organisation', 'programme-term', 'code']);
  });
});

describe('an operator can edit an existing term', () => {
  it('editing preserves the entry id — never delete and recreate', () => {
    // Delete-then-create would be two revisions, two conflict windows, and a
    // moment where the term does not exist for a session taking a snapshot.
    const onSave = vi.fn();
    render(<VocabularyPage
      snapshot={{
        programmeId: 'prog_A', revision: 7,
        entries: [entry({ id: 'lagos-fixed', term: 'Lagos' })], capabilities: CAPS,
      }}
      {...NOOP} onSave={onSave} onDelete={NOOP.onDelete} />);

    clickText(/^edit$/iu);
    type('canonicalRendering', 'Èkó');
    clickText(/save changes/iu);

    expect(NOOP.onDelete).not.toHaveBeenCalled();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({
      id: 'lagos-fixed', term: 'Lagos', canonicalRendering: 'Èkó',
    });
  });

  it('the edit form is populated from the row', () => {
    render(<VocabularyPage
      snapshot={{
        programmeId: 'prog_A', revision: 7,
        entries: [entry({ term: 'Abéòkúta', canonicalRendering: 'Abeokuta', language: 'yo' })],
        capabilities: CAPS,
      }}
      {...NOOP} onSave={vi.fn()} />);
    clickText(/^edit$/iu);
    expect(container.querySelector<HTMLInputElement>('[name="term"]')?.value)
      .toBe('Abéòkúta');
    expect(container.querySelector<HTMLInputElement>('[name="language"]')?.value)
      .toBe('yo');
  });
});

describe('saving state prevents a second write', () => {
  it('the save control is disabled while a write is in flight', () => {
    const onSave = vi.fn();
    render(<VocabularyPage
      snapshot={{ programmeId: 'prog_A', revision: 7, entries: [], capabilities: CAPS }}
      {...NOOP} onSave={onSave} saving />);
    const save = [...container.querySelectorAll('button')]
      .find((b) => /saving/iu.test(b.textContent ?? ''));
    expect(save?.disabled).toBe(true);
  });

  it('does not fabricate success: nothing changes until the parent re-renders', () => {
    const onSave = vi.fn();
    render(<VocabularyPage
      snapshot={{ programmeId: 'prog_A', revision: 7, entries: [], capabilities: CAPS }}
      {...NOOP} onSave={onSave} />);
    type('term', 'Lagos');
    clickText(/add term/iu);
    // The table still shows what the SERVER last said. An optimistic row would
    // be the console inventing a state nobody confirmed.
    expect(container.querySelector('tbody')?.textContent).toMatch(/No terms yet/u);
  });
});

describe('delete and reload remain reachable', () => {
  it('remove calls onDelete with the displayed revision', () => {
    const onDelete = vi.fn();
    render(<VocabularyPage
      snapshot={{
        programmeId: 'prog_A', revision: 12, entries: [entry()], capabilities: CAPS,
      }}
      onReload={vi.fn()} onSave={vi.fn()} onDelete={onDelete} />);
    clickText(/remove/iu);
    expect(onDelete).toHaveBeenCalledWith('lagos', 12);
  });

  it('reload calls onReload', () => {
    const onReload = vi.fn();
    render(<VocabularyPage
      snapshot={{ programmeId: 'prog_A', revision: 12, entries: [entry()], capabilities: CAPS }}
      conflict={{ expectedRevision: 12, currentRevision: 14 }}
      onReload={onReload} onSave={vi.fn()} onDelete={vi.fn()} />);
    clickText(/reload revision 14/iu);
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
