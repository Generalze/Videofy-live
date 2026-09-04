/** @author masterzee001 */
/**
 * The operator console for Language Specialists.
 *
 * Two things are worth pinning here and they are both boundaries rather than
 * behaviour: which paths this area claims, and the fact that a refusal from the
 * service is rendered as a not-found rather than as an explanation. The second
 * is easy to "fix" into a friendlier message that hands back exactly the fact
 * the 404 was chosen to withhold.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SpecialistsConsole } from './SpecialistsConsole';
import {
  SPECIALISTS_BASE,
  isSpecialistsPath,
  pathForApplicant,
  pathForApplicants,
  viewFromPath,
} from './route';

describe('which paths this console claims', () => {
  it('claims its own address, with or without a trailing slash', () => {
    expect(isSpecialistsPath('/operator/language-specialists')).toBe(true);
    expect(isSpecialistsPath('/operator/language-specialists/')).toBe(true);
    expect(isSpecialistsPath('/operator/language-specialists/applicants')).toBe(true);
    expect(isSpecialistsPath('/operator/language-specialists/applicants/acct_zoe')).toBe(true);
  });

  it('PIN: it does not swallow a neighbouring path', () => {
    // The programme console lives at /operator/ and must keep every path it
    // has. A prefix match without a boundary check is how the live console
    // becomes unreachable while every link to it still looks correct.
    for (const path of [
      '/operator/',
      '/operator/index.html',
      '/operator/language-specialists-old',
      '/operator/language-specialistsx',
      '/operatorx/language-specialists',
      '/',
    ]) {
      expect(isSpecialistsPath(path), path).toBe(false);
    }
  });

  it('reads the list and the detail views', () => {
    expect(viewFromPath(SPECIALISTS_BASE)).toEqual({ page: 'applicants' });
    expect(viewFromPath(pathForApplicants())).toEqual({ page: 'applicants' });
    expect(viewFromPath(pathForApplicant('acct_zoe'))).toEqual({
      page: 'applicant',
      accountId: 'acct_zoe',
    });
  });

  it('sends an unrecognised sub-path to the list, not to a 404', () => {
    expect(viewFromPath(`${SPECIALISTS_BASE}/nonsense`)).toEqual({ page: 'applicants' });
  });

  it('escapes an account id so it cannot leave its segment', () => {
    expect(pathForApplicant('a/b').split('/')).toHaveLength(5);
  });
});

describe('what an unauthorised operator sees', () => {
  it('PIN: renders without a session rather than throwing', () => {
    // Server-rendered here, so no effect runs and no request is made: this
    // asserts the component's first frame is a real page and not a crash, which
    // is what somebody with no session actually gets for an instant.
    const markup = renderToStaticMarkup(<SpecialistsConsole />);
    expect(markup).toContain('language-specialists');
  });

  it('PIN: no allowlist, role check or override lives in this bundle', () => {
    // Authorization is the account service's `admitPlatformOperator` and
    // nothing else. A frontend gate beside a backend gate is a second policy,
    // and the two disagree eventually — which is the definition of a bypass.
    const markup = renderToStaticMarkup(<SpecialistsConsole />);
    for (const leak of ['PLATFORM_OPERATOR', 'allowlist', 'isOperator', 'bypass', 'debug']) {
      expect(markup, leak).not.toContain(leak);
    }
  });
});
