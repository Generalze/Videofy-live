/** @author masterzee001 */
/**
 * The programme's sponsored creative, read from the public delivery endpoint.
 *
 * SAME ENDPOINT AS THE WEB PLAYER, same shape, same fallback. Two clients
 * asking two different services what to show is how the phone and the browser
 * end up displaying different adverts for one programme.
 *
 * A FAILURE FALLS BACK TO THE HOUSE CREATIVE AND NEVER FABRICATES A PROGRAMME
 * ONE. The house creative needs no storage and is always safe to show; showing
 * a programme creative that is not currently sold is not.
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

/**
 * What the call to action should DO, decided away from the component.
 *
 * Extracted so it can be tested without a renderer: mobile's suite runs in
 * node, and the two things worth proving here -- that a creative with no
 * destination gets no press handler, and that a failed open does not take the
 * programme down with it -- are behaviour, not layout.
 *
 * Returns null when there is nothing to open. A button that responds to a tap
 * by doing nothing reads as broken, so the component renders plain text
 * instead.
 */
export function creativeOpener(
  href: string | null,
  opener: (url: string) => Promise<unknown> = () => Promise.resolve(),
): (() => void) | null {
  if (href === null || href.trim() === '') return null;
  return () => {
    /*
     * SWALLOWED DELIBERATELY. `openURL` rejects when the device has nothing
     * registered for the address, and an unhandled rejection here would crash a
     * listener out of a live programme over an advert.
     */
    void Promise.resolve(opener(href)).catch(() => undefined);
  };
}
