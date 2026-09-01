/** @author masterzee001 */
/**
 * THREE FACTS THAT MUST NOT BLUR INTO ONE, on every surface that mentions them.
 *
 *   Route quality analysis   IMPLEMENTED
 *   Recommended delay        IMPLEMENTED, ADVISORY
 *   Broadcast safety buffer  NOT IMPLEMENTED
 *
 * The console shipped contradicting itself: the Preflight lede called the
 * recommended delay "FUTURE (Programme Quality Engine)" while Page 06, two
 * rail slots above it, computed that delay from real route evidence and
 * printed it with its workings. Both statements were live, twenty-five lines
 * apart, and NEITHER had a test -- which is why the stale one survived.
 *
 * The dangerous half is the other direction. A recommendation presented as an
 * active delay tells an operator they have seconds in hand to cut away from
 * something; they have none, because nothing buffers the output. That is the
 * one misreading on this console that could put an unrecoverable moment to
 * air, so it is asserted rather than trusted to review.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { summariseRouteQuality, NO_ROUTE_QUALITY } from '../qualitySummary';
import type { RouteQualityRow } from '@videofy-live/programme-quality';

/** Line endings are checkout representation; assertions are about structure. */
function readSource(...parts: string[]): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, ...parts), 'utf8').split('\r\n').join('\n');
}

const APP = readSource('..', 'App.tsx');
const LIVE = readSource('..', 'pages', 'LivePage.tsx');

/*
 * COMMENTS STRIPPED BEFORE JUDGING THE CODE.
 *
 * LivePage explains at the top why the chip must never say "Current delay", so
 * a naive search finds the forbidden phrase inside the very sentence forbidding
 * it. This is the third guard in this console to fail on its own documentation.
 * What matters is what an operator can READ ON SCREEN, which is the code.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/\/\/.*/gu, ' ')
    .replace(/\s+/gu, ' ');
}

const LIVE_CODE = withoutComments(LIVE);

/** The lede of one ConsolePage, by id. */
function lede(id: string): string {
  const spaced = APP.indexOf(`<ConsolePage\n        id="${id}"`);
  const inline = APP.indexOf(`<ConsolePage id="${id}"`);
  const start = spaced > -1 ? spaced : inline;
  expect(start, `no ConsolePage with id="${id}"`).toBeGreaterThan(-1);
  const slice = APP.slice(start, APP.indexOf('>', APP.indexOf('lede=', start)));
  return slice;
}

describe('Preflight tells the truth about all three facts', () => {
  const preflight = lede('preflight');

  it('no longer claims the recommended delay is unbuilt', () => {
    // The engine is `@videofy-live/programme-quality`, and it ships.
    expect(preflight).not.toMatch(/recommended delay are FUTURE/u);
    expect(preflight).not.toMatch(/Programme Quality Engine/u);
  });

  it('says the analysis and the recommendation exist, and are advisory', () => {
    expect(preflight).toMatch(/Route quality analysis/u);
    expect(preflight).toMatch(/ADVISORY/u);
  });

  it('says plainly that no buffer exists and the programme goes out live', () => {
    expect(preflight).toMatch(/No broadcast safety buffer exists/u);
    expect(preflight).toMatch(/goes out live/u);
  });
});

describe('Live Control agrees with Preflight and with Page 06', () => {
  it('is fed the real recommendation rather than nothing', () => {
    // It was called with neither prop, so both chips read "--" while the
    // evidence sat in the same function scope.
    expect(APP).toMatch(/quality=\{qualitySummary\.quality\}/u);
    expect(APP).toMatch(/recommendedDelay=\{qualitySummary\.recommendedDelay\}/u);
  });

  it('does not recompute the delay in the page', () => {
    // The recommendation belongs to programme-quality. A second calculation
    // here would be a second answer, free to drift from Page 06's.
    expect(LIVE).not.toMatch(/recommendDelay|DELAY_GRADES|SAFETY_MULTIPLIER/u);
  });

  it('names the chip advisory, and never claims a current or on-air delay', () => {
    expect(LIVE_CODE).toMatch(/Advisory delay/u);
    expect(LIVE_CODE).toMatch(/Broadcast buffer/u);
    expect(LIVE_CODE).not.toMatch(/Current delay/iu);
    expect(LIVE_CODE).not.toMatch(/On-air delay/iu);
  });

  it('no longer describes the quality engine as unbuilt', () => {
    expect(LIVE_CODE).not.toMatch(/Programme Quality Engine is not built/u);
    expect(LIVE_CODE).not.toMatch(/arrives with the Programme Quality Engine/u);
  });
});

/** A row shaped like programme-quality's, with only what the summary reads. */
function row(overall: RouteQualityRow['overall'], seconds: number | null): RouteQualityRow {
  return {
    sourceLanguage: 'en',
    targetLanguage: 'fr',
    scope: 'programme-live',
    overall,
    recommendedDelay: {
      seconds,
      basis: seconds === null ? 'not-applicable' : 'partly-measured',
      measuredFloorMs: 0,
      unmeasuredStages: [],
      explanation: 'fixture',
    },
  } as unknown as RouteQualityRow;
}

describe('the summary folds many routes without hiding one', () => {
  it('reports nothing at all when nothing has been read', () => {
    expect(summariseRouteQuality(null)).toEqual(NO_ROUTE_QUALITY);
    // A programme with no routes is not a programme that is Ready.
    expect(summariseRouteQuality([])).toEqual(NO_ROUTE_QUALITY);
  });

  it('takes the WEAKEST route, never an average or a majority', () => {
    const rows = [row('ready', 30), row('ready', 30), row('unavailable', null)];
    // Two greens must not outvote a red: one language cannot go to air.
    expect(summariseRouteQuality(rows).quality).toBe('Unavailable');
  });

  it('distinguishes review-pending from degraded', () => {
    expect(summariseRouteQuality([row('degraded', 30)]).quality).toBe('Degraded');
    expect(summariseRouteQuality([row('review-pending', null)]).quality).toBe('Review pending');
  });

  it('takes the LARGEST recommendation, because a buffer sized for the fastest protects nothing', () => {
    const rows = [row('ready', 30), row('ready', 90), row('ready', 45)];
    expect(summariseRouteQuality(rows).recommendedDelay).toBe('90 s');
  });

  it('reports no recommendation when no route supports one', () => {
    expect(summariseRouteQuality([row('unavailable', null)]).recommendedDelay).toBeNull();
  });

  it('ignores routes that recommend nothing rather than letting them drag it down', () => {
    const rows = [row('ready', 60), row('review-pending', null)];
    expect(summariseRouteQuality(rows).recommendedDelay).toBe('60 s');
  });

  it('formats in whole seconds, never milliseconds', () => {
    // The chip once showed "480 ms" from a fixture: a latency, in the slot an
    // operator reads as their safety margin.
    const delay = summariseRouteQuality([row('ready', 45)]).recommendedDelay;
    expect(delay).toBe('45 s');
    expect(delay).not.toMatch(/ms/u);
  });
});
