/** @author masterzee001 */
/**
 * THE PROGRAMME'S SPONSORED CREATIVE -- one contract, serialisable, shared.
 *
 * WHY IT LIVES HERE. Two copies of this existed: `SponsoredCreative` in
 * listener-web with an `href`, and `AdCreative` in mobile with an `onPress`
 * callback. Same house copy typed twice, in shapes that could not both be sent
 * over a wire. A server modelled on either one silently breaks the other, and
 * the third copy is always the one that drifts. So there is one definition, it
 * is serialisable, and NOTHING in it is a function.
 *
 * THE HOUSE CREATIVE IS DEFINED ONCE, here, for the same reason: it is what
 * every viewer sees whenever a programme has not supplied its own, so two
 * copies of it means two different fallbacks depending on which app you opened.
 *
 * EFFECTIVE STATE IS DECIDED BY THE SERVICE, not by a client. The window
 * evaluation below is exported so the service can run it; no client re-derives
 * it, because a phone with a wrong clock would otherwise show an advert its
 * schedule forbids and nothing anywhere would disagree.
 */

/** What a viewer actually sees. Serialisable: no callbacks, ever. */
export interface SponsoredCreative {
  readonly headline: string;
  readonly body: string;
  readonly cta: string;
  /**
   * Optional external destination. HTTPS only -- see `isSafeCreativeHref`.
   *
   * Null rather than absent when there is none, so "no link" is a value the
   * wire carries rather than a key somebody forgot to send.
   */
  readonly href: string | null;
}

/** The creative plus the operator's configuration of it. */
export interface ProgrammeSponsoredCreative extends SponsoredCreative {
  /**
   * "Use the programme's own creative", NOT "advertising is on".
   *
   * Turning this off does not give a viewer an advert-free programme -- the
   * slot is a reserved first-class placement and falls back to the house
   * creative. Naming it `enabled` on the wire is fine; naming it
   * "Advertising enabled" in the UI would be a promise we do not keep.
   */
  readonly enabled: boolean;
  /** ISO 8601, canonicalised, or null for "no start bound". */
  readonly startsAt: string | null;
  /** ISO 8601, canonicalised, or null for "no end bound". */
  readonly endsAt: string | null;
}

/**
 * THE ONE canonical house creative.
 *
 * Shown whenever a programme has none, has disabled its own, or is outside its
 * window. Every surface imports this; none of them writes its own copy.
 */
export const HOUSE_CREATIVE: SponsoredCreative = {
  headline: 'Your message, in every language.',
  body: 'C7 programmes reach audiences in the language they think in.',
  cta: 'Learn more',
  href: 'https://consummate7.com/videofy/live/',
};

/** Slice 1 has exactly one placement. Not a targeting model. */
export const SPONSORED_PLACEMENT = 'programme-sponsored-slot';

/**
 * Why a viewer is seeing what they are seeing.
 *
 * Five states, because five different things are true and an operator does
 * something different about each. `house-active` covers "you have no creative"
 * as well as the three ways yours is not currently showing -- those are
 * distinguished by the state itself, not by the source.
 */
export type SponsoredEffectiveState =
  | 'programme-active'
  | 'scheduled'
  | 'programme-disabled'
  | 'window-ended'
  | 'house-active';

export interface EffectiveSponsoredCreative {
  readonly programmeId: string;
  readonly placement: string;
  readonly source: 'programme' | 'house';
  readonly creative: SponsoredCreative;
  readonly state: SponsoredEffectiveState;
  /** Plain sentence for the operator. Composed once, here. */
  readonly explanation: string;
}

/**
 * IS THIS LINK SAFE TO PUT IN FRONT OF A VIEWER?
 *
 * `href` is untrusted operator input that ends up in an anchor on the web and
 * in a platform URL opener on a phone. `javascript:` in an anchor executes;
 * `data:` can carry a document that impersonates us; `file:` and custom schemes
 * reach the device. None of React, React Native or the platform opener makes an
 * unsafe scheme safe, so it is refused HERE, at the server boundary, and never
 * stored.
 *
 * HTTPS ONLY, and PARSED rather than prefix-matched. Parsing is what makes the
 * decision trustworthy in both directions: `javascript:alert(1)` is refused
 * however it is spelled or spaced, and odd-looking spellings of ordinary
 * addresses (`https:evil`, which the URL spec resolves to `https://evil/`) are
 * correctly accepted instead of being refused for looking strange. A
 * prefix check gets both of those wrong.
 */
export function isSafeCreativeHref(href: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    // Not absolute, or not a URL at all. A relative link has no meaning to a
    // viewer leaving our page anyway.
    return false;
  }
  // Plain HTTP is excluded too: an advertiser destination sent over a network
  // somebody else controls is a downgrade we would be handing the viewer.
  if (parsed.protocol !== 'https:') return false;
  // A URL can parse with an empty host (`https:///`), which navigates nowhere.
  return parsed.hostname !== '';
}

/**
 * An ISO timestamp in canonical form, or null when it is not a timestamp.
 *
 * Canonicalised server-side so two operators typing the same moment in
 * different offsets produce the same stored string, and so comparisons later
 * are string-stable rather than parser-dependent.
 */
export function canonicaliseTimestamp(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = new Date(trimmed);
  const time = parsed.getTime();
  if (Number.isNaN(time)) return null;
  return parsed.toISOString();
}

export interface CreativeProblem {
  readonly field: string;
  readonly message: string;
}

