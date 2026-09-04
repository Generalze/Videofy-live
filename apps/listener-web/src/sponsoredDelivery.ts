/** @author masterzee001 */
/**
 * What this programme's sponsored slot should show, asked of the service.
 *
 * READ-ONLY AND PUBLIC. This is the delivery endpoint, not the operator one: it
 * returns the effective creative and nothing else -- no schedule, no revision,
 * no draft. A viewer has no use for when an advert is due to change, and an
 * advertiser might well mind them knowing.
 *
 * A FAILURE FALLS BACK TO THE HOUSE CREATIVE, NEVER TO A PROGRAMME ONE. The
 * canonical house creative needs no storage and is always safe to show. What
 * this must never do is invent, cache or guess a programme's own creative:
 * showing an advert that is not currently sold is worse than showing ours.
 */

import {
  HOUSE_CREATIVE,
  SPONSORED_PLACEMENT,
  type SponsoredCreative,
} from '@videofy-live/shared-types';

export interface DeliveredCreative {
  readonly source: 'programme' | 'house';
  readonly placement: string;
  readonly creative: SponsoredCreative;
}

/** The safe answer whenever the service cannot be reached or does not know. */
export const HOUSE_DELIVERY: DeliveredCreative = {
  source: 'house',
  placement: SPONSORED_PLACEMENT,
  creative: HOUSE_CREATIVE,
};

export async function fetchSponsoredCreative(
  accountBase: string,
  programmeId: string,
  doFetch: typeof fetch = fetch,
): Promise<DeliveredCreative> {
  if (programmeId.trim() === '') return HOUSE_DELIVERY;
  try {
    const response = await doFetch(
      `${accountBase.replace(/\/$/u, '')}/programmes/${encodeURIComponent(programmeId)}/sponsored-creative`,
    );
    if (!response.ok) return HOUSE_DELIVERY;
    const body = (await response.json()) as Partial<DeliveredCreative>;
    const creative = body.creative;
    if (
      typeof creative !== 'object' || creative === null ||
      typeof creative.headline !== 'string' || typeof creative.body !== 'string' ||
      typeof creative.cta !== 'string'
    ) {
      // A malformed answer is not a programme creative. Fall back rather than
      // render half a card.
      return HOUSE_DELIVERY;
    }
    return {
      source: body.source === 'programme' ? 'programme' : 'house',
      placement: typeof body.placement === 'string' ? body.placement : SPONSORED_PLACEMENT,
      creative: {
        headline: creative.headline,
        body: creative.body,
        cta: creative.cta,
        href: typeof creative.href === 'string' ? creative.href : null,
      },
    };
  } catch {
    return HOUSE_DELIVERY;
  }
}
