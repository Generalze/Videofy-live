/** @vitest-environment jsdom */
/** @author masterzee001 */
/**
 * Page 06, end to end, from a real route document to rendered text.
 *
 * WHAT IS REAL HERE: the translation route registry built from a real document
 * by the real validator; the real `registerQualityRoutes` handler; a real HTTP
 * round trip; the real `fetchRouteQuality` client; the real `useQuality` state;
 * and the real `QualityPage` in a real DOM. Only the language capability
 * catalogue is supplied directly, because on a live deployment it is assembled
 * from provider probes that cannot run in a test.
 *
 * WHY IT MATTERS THAT THE REGISTRY IS REAL: the property being protected is
 * that this page cannot promote a route. A test that handed the endpoint a
 * pre-baked "allowed" object would prove the renderer works and prove nothing
 * about the gate -- and the gate is the only part where being wrong is
 * expensive.
 */
import express from 'express';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTranslationRouteRegistry,
  type ScopeApproval,
  type ServiceScope,
} from '@videofy-live/translation-routes';
import type { TargetLanguageCapability } from '@videofy-live/shared-types';
import { registerQualityRoutes } from '../../../../services/media-ingest/src/quality-routes';
import { QualityPage } from './QualityPage';
import { useQuality } from '../useQuality';

const MEASURED = {
  sampleCount: 5,
  successRate: 1,
  latencyMs: { min: 120, median: 180, mean: 190, max: 260 },
  recordedAt: '2026-08-30T00:00:00.000Z',
};

function scopes(
  over: Partial<Record<ServiceScope, ScopeApproval>> = {},
): Record<string, ScopeApproval> {
  return {
    messaging: 'unapproved',
    'programme-live': 'unapproved',
    'call-live': 'unapproved',
    ...over,
  };
}

function route(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sourceLanguage: 'en',
    targetLanguage: 'fr',
    provider: 'opus-mt',
    modelId: 'Helsinki-NLP/opus-mt-en-fr',
    executionClass: 'local',
    productionApproved: false,
    technicalEvidence: null,
    humanReviewStatus: 'not-required',
    licenceStatus: { licence: 'Apache-2.0', commercialUse: 'permitted', evidence: 'fixture' },
    serviceScopes: scopes(),
    ...over,
  };
}

/** Approved, measured, human-cleared: the shape a usable route really has. */
const EN_FR_QUALIFIED = route({
  productionApproved: true,
  technicalEvidence: MEASURED,
  humanReviewStatus: 'passed',
  serviceScopes: scopes({ 'programme-live': 'approved' }),
});

/** The strongest a Nigerian route may legitimately be: measured, unreviewed. */
const EN_YO_PENDING = route({
  targetLanguage: 'yo',
  provider: 'naijalingo',
  modelId: 'naijalingo/yo-1',
  productionApproved: true,
  technicalEvidence: { ...MEASURED, sampleCount: 500 },
  humanReviewStatus: 'required-not-done',
  serviceScopes: scopes(),
});

function capability(over: Partial<TargetLanguageCapability>): TargetLanguageCapability {
  return {
    language: 'fr',
    label: 'French',
    sourceState: 'qualified',
    targetState: 'qualified',
    providers: { stt: 'deepgram-nova nova-3', mt: 'opus-mt', tts: 'piper fr' },
    translationAvailable: true,
    voiceAvailable: true,
    textOnly: false,
    experimental: false,
    availability: 'available',
    translationModel: 'opus-mt',
    voiceId: 'piper-fr-1',
    license: 'Apache-2.0',
    commercialUse: 'allowed',
    ...over,
  } as TargetLanguageCapability;
}

let container: HTMLDivElement;
let root: Root;
let server: Server | null = null;
let baseUrl = '';