export type CreativeValidation =
  | { readonly ok: true; readonly value: ProgrammeSponsoredCreative }
  | { readonly ok: false; readonly problems: readonly CreativeProblem[] };

/** Trimmed, and refused when empty. A blank headline is not a creative. */
function requireText(
  raw: unknown,
  field: string,
  problems: CreativeProblem[],
  max = 200,
): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    problems.push({ field, message: `${field} is required.` });
    return '';
  }
  const trimmed = raw.trim();
  if (trimmed.length > max) {
    problems.push({ field, message: `${field} must be ${max} characters or fewer.` });
    return trimmed.slice(0, max);
  }
  return trimmed;
}

/**
 * Validate and canonicalise what an operator submitted.
 *
 * Everything a client could get wrong is decided here, once, on the server
 * side of the boundary -- so a second client (there are already two) cannot
 * enforce a different rule and store something the first would have refused.
 */
export function validateProgrammeCreative(input: unknown): CreativeValidation {
  const problems: CreativeProblem[] = [];
  if (typeof input !== 'object' || input === null) {
    return { ok: false, problems: [{ field: 'body', message: 'A creative object is required.' }] };
  }
  const raw = input as Record<string, unknown>;

  const headline = requireText(raw['headline'], 'headline', problems, 120);
  const body = requireText(raw['body'], 'body', problems, 300);
  const cta = requireText(raw['cta'], 'cta', problems, 40);

  // ABSENT IS VALID. A creative with no destination is a legitimate message.
  let href: string | null = null;
  const rawHref = raw['href'];
  if (typeof rawHref === 'string' && rawHref.trim() !== '') {
    const candidate = rawHref.trim();
    if (!isSafeCreativeHref(candidate)) {
      problems.push({
        field: 'href',
        message:
          'The destination must be an absolute https:// address. ' +
          'Other schemes are refused because they can run code or impersonate a page.',
      });
    } else {
      /*
       * STORED IN CANONICAL FORM, for the same reason timestamps are: two
       * spellings of one address (`https:evil` and `https://evil/`) become one
       * stored string, so a web anchor and a mobile URL opener cannot end up
       * normalising it differently between them.
       */
      href = new URL(candidate).href;
    }
  } else if (rawHref !== undefined && rawHref !== null && typeof rawHref !== 'string') {
    problems.push({ field: 'href', message: 'The destination must be text.' });
  }

  const enabled = raw['enabled'] === true;

  const startsAt = readBound(raw['startsAt'], 'startsAt', problems);
  const endsAt = readBound(raw['endsAt'], 'endsAt', problems);

  if (startsAt !== null && endsAt !== null && startsAt >= endsAt) {
    problems.push({
      field: 'endsAt',
      message: 'The end time must be after the start time.',
    });
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value: { headline, body, cta, href, enabled, startsAt, endsAt } };
}

function readBound(
  raw: unknown,
  field: string,
  problems: CreativeProblem[],
): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    problems.push({ field, message: `${field} must be an ISO timestamp or empty.` });
    return null;
  }
  if (raw.trim() === '') return null;
  const canonical = canonicaliseTimestamp(raw);
  if (canonical === null) {
    problems.push({ field, message: `${field} is not a valid date and time.` });
    return null;
  }
  return canonical;
}

/**
 * WHAT THIS PROGRAMME'S VIEWERS SHOULD SEE RIGHT NOW.
 *
 * Evaluated at READ TIME. There is no cron, no background scheduler and no
 * timer that mutates anything: a window is a pair of bounds compared against
 * the clock when somebody asks. A scheduler would be a second source of truth
 * that can be down, be late, or be running twice.
 *
 * The `now` is supplied by the caller so the SERVICE's clock decides, never a
 * viewer's device.
 */
export function evaluateEffectiveCreative(
  programmeId: string,
  configured: ProgrammeSponsoredCreative | null,
  now: Date,
): EffectiveSponsoredCreative {
  const house = {
    programmeId,
    placement: SPONSORED_PLACEMENT,
    source: 'house' as const,
    creative: HOUSE_CREATIVE,
  };

  if (configured === null) {
    return {
      ...house,
      state: 'house-active',
      explanation:
        'This programme has no creative of its own, so the reserved slot shows ' +
        'the house creative.',
    };
  }

  if (!configured.enabled) {
    return {
      ...house,
      state: 'programme-disabled',
      explanation:
        'The programme creative is saved but switched off. The slot is a ' +
        'reserved placement, so viewers see the house creative rather than nothing.',
    };
  }

  const at = now.getTime();

  if (configured.startsAt !== null && at < new Date(configured.startsAt).getTime()) {
    return {
      ...house,
      state: 'scheduled',
      explanation:
        `The programme creative starts at ${configured.startsAt}. Until then the ` +
        'slot shows the house creative.',
    };
  }

  if (configured.endsAt !== null && at >= new Date(configured.endsAt).getTime()) {
    return {
      ...house,
      state: 'window-ended',
      explanation:
        `The programme creative ended at ${configured.endsAt}. The slot has ` +
        'returned to the house creative.',
    };
  }

  return {
    programmeId,
    placement: SPONSORED_PLACEMENT,
    source: 'programme',
    creative: {
      headline: configured.headline,
      body: configured.body,
      cta: configured.cta,
      href: configured.href,
    },
    state: 'programme-active',
    explanation: 'Viewers are seeing this programme’s own creative.',
  };
}
