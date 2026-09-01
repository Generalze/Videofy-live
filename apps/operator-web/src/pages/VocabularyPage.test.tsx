/** @author masterzee001 */
/**
 * The Vocabulary page acceptance contract, asserted.
 *
 * The clauses worth testing are the ones a screenshot cannot check: that no
 * state ever reads "active", that `consumed` is contextual on the SELECTED
 * route rather than on a provider existing somewhere, and that a conflict is
 * shown rather than recovered from.
 *
 * Rendered as static markup, which is this app's convention. That covers what
 * the operator SEES; it cannot cover what a click does, so the handler wiring
 * is left to the end-to-end proof rather than asserted here by a mock that
 * would only agree with itself.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  VocabularyPage,
  describeConsumerStates,
  type RouteCapabilities,
  type VocabularyEntryView,
} from './VocabularyPage';

const NOVA3: RouteCapabilities = {
  sttKeyterms: true, sttRouteName: 'Deepgram nova-3',
  pronunciationHints: false, synthesisRouteName: 'ElevenLabs',
};
const NOVA2: RouteCapabilities = {
  sttKeyterms: false, sttRouteName: 'Deepgram nova-2',
  pronunciationHints: false, synthesisRouteName: 'ElevenLabs',
};

function entry(over: Partial<VocabularyEntryView> = {}): VocabularyEntryView {
  return {
    id: 'lagos', term: 'Lagos', canonicalRendering: '', language: '*',
    pronunciationHint: '', doNotTranslate: false, sttKeyterm: false,
    kind: 'place', notes: '', enabled: true, ...over,
  };
}

function view(entries: VocabularyEntryView[], capabilities = NOVA3, revision = 12) {
  return { programmeId: 'prog_A', revision, entries, capabilities };
}

const NOOP = { onReload: vi.fn(), onSave: vi.fn(), onDelete: vi.fn() };

/** The page as an operator's browser receives it. */
function markup(element: React.ReactElement): string {
  return renderToStaticMarkup(element);
}

describe('the revision being edited is visible', () => {
  it('shows it', () => {
    const html = markup(<VocabularyPage snapshot={view([entry()])} {...NOOP} />);
    expect(html).toMatch(/Revision.*<strong>12<\/strong>/su);
  });

  it('offers a control to remove an entry', () => {
    const html = markup(<VocabularyPage snapshot={view([entry()])} {...NOOP} />);
    expect(html).toMatch(/Remove/u);
  });
});

describe('consumer state is truthful, and never says active', () => {
  it('uses only consumed, unconsumed or unsupported', () => {
    const html = markup(<VocabularyPage
      snapshot={view([entry({ doNotTranslate: true, sttKeyterm: true,
                              canonicalRendering: 'Èkó', pronunciationHint: 'EH-ko' })])}
      {...NOOP} />);
    expect(html).toMatch(/data-state="consumed"/u);
    // The words a console must never use merely because a write succeeded.
    // Checked across the WHOLE page, not just the chips: an operator scanning
    // the screen does not distinguish a state label from prose, and "applied"
    // in a footnote reads as a claim about their term either way. This caught
    // exactly that in the first draft.
    expect(html).not.toMatch(/data-state="active"/u);
    expect(html).not.toMatch(/>active</iu);
    expect(html).not.toMatch(/applied/iu);
    expect(html).not.toMatch(/enabled and working/iu);
  });

  it('names the consumer of each actionable field', () => {
    const html = markup(
      <VocabularyPage snapshot={view([entry({ doNotTranslate: true })])} {...NOOP} />);
    expect(html).toMatch(/Translation protection/u);
    expect(html).toMatch(/Translation matched-span restore/u);
    expect(html).toMatch(/Speech recognition/u);
    expect(html).toMatch(/Speech synthesis/u);
  });

  it('shows an operator note without claiming a consumer for it', () => {
    const html = markup(<VocabularyPage
      snapshot={view([entry({ notes: 'agreed with the producer' })])} {...NOOP} />);
    expect(html).toMatch(/agreed with the producer/u);
    expect(html).toMatch(/title="Operator memo; nothing reads it"/u);
  });

  it('a disabled term is shown as reaching nothing', () => {
    const html = markup(<VocabularyPage
      snapshot={view([entry({ enabled: false, doNotTranslate: true, sttKeyterm: true })])}
      {...NOOP} />);
    expect(html).not.toMatch(/data-state="consumed"/u);
  });
});

