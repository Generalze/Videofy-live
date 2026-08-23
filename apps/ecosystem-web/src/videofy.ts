/**
 * The VIDEOFY product family, and what may be said about each member.
 *
 * ONE product in this family exists. The other four are named and being built,
 * and the difference has to survive every visual treatment applied to them:
 * four handsome cards in a row read as four products you can buy, whatever the
 * small text says. So availability is a typed field, only one member may carry
 * `available`, and a test enforces it.
 */

export type VideofyStatus = 'available' | 'coming-soon' | 'in-development';

export const VIDEOFY_STATUS_LABEL: Readonly<Record<VideofyStatus, string>> = {
  available: 'Available now',
  'coming-soon': 'Coming soon',
  'in-development': 'In development',
};

export interface VideofyProduct {
  readonly id: string;
  readonly name: string;
  readonly status: VideofyStatus;
  readonly summary: string;
  /** Only the shipped product gets a destination. */
  readonly explorePath: string | null;
}

export const VIDEOFY_FAMILY: readonly VideofyProduct[] = [
  {
    id: 'live',
    name: 'VIDEOFY-LIVE',
    status: 'available',
    summary: 'Real-time multilingual communication for calls, conferences and live programmes.',
    explorePath: '/videofy/live/',
  },
  {
    id: 'studio',
    name: 'VIDEOFY STUDIO',
    status: 'coming-soon',
    summary: 'AI-assisted video creation and editing.',
    explorePath: null,
  },
  {
    id: 'watch',
    name: 'VIDEOFY WATCH',
    status: 'coming-soon',
    summary: 'Creator content viewing and discovery.',
    explorePath: null,
  },
  {
    id: 'promote',
    name: 'VIDEOFY PROMOTE',
    status: 'coming-soon',
    summary: 'Audience growth and promotion.',
    explorePath: null,
  },
  {
    id: 'vid-ai',
    name: 'VID AI',
    status: 'in-development',
    summary: 'The intelligence layer powering the Videofy ecosystem.',
    explorePath: null,
  },
];

/**
 * The three live experiences, for the VIDEOFY-LIVE product page.
 *
 * Each is a real thing the platform does today. The copy describes what a
 * person sees and hears, not how it is built: nobody choosing a product needs
 * to know there is speech recognition, translation and synthesis behind it, and
 * naming them invites comparison on the wrong axis.
 */
export interface LiveExperience {
  readonly id: 'call' | 'conference' | 'programme';
  readonly eyebrow: string;
  readonly title: string;
  readonly body: string;
}

export const LIVE_EXPERIENCES: readonly LiveExperience[] = [
  {
    id: 'call',
    eyebrow: 'Personal calls',
    title: 'Two people. Two languages. One conversation.',
    // Careful wording. "Progressively" is the honest word: translated speech
    // begins before the sentence is finished, and does NOT replace the speaker
    // instantaneously. Claiming otherwise sets an expectation the product will
    // be judged against on first use.
    body: 'Talk naturally while Videofy progressively interprets the conversation into each participant’s selected supported language.',
  },
  {
    id: 'conference',
    eyebrow: 'Conferences',
    // "their own language" promises universal availability. What is true is
    // that each listener picks from the languages that are supported.
    title: 'One speaker. Each listener in the language they choose.',
    body: 'One person speaks, and each participant receives the conversation in their selected supported language — from a single spoken source.',
  },
  {
    id: 'programme',
    eyebrow: 'Live programmes',
    title: 'An audience, each choosing how they listen.',
    body: 'A live source interpreted for the audience, with each viewer choosing a supported language and how they want to hear it.',
  },
];

/**
 * LANGUAGE ROLLOUT TRUTH.
 *
 * English is the baseline source; Spanish is the first validated target. The
 * architecture is general, but a demo screen showing five languages is a claim
 * that five languages are operationally available today, and it is the kind of
 * claim a visitor tests by trying one.
 *
 * Additional languages are activated as they are validated. Anything added here
 * is an assertion that it works in production.
 */
export const VALIDATED_LANGUAGES: readonly string[] = ['English', 'Spanish'];

export const LANGUAGE_ROLLOUT_NOTE =
  'Additional languages are activated as they are validated.';

/** The listening modes a viewer actually chooses between. Real product terms. */
export const LISTENING_MODES: readonly { name: string; description: string }[] = [
  { name: 'Original', description: 'The source audio, untouched.' },
  { name: 'Interpretation', description: 'Interpreted speech alongside the original.' },
  { name: 'Replacement', description: 'Interpreted speech in place of the original.' },
];

/**
 * The environments VIDEOFY-LIVE reaches, and the ones it is being built to
 * reach. `reach` is what the convergence visual reads to decide its treatment,
 * so a planned environment cannot be drawn as a working one by styling alone.
 */
export type SurfaceReach = 'working' | 'in-development' | 'network-expansion';

export const SURFACE_REACH_LABEL: Readonly<Record<SurfaceReach, string>> = {
  working: 'Working today',
  'in-development': 'In development',
  'network-expansion': 'Network expansion',
};

export interface CommunicationSurface {
  readonly label: string;
  readonly reach: SurfaceReach;
}

export const COMMUNICATION_SURFACES: readonly CommunicationSurface[] = [
  { label: 'Browser', reach: 'working' },
  { label: 'Personal calls', reach: 'working' },
  { label: 'Conferences', reach: 'working' },
  { label: 'Live programmes', reach: 'working' },
  { label: 'Uploaded programmes', reach: 'working' },
  { label: 'SIP / RTP media', reach: 'working' },
  { label: 'Native mobile app', reach: 'in-development' },
  { label: 'IP telephony endpoints', reach: 'network-expansion' },
  { label: 'GSM / PSTN carriers', reach: 'network-expansion' },
  { label: 'Device integration', reach: 'network-expansion' },
  { label: 'OEM / phone platforms', reach: 'network-expansion' },
];

/** The uploaded-programme journey, as a viewer would understand it. */
export const UPLOADED_PROGRAMME_FLOW: readonly string[] = [
  'An uploaded programme',
  'Understood as speech',
  'Translated',
  'Spoken in the target language',
  'Heard in the supported language the listener chose',
];
