/** @vitest-environment jsdom */
/** @author masterzee001 */
/**
 * What the operator console does when a read does not come back.
 *
 * THE BUG THESE PIN. Both views held one nullable value that meant two
 * different things: "the request has not answered yet" and "the request failed
 * and nobody wrote the failure down". A non-forbidden failure left the value
 * null, so the console rendered "Loading applicants..." -- and kept rendering it
 * for as long as the operator was willing to wait. The detail view had the same
 * seam with a twist: it DID record the error, into `notice`, and then returned
 * the loading line before anything could render it. An operator staring at a
 * spinner cannot tell a slow service from a dead one, and the honest answer was
 * already sitting in a variable.
 *
 * NOTHING IS MOCKED BETWEEN THE COMPONENT AND THE WIRE. `global.fetch` is the
 * only stub: the real `createSpecialistAdminApi`, the real `request()` and its
 * real classification of statuses and bodies all run. That matters because the
 * property under test is that the console prints THE API LAYER'S sentence --
 * a test that handed the component a pre-made error object would prove the
 * renderer works and prove nothing about which sentence reaches the operator.
 *
 * AND THE REFUSAL STAYS A REFUSAL. 401 and 404 must keep producing the
 * not-found screen with no reason attached; the whole point of that status is
 * to withhold what a friendlier error message would hand back.
 */
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpecialistsConsole } from './SpecialistsConsole';
import { pathForApplicant, pathForApplicants } from './route';

/* --------------------------------------------------------------- fixtures */

const LIST = {
  applicants: [
    {
      accountId: 'acct_alice',
      progress: 'UNDER_REVIEW',
      appliedAtMs: 1_788_000_000_000,
      updatedAtMs: 1_788_000_000_000,
      country: 'Nigeria',
      timeZone: 'Africa/Lagos',
      languages: [],
    },
  ],
  states: ['APPLIED', 'UNDER_REVIEW'],
  capabilities: [],
};

function detailFor(accountId: string): Record<string, unknown> {
  return {
    accountId,
    progress: 'UNDER_REVIEW',
    appliedAtMs: 1_788_000_000_000,
    country: 'Nigeria',
    timeZone: 'Africa/Lagos',
    motivation: `motivation of ${accountId}`,
    languages: [],
    capabilities: [],
    assignments: [],
    voice: { state: 'NOT_INVITED', voiceRightsGranted: false },
  };
}

/** A `Response` in the only three respects `request()` actually reads. */
function reply(status: number, body: string): unknown {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

const json = (status: number, value: unknown): unknown => reply(status, JSON.stringify(value));

/* ----------------------------------------------------------------- harness */

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  window.history.pushState({}, '', pathForApplicants());
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** Render and let every queued microtask -- i.e. the fetch -- settle. */
async function mount(): Promise<void> {
  await act(async () => {
    root.render(<SpecialistsConsole />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

const text = (): string => container.textContent ?? '';

function retryButton(): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === 'Retry',
  );
  expect(button, 'no Retry button on the failure screen').toBeDefined();
  return button as HTMLButtonElement;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/* ------------------------------------------------------------- applicants */

describe('the applicant list, when the read does not come back', () => {
  it('A: a network failure is visible, and the loading line is gone', async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    await mount();

    expect(text()).not.toContain('Loading applicants');
    expect(text()).toContain('Could not load applicants');
    // The API layer's own sentence for an unreachable service, verbatim.
    expect(text()).toContain('Could not reach the account service.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('B: a 200 that is not JSON is reported as unreadable, not as an empty list', async () => {
    // What a deployment whose proxy does not route the account prefix actually
    // returns: the SPA shell, with status 200.
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, '<!doctype html><title>app</title>')));

    await mount();

    expect(text()).not.toContain('Loading applicants');
    expect(text()).toContain('Could not load applicants');
    expect(text()).toContain('The account service answered with something this console could not read.');
    // And emphatically NOT the empty-list reading of the same response.
    expect(text()).not.toContain('0 applicants');
  });

  it('C: 404 and 401 keep the not-found screen and leak no reason', async () => {
    for (const status of [404, 401]) {
      vi.stubGlobal('fetch', vi.fn(async () => json(status, { error: 'not on the allowlist' })));
      await mount();

      expect(text(), `status ${status}`).toContain('Not found');
      expect(text(), `status ${status}`).not.toContain('Could not load applicants');
      // The server's own words about WHY must not survive the boundary.
      for (const leak of ['allowlist', 'not authorized', 'not authorised', 'operator allowlist']) {
        expect(text().toLowerCase(), `${status} leaked ${leak}`).not.toContain(leak.toLowerCase());
      }

      act(() => root.unmount());
      container.remove();
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      window.history.pushState({}, '', pathForApplicants());
    }
  });

  it('E: Retry issues a real request, and a success replaces the error with data', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new TypeError('Failed to fetch');
      })
      .mockImplementationOnce(async () => json(200, LIST));
    vi.stubGlobal('fetch', fetchMock);

    await mount();
    expect(text()).toContain('Could not load applicants');

    await click(retryButton());

    // A SECOND REAL CALL, not a re-render of a cached rejection.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toContain('/admin/language-specialists');
    expect(text()).not.toContain('Could not load applicants');
    expect(text()).toContain('Language specialists');
    expect(text()).toContain('acct_alice');
  });
});

/* --------------------------------------------------------- applicant detail */

describe('the applicant detail, when the read does not come back', () => {
  beforeEach(() => {
    window.history.pushState({}, '', pathForApplicant('acct_alice'));
  });

  it('D: an initial network failure is visible, and the loading line is gone', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    await mount();

    expect(text()).not.toContain('Loading applicant');
    expect(text()).toContain('Could not load applicant');
    expect(text()).toContain('Could not reach the account service.');
  });

  it('D: Retry reloads through the same real path', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        throw new TypeError('Failed to fetch');
      })
      .mockImplementationOnce(async () => json(200, detailFor('acct_alice')));
    vi.stubGlobal('fetch', fetchMock);

    await mount();
    expect(text()).toContain('Could not load applicant');

    await click(retryButton());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(text()).not.toContain('Could not load applicant');
    expect(text()).toContain('acct_alice');
  });

  it('F: moving to another applicant never shows the previous one under the new id', async () => {
    /*
     * The dangerous frame is the one BETWEEN the two reads. If the mounted
     * component keeps the applicant it already has, the page shows acct_alice's
     * qualification under a breadcrumb that says acct_bola -- and the next
     * click on that page records a decision.
     *
     * The second read is left PENDING on purpose: that is exactly the window in
     * which the stale render would appear.
     */
    let releaseSecond: (value: unknown) => void = () => undefined;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => json(200, detailFor('acct_alice')))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseSecond = resolve;
          }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await mount();
    expect(text()).toContain('motivation of acct_alice');

    await act(async () => {
      window.history.pushState({}, '', pathForApplicant('acct_bola'));
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(text()).not.toContain('motivation of acct_alice');
    expect(text()).toContain('Loading applicant');

    await act(async () => {
      releaseSecond(json(200, detailFor('acct_bola')));
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(text()).toContain('motivation of acct_bola');
    expect(text()).not.toContain('motivation of acct_alice');
  });
});
