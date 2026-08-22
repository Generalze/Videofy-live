/**
 * The public face of the C7 ecosystem.
 *
 * PUBLIC DISCLOSURE POLICY LIVES HERE, in one file, deliberately. Spread this
 * copy through components and the rules stop being rules: one card gets a
 * detail another was refused, and nobody notices until it is on the internet.
 *
 * Two things this file will not do:
 *
 *   1. Describe Sentinel beyond its locked paragraph. No modules, no
 *      architecture, no capabilities, no internal names.
 *   2. Describe Finance at all beyond "under development". No trading logic,
 *      no execution model, no instruments, no performance.
 *
 * Domains 6 and 7 exist and are INTERNAL. They are absent from this file rather
 * than present-and-hidden, because a card that says "Reserved" is still an
 * announcement.
 *
 * The percentages are a PRESENTATION choice about public momentum. They are not
 * derived from any engineering metric, and nothing should ever compute them.
 */

export type DomainStatus =
  | { readonly kind: 'available'; readonly label: string }
  | { readonly kind: 'progress'; readonly percent: number; readonly label: string }
  | { readonly kind: 'locked'; readonly label: string }
  | { readonly kind: 'emerging'; readonly label: string };

export interface EcosystemDomain {
  readonly id: string;
  /** The DOMAIN — the field of work. Domains are permanent; products are not. */
  readonly domain: string;
  /** The product within it, where one is public. */
  readonly product: string | null;
  readonly status: DomainStatus;
  readonly summary: string;
  /** Extra locked copy shown on the card, verbatim, or null. */
  readonly detail: string | null;
  /** Drives the card's visual treatment. */
  readonly tone: 'flagship' | 'concealed' | 'emerging' | 'sealed' | 'quiet';
}

export const ECOSYSTEM_DOMAINS: readonly EcosystemDomain[] = [
  {
    id: 'communication',
    domain: 'Communication & Connection',
    product: 'VIDE0FY-LIVE',
    status: { kind: 'available', label: 'Available now' },
    summary: 'Real-time multilingual communication for calls, conferences and live programmes.',
    detail: null,
    tone: 'flagship',
  },
  {
    id: 'protection',
    domain: 'Protection & Security',
    product: 'SENTINEL-A',
    status: { kind: 'progress', percent: 56, label: 'In development' },
    // LOCKED COPY. Verbatim, and the only thing said publicly about Sentinel.
    summary: 'Intelligence for protection, awareness and coordinated response.',
    detail:
      'A next-generation security platform being developed within the Consummate 7 ecosystem.',
    tone: 'concealed',
  },
  {
    id: 'health-safety-environment',
    domain: 'Health, Safety & Environment',
    // No product name: none exists authoritatively, and inventing one now would
    // be a naming decision made by a marketing page.
    product: null,
    status: { kind: 'progress', percent: 20, label: 'Early development' },
    summary: 'Building intelligence for safer everyday decisions.',
    detail:
      'A new C7 platform focused on helping people better understand risks across health, safety, products and their environment.',
    tone: 'emerging',
  },
  {
    id: 'finance',
    domain: 'Finance & Markets',
    product: null,
    status: { kind: 'locked', label: 'Locked' },
    summary: 'A C7 system currently under development.',
    // Nothing further. The restraint is the message.
    detail: null,
    tone: 'sealed',
  },
  {
    id: 'media',
    domain: 'Media & Entertainment',
    product: null,
    status: { kind: 'emerging', label: 'Emerging' },
    summary: 'An emerging C7 domain.',
    detail: null,
    tone: 'quiet',
  },
];

/**
 * VIDE0FY-LIVE capabilities, split by what is TRUE TODAY and what is not.
 *
 * The split is the point. "Works in a browser today" and "could one day reach a
 * carrier network" are both honest statements and belong in different columns;
 * printed in one list they become a claim that the second already happened.
 */
export interface CapabilityGroup {
  readonly heading: string;
  readonly qualifier: string;
  readonly items: readonly string[];
}

export const VIDEOFY_CAPABILITIES: readonly CapabilityGroup[] = [
  {
    heading: 'Working today',
    qualifier: 'Built, tested and running.',
    items: [
      'Real-time multilingual conversation',
      'Progressive translated speech',
      'Live captions',
      'Personal calls and conference architecture',
      'Live programme interpretation',
      'Uploaded programme interpretation',
      'Several target languages from one spoken sentence',
      'Interpretation, Replacement and Original listening modes',
      'Delivered in the browser, nothing to install',
      'Operator and Viewer programme experiences',
      'SIP / RTP translated media infrastructure',
      'Provider-neutral multilingual architecture',
    ],
  },
  {
    heading: 'In development',
    qualifier: 'Being built now.',
    items: ['Native mobile application'],
  },
  {
    heading: 'Network expansion',
    qualifier:
      'Architectural direction, not shipped capability. These are the environments the platform is being built to reach.',
    items: [
      'SIP endpoints and IP telephony',
      'Broader GSM / PSTN and carrier connectivity',
      'Device-level integration',
      'Potential OEM and phone-platform integration',
    ],
  },
];

/** The environments the platform is designed to span, for the network figure. */
export const VIDEOFY_SURFACES: readonly { label: string; live: boolean }[] = [
  { label: 'Browser', live: true },
  { label: 'Conference', live: true },
  { label: 'Live programme', live: true },
  { label: 'SIP / IP phone', live: true },
  { label: 'Mobile', live: false },
  { label: 'Carrier network', live: false },
];
