/** @author masterzee001 */
/** The creative the sponsored slot shows until the operator console supplies one. */
export interface SponsoredCreative {
  readonly headline: string;
  readonly body: string;
  readonly cta: string;
  readonly href?: string | undefined;
}

export const HOUSE_CREATIVE: SponsoredCreative = {
  headline: 'Your message, in every language.',
  body: 'C7 programmes reach audiences in the language they think in.',
  cta: 'Learn more',
  href: 'https://consummate7.com/videofy/live/',
};