/** Stand up the real endpoint over a real registry built from `routes`. */
async function serve(
  routes: readonly Record<string, unknown>[],
  catalogue: readonly TargetLanguageCapability[],
  options: { readonly withDocument?: boolean } = {},
): Promise<void> {
  let registry = null as never;
  if (options.withDocument !== false) {
    const made = createTranslationRouteRegistry({
      version: 1,
      reviewRequiredLanguages: ['yo', 'ha', 'ig', 'pcm'],
      routes,
    });
    if (!made.ok) throw new Error(`document invalid: ${JSON.stringify(made.problems)}`);
    registry = made.registry as never;
  }

  const app = express();
  registerQualityRoutes(app, {
    registry,
    catalogue: () => catalogue,
    scope: 'programme-live',
  });
  server = app.listen(0);
  await new Promise<void>((r) => server!.once('listening', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The console, composed exactly as App.tsx composes it. */
function Harness(props: { source: string; targets: readonly string[] }): React.ReactElement {
  const quality = useQuality({
    ingestUrl: baseUrl,
    sourceLanguage: props.source,
    targetLanguages: props.targets,
  });
  return (
    <QualityPage
      rows={quality.rows}
      unavailable={quality.unavailable}
      loading={quality.loading}
      onReload={() => {
        void quality.reload();
      }}
    />
  );
}

async function mount(source: string, targets: readonly string[]): Promise<void> {
  await act(async () => {
    root.render(<Harness source={source} targets={targets} />);
  });
  // Let the real round trip and the re-render settle.
  for (let i = 0; i < 30; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
}

/** The rendered card for one direction, as an operator would look at it. */
function card(direction: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-direction="${direction}"]`);
  if (found === null) throw new Error(`no rendered row for ${direction}`);
  return found;
}

function stage(direction: string, name: 'stt' | 'translation' | 'tts'): HTMLElement {
  const found = card(direction).querySelector<HTMLElement>(`[data-stage="${name}"]`);
  if (found === null) throw new Error(`no ${name} cell for ${direction}`);
  return found;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  act(() => root.unmount());
  container.remove();
  if (server !== null) {
    const closing = server;
    server = null;
    await new Promise<void>((r) => closing.close(() => r()));
  }
});

describe('a qualified non-Nigerian route reaches the operator as usable', () => {
  it('renders READY on every stage and on the row', async () => {
    await serve([EN_FR_QUALIFIED], [capability({ language: 'en' }), capability({})]);
    await mount('en', ['fr']);

    expect(card('en->fr').dataset['overall']).toBe('ready');
    expect(stage('en->fr', 'translation').dataset['state']).toBe('ready');
    // The real model, named, so a complaint can be attached to something.
    expect(stage('en->fr', 'translation').textContent)
      .toMatch(/opus-mt Helsinki-NLP\/opus-mt-en-fr/u);
    expect(stage('en->fr', 'stt').textContent).toMatch(/deepgram-nova nova-3/u);
  });
});

describe('a Nigerian route reaches the operator as REVIEW PENDING', () => {
  it('is pending, is not ready, and says a human has not looked', async () => {
    await serve(
      [EN_YO_PENDING],
      [capability({ language: 'en' }), capability({ language: 'yo', label: 'Yoruba' })],
    );
    await mount('en', ['yo']);

    const row = card('en->yo');
    expect(row.dataset['overall']).toBe('review-pending');
    expect(row.textContent).toMatch(/REVIEW PENDING/u);
    // The words that matter: nothing measurable settles correctness.
    expect(row.textContent).toMatch(/no human has reviewed it/u);
    expect(row.textContent).not.toMatch(/\bREADY\b/u);
  });

  it('shows its measurement labelled as speed, never as reassurance', async () => {
    await serve(
      [EN_YO_PENDING],
      [capability({ language: 'en' }), capability({ language: 'yo' })],
    );
    await mount('en', ['yo']);

    const translation = stage('en->yo', 'translation');
    expect(translation.textContent).toMatch(/median 180 ms/u);
    expect(translation.textContent).toMatch(/speed only/u);
    expect(translation.textContent).toMatch(/correctness is unreviewed for en->yo/u);
  });

  it('recommends no delay, because it cannot go to air', async () => {
    await serve(
      [EN_YO_PENDING],
      [capability({ language: 'en' }), capability({ language: 'yo' })],
    );
    await mount('en', ['yo']);
    expect(card('en->yo').textContent).toMatch(/Recommended delay\s*none/u);
    expect(card('en->yo').textContent).toMatch(/cannot go to air yet/u);
  });
});

describe('unsupported speech recognition reaches the operator as UNAVAILABLE', () => {
  it('is unavailable at the row even though translation and voice are fine', async () => {
    await serve(
      [route({
        sourceLanguage: 'ig', targetLanguage: 'fr',
        productionApproved: true, technicalEvidence: MEASURED,
        humanReviewStatus: 'passed',
        serviceScopes: scopes({ 'programme-live': 'approved' }),
      })],
      [
        capability({
          language: 'ig', label: 'Igbo', sourceState: 'unavailable',
          reason: 'no recogniser covers Igbo on this deployment',
        }),
        capability({}),
      ],
    );
    await mount('ig', ['fr']);

    expect(stage('ig->fr', 'stt').dataset['state']).toBe('unavailable');
    expect(stage('ig->fr', 'translation').dataset['state']).toBe('ready');
    // NOT hidden behind two healthy stages.
    expect(card('ig->fr').dataset['overall']).toBe('unavailable');
    expect(stage('ig->fr', 'stt').textContent).toMatch(/no recogniser covers Igbo/u);
  });
});

describe('a fallback voice reaches the operator as DEGRADED', () => {
  it('says the audio will play and be wrong', async () => {
    await serve(
      [route({
        targetLanguage: 'yo', provider: 'naijalingo', modelId: 'naijalingo/yo-1',
        productionApproved: true, technicalEvidence: MEASURED,
        humanReviewStatus: 'passed',
        serviceScopes: scopes({ 'programme-live': 'approved' }),
      })],
      [
        capability({ language: 'en' }),
        capability({
          language: 'yo', label: 'Yoruba', degraded: true,
          providers: { stt: 'deepgram-nova nova-3', mt: 'naijalingo', tts: 'azure-general' },
          reason: 'Yoruba is being spoken by a general vendor voice, not the specialist',
        }),
      ],
    );
    await mount('en', ['yo']);

    expect(stage('en->yo', 'tts').dataset['state']).toBe('degraded');
    expect(card('en->yo').dataset['overall']).toBe('degraded');
    expect(stage('en->yo', 'tts').textContent).toMatch(/general vendor voice/u);
    expect(card('en->yo').textContent).toMatch(/DEGRADED/u);
  });
});

describe('measured and unmeasured latency are both shown truthfully', () => {
  it('displays the exact measured evidence for the stage that has it', async () => {
    await serve([EN_FR_QUALIFIED], [capability({ language: 'en' }), capability({})]);
    await mount('en', ['fr']);

    const translation = stage('en->fr', 'translation');
    expect(translation.textContent).toMatch(/median 180 ms/u);
    expect(translation.textContent).toMatch(/worst observed 260 ms/u);
    // The provenance, so the number can be challenged.
    expect(translation.textContent).toMatch(/5 samples, recorded 2026-08-30/u);
  });

  it('says NOT MEASURED for the stages nothing times, and invents nothing', async () => {
    await serve([EN_FR_QUALIFIED], [capability({ language: 'en' }), capability({})]);
    await mount('en', ['fr']);

    for (const name of ['stt', 'tts'] as const) {
      const cell = stage('en->fr', name);
      expect(cell.textContent).toMatch(/Latency not measured/u);
      // No number smuggled in from a timeout.
      expect(cell.textContent).not.toMatch(/\d+\s*ms/u);
      expect(cell.textContent).toMatch(/a limit and not an observation/u);
    }
  });
});

describe('the recommended delay is derived and explained', () => {
  it('names the grade, the evidence behind it, and what is missing', async () => {
    await serve([EN_FR_QUALIFIED], [capability({ language: 'en' }), capability({})]);
    await mount('en', ['fr']);

    const text = card('en->fr').textContent ?? '';
    expect(text).toMatch(/Recommended delay\s*30 s/u);
    // The workings: the measurement, the margin, and the honest caveat.
    expect(text).toMatch(/260 ms/u);
    expect(text).toMatch(/1\.5x margin/u);
    expect(text).toMatch(/FLOOR, not a full budget/u);
    expect(text).toMatch(/stt and tts/u);
  });
});

describe('a service that cannot answer is never rendered as healthy', () => {
  it('with no route document, the page says unknown rather than showing rows', async () => {
    await serve([], [capability({ language: 'en' }), capability({})], {
      withDocument: false,
    });
    await mount('en', ['fr']);

    expect(container.textContent).toMatch(/Route quality is unknown/u);
    // The failure mode this guards: an empty table reading as "no problems".
    expect(container.querySelector('[data-direction]')).toBeNull();
    expect(container.textContent).not.toMatch(/\bREADY\b/u);
  });
});

describe('directions are separate rows', () => {
  it('en->fr approved leaves fr->en unavailable on the same screen', async () => {
    await serve(
      [EN_FR_QUALIFIED],
      [capability({ language: 'en' }), capability({})],
    );
    await mount('en', ['fr']);
    expect(card('en->fr').dataset['overall']).toBe('ready');

    // The reverse direction, asked separately, is not carried by the forward one.
    await mount('fr', ['en']);
    expect(card('fr->en').dataset['overall']).toBe('unavailable');
    expect(card('fr->en').textContent).toMatch(/No route record exists for fr->en/u);
  });
});