describe('consumed is CONTEXTUAL on the selected route', () => {
  it('nova-3 makes an STT keyterm consumed', () => {
    expect(describeConsumerStates(entry({ sttKeyterm: true }), NOVA3).sttKeyterm)
      .toBe('consumed');
  });

  it('nova-2 makes the SAME term unsupported, not consumed', () => {
    // "Deepgram exists somewhere" is not an answer. Only the selected
    // source-language recognition route decides.
    expect(describeConsumerStates(entry({ sttKeyterm: true }), NOVA2).sttKeyterm)
      .toBe('unsupported');
  });

  it('shows the route name beside the claim, so it can be checked', () => {
    const html = markup(
      <VocabularyPage snapshot={view([entry({ sttKeyterm: true })], NOVA2)} {...NOOP} />);
    expect(html).toMatch(/Deepgram nova-2/u);
    expect(html).toMatch(/data-state="unsupported"/u);
  });

  it('a stored pronunciation hint with no synthesis support is unsupported', () => {
    expect(describeConsumerStates(entry({ pronunciationHint: 'EH-ko' }), NOVA3)
      .pronunciationHint).toBe('unsupported');
  });

  it('a disabled term consumes nothing whatever is set on it', () => {
    const states = describeConsumerStates(
      entry({ enabled: false, doNotTranslate: true, sttKeyterm: true,
              canonicalRendering: 'Èkó', pronunciationHint: 'EH-ko' }), NOVA3);
    expect(Object.values(states))
      .toEqual(['unconsumed', 'unconsumed', 'unconsumed', 'unconsumed']);
  });
});

describe('language and direction are visible', () => {
  it('shows a language-scoped term as scoped, not global', () => {
    const html = markup(
      <VocabularyPage snapshot={view([entry({ language: 'fr' })])} {...NOOP} />);
    expect(html).toMatch(/>fr</u);
    expect(html).not.toMatch(/every language/u);
  });

  it('shows a * term as applying to every language', () => {
    const html = markup(
      <VocabularyPage snapshot={view([entry({ language: '*' })])} {...NOOP} />);
    expect(html).toMatch(/every language/u);
  });
});

describe('a conflict is shown, never auto-recovered', () => {
  const CONFLICT = { expectedRevision: 12, currentRevision: 14 };

  it('shows the required copy', () => {
    const html = markup(
      <VocabularyPage snapshot={view([entry()])} conflict={CONFLICT} {...NOOP} />);
    expect(html).toMatch(/Vocabulary changed since you opened this page\./u);
    expect(html).toMatch(/Reload the latest revision before saving\./u);
  });

  it('says nothing was saved and nothing was overwritten', () => {
    const html = markup(
      <VocabularyPage snapshot={view([entry()])} conflict={CONFLICT} {...NOOP} />);
    expect(html).toMatch(/Nothing was saved/u);
    expect(html).toMatch(/no other change was overwritten/u);
  });

  it('names both revisions, so the operator knows what they missed', () => {
    const html = markup(
      <VocabularyPage snapshot={view([entry()])} conflict={CONFLICT} {...NOOP} />);
    expect(html).toMatch(/revision 12/u);
    expect(html).toMatch(/revision 14/u);
  });

  it('offers a reload rather than a retry', () => {
    const html = markup(
      <VocabularyPage snapshot={view([entry()])} conflict={CONFLICT} {...NOOP} />);
    expect(html).toMatch(/Reload revision 14/u);
    expect(html).not.toMatch(/try again/iu);
    expect(html).not.toMatch(/overwrite/iu);
  });

  it('announces the conflict assertively', () => {
    const html = markup(
      <VocabularyPage snapshot={view([entry()])} conflict={CONFLICT} {...NOOP} />);
    expect(html).toMatch(/role="alert"/u);
  });
});

describe('effective time is explicit', () => {
  it('says changes apply to the next session', () => {
    const html = markup(<VocabularyPage snapshot={view([entry()])} {...NOOP} />);
    expect(html).toMatch(/next processing session/u);
  });

  it('says a running session keeps what it started with', () => {
    const html = markup(<VocabularyPage snapshot={view([entry()])} {...NOOP} />);
    expect(html).toMatch(/keeps the vocabulary it started with/u);
  });
});

describe('no database means no fake UI', () => {
  it('reports the capability unavailable and offers no controls', () => {
    const html = markup(<VocabularyPage snapshot={null} unavailable {...NOOP} />);
    expect(html).toMatch(/durable storage is not configured/u);
    // Nothing that would accept a term it cannot keep.
    expect(html).not.toMatch(/<table/u);
    expect(html).not.toMatch(/<button/u);
    expect(html).not.toMatch(/<input/u);
  });
});

describe('the canonical-rendering claim is not overstated', () => {
  it('says it applies where matched, not to unseen spellings', () => {
    const html = markup(<VocabularyPage snapshot={view([entry()])} {...NOOP} />);
    expect(html).toMatch(/does not correct a spelling nobody entered/u);
  });
});
