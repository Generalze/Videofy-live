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
  /**
   * The CANONICAL domain number in the seven-domain architecture.
   *
   * Fixed, and deliberately NOT the position in this array. The homepage shows
   * Health before Finance because Health is the next domain to emerge publicly;
   * that is a presentation decision and must never be mistaken for the
   * architecture. Leave the number implicit and somebody eventually reads the
   * display order as the ontology -- which is how Finance quietly becomes
   * domain 4 in a document nobody meant to write.
   *
   * Canonical: 1 Communication, 2 Protection, 3 Finance, 4 Health/Safety/
   * Environment, 5 Media, 6 and 7 reserved and internal.
   */
  readonly canonicalDomain: 1 | 2 | 3 | 4 | 5;
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
  /**
   * The one shipped product inside a domain, called out on the C7 homepage.
   *
   * The C7 page names the FAMILY and points at it. The family's own page names
   * its members, and the product's page explains the product. Explaining a
   * product on the parent-company homepage is how a parent-company homepage
   * turns into that product's homepage.
   */
  readonly highlight?: {
    readonly name: string;
    readonly status: string;
    readonly lines: readonly string[];
  };
}

/**
 * PUBLIC DISPLAY ORDER, which is intentionally not the canonical order.
 *
 *   VIDEOFY-LIVE -> SENTINEL-A -> Health, Safety & Environment ->
 *   Finance & Markets -> Media & Entertainment
 *
 * Health is shown before Finance because it is the next domain to emerge
 * publicly, while Finance stays locked. Each entry carries its canonical number
 * so the two orderings can never be confused for one another.
 */
export const ECOSYSTEM_DOMAINS: readonly EcosystemDomain[] = [
  {
    id: 'communication',
    canonicalDomain: 1,
    domain: 'Communication & Connection',
    // The FAMILY, not the product. VIDEOFY-LIVE is what shipped inside it.
    product: 'VIDEOFY',
    status: { kind: 'available', label: 'Available now' },
    summary:
      'A connected communication and media ecosystem built around removing barriers between people, languages and experiences.',
    detail: null,
    tone: 'flagship',
    highlight: {
      name: 'VIDEOFY-LIVE',
      status: 'Available now',
      lines: ['Calls', 'Conferences', 'Live programmes', 'Multilingual communication'],
    },
  },
  {
    id: 'protection',
    canonicalDomain: 2,
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
    canonicalDomain: 4,
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
    canonicalDomain: 3,
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
    canonicalDomain: 5,
    domain: 'Media & Entertainment',
    product: null,
    status: { kind: 'emerging', label: 'Emerging' },
    summary: 'An emerging C7 domain.',
    detail: null,
    tone: 'quiet',
  },
];

/**
 * VIDEOFY-LIVE capabilities, split by what is TRUE TODAY and what is not.
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
