/** @author masterzee001 */
/**
 * The Language Specialist API, as a browser sees it.
 *
 * ONE PLACE THAT KNOWS THE WIRE, and every function takes the token explicitly.
 * Nothing here reads storage: the shell owns the session (see `session.ts`,
 * which is the only reader and writer of the two session keys on this origin)
 * and this module owns only shapes. When these were mixed, the operator console
 * and the public site disagreed about whether somebody was signed in.
 *
 * A 401 IS A SIGN-IN, NOT AN ERROR MESSAGE. The service answers an
 * unauthenticated caller with 401 precisely so this layer can turn it into the
 * existing C7 join flow rather than rendering "Sign in to continue." as a
 * failure. `unauthenticated` is therefore its own result rather than a string in
 * `error`, so a caller cannot forget to distinguish them.
 *
 * NOTHING HERE INVENTS COPY. Every refusal message, every lock explanation and
 * every status word comes from the server, because the server is where the rule
 * that produced it lives. A frontend that writes its own "review is locked"
 * sentence is a frontend that will eventually say it when review is open.
 */

export type ApiResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly unauthenticated: true }
  | { readonly ok: false; readonly unauthenticated?: false; readonly error: string; readonly reason?: string; readonly detail?: string };

/* --------------------------------------------------------------- wire types */

export interface ProgrammeLanguage {
  readonly language: string;
  readonly englishName: string;
  readonly nativeName: string;
  readonly requiresSourceElicitation: boolean;
}

export interface ReviewCriterion {
  readonly key: string;
  readonly question: string;
  readonly kind: 'yes-no' | 'score';
  readonly adverse?: 'yes' | 'no';
}

export interface Programme {
  readonly contactEmail: string;
  readonly languages: readonly ProgrammeLanguage[];
  readonly reviewCriteria: readonly ReviewCriterion[];
}

export interface TrackWire {
  readonly language: string;
  readonly englishName: string;
  readonly nativeName: string;
  readonly state: string;
  readonly appliedAtMs: number;
  readonly decidedAtMs: number | null;
  readonly attempt: number;
  readonly requiresSourceElicitation: boolean;
  readonly elicitation: {
    readonly answered: number;
    readonly total: number;
    readonly complete: boolean;
    readonly frozen: boolean;
    readonly sha256: string | null;
  };
  readonly review: {
    readonly unlocked: boolean;
    readonly lock: string | null;
    readonly message: string | null;
  };
}

export interface AssignmentWire {
  readonly assignmentId: string;
  readonly language: string;
  readonly englishName: string;
  readonly nativeName: string;
  readonly kind: string;
  readonly state: string;
  readonly createdAtMs: number;
  readonly dueAtMs: number | null;
  readonly unlocked?: boolean;
  readonly lockMessage?: string | null;
}

export interface CapabilityWire {
  readonly language: string;
  readonly capability: string;
  readonly grantedAtMs: number;
}

export interface Me {
  readonly accountId: string;
  readonly applied: boolean;
  readonly applicationState: string | null;
  readonly appliedAtMs: number | null;
  readonly country: string | null;
  readonly timeZone: string | null;
  readonly tracks: readonly TrackWire[];
  readonly assignments: readonly AssignmentWire[];
  readonly capabilities: readonly CapabilityWire[];
  /** Stated by the server so the portal can show it rather than assume it. */
  readonly voice: { readonly state: string; readonly voiceRightsGranted: boolean };
}

export interface ConsentOfferWire {
  readonly consentVersion: string;
  readonly scope: string;
  readonly text: string;
  readonly retainedRights: string;
  readonly grantedUses: readonly string[];
  readonly withheldUses: readonly string[];
  readonly affirmation: string;
}

export interface ConsentState {
  readonly language: string;
  readonly offer: ConsentOfferWire;
  readonly accepted: boolean;
  readonly acceptedAtMs: number | null;
  readonly acceptedVersion: string | null;
}

export interface PromptWire {
  readonly item: number;
  readonly category: string;
  readonly purpose: string;
  readonly optional: boolean;
}

export interface EntryWire {
  readonly item: number;
  readonly nativeMessage: string;
  readonly englishSemanticReference: string;
}

export interface FrozenWire {
  readonly revision: number;
  readonly sourceCount: number;
  readonly sha256: string;
  readonly frozenAtMs: number;
}

export interface GroupWire {
  readonly name: string;
  readonly items: readonly number[];
}

export interface ElicitationState {
  readonly language: string;
  readonly englishName: string;
  readonly nativeName: string;
  readonly prompts: readonly PromptWire[];
  /** Five groups of three, for the progress card. Presentational only. */
  readonly groups: readonly GroupWire[];
  readonly entries: readonly EntryWire[];
  readonly consentAccepted: boolean;
  readonly frozen: FrozenWire | null;
  readonly englishIsSemanticReference: boolean;
}

/** What a reviewer receives. There is no provider or model field, by design. */
export interface BlindCandidateWire {
  readonly candidateId: string;
  readonly ordinal: number;
  readonly direction: string;
  readonly category: string;
  readonly sourceText: string;
  readonly candidateText: string;
}

export interface ReviewPacket {
  readonly assignmentId: string;
  readonly language: string;
  readonly englishName: string;
  readonly nativeName: string;
  readonly state: string;
  readonly criteria: readonly ReviewCriterion[];
  readonly candidates: readonly BlindCandidateWire[];
  readonly judgedCandidateIds: readonly string[];
}

export interface SubmissionWire {
  readonly kind: string;
  readonly language: string;
  readonly englishName: string;
  readonly nativeName: string;
  readonly revision?: number;
  readonly sourceCount?: number;
  readonly sha256?: string;
  readonly frozenAtMs?: number;
  readonly consentVersion?: string;
  readonly items?: readonly (EntryWire & { readonly purpose: string })[];
  readonly assignmentId?: string;
  readonly judged?: number;
  readonly submittedAtMs?: number;
}

/* ------------------------------------------------------------------ request */

async function request<T>(
  accountUrl: string,
  token: string | null,
  path: string,
  init?: RequestInit,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${accountUrl}${path}`, {
      ...init,
      headers: {
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    /*
     * A flaky connection is not a sign-out. This is deliberately NOT reported
     * as `unauthenticated`, which would bounce somebody to the join form
     * because their train went into a tunnel.
     */
    return { ok: false, error: 'Could not reach C7. Check your connection and try again.' };
  }

  if (response.status === 401) return { ok: false, unauthenticated: true };

  let body: unknown = null;
  let unreadable = false;
  try {
    const raw = await response.text();
    body = raw.length === 0 ? null : JSON.parse(raw);
  } catch {
    body = null;
    unreadable = true;
  }

  /*
   * A 200 THAT IS NOT JSON IS A FAILURE, not an empty success.
   *
   * This read `body ?? {}` and reported ok. The shape that produces is an empty
   * object typed as `Me`, so `me.assignments` is undefined and the first
   * `.filter` on it throws — a blank page and a console error, from a server
   * that answered perfectly happily.
   *
   * It is not hypothetical: a deployment whose reverse proxy does not route the
   * account prefix answers every API call with the SPA shell, status 200,
   * `text/html`. That is exactly what a misconfigured edge looks like, and the
   * whole point of this layer is to turn it into a sentence rather than a white
   * screen. Caught in the visual audit, where the built bundle asks for `/auth`
   * and the local preview answered with index.html.
   */
  if (response.ok && unreadable) {
    return {
      ok: false,
      error: 'C7 answered with something this page could not read. Try again shortly.',
    };
  }

  if (!response.ok) {
    const detail = (body ?? {}) as Record<string, unknown>;
    return {
      ok: false,
      /* The server's words. See the module note. */
      error: typeof detail['error'] === 'string' ? detail['error'] : 'Something went wrong.',
      ...(typeof detail['reason'] === 'string' ? { reason: detail['reason'] } : {}),
      ...(typeof detail['detail'] === 'string' ? { detail: detail['detail'] } : {}),
    };
  }
  return { ok: true, value: (body ?? {}) as T };
}

export interface SpecialistApi {
  programme(): Promise<ApiResult<Programme>>;
  me(): Promise<ApiResult<Me>>;
  apply(input: {
    motivation: string;
    country?: string;
    timeZone?: string;
  }): Promise<ApiResult<{ applied: boolean }>>;
  languages(): Promise<ApiResult<{ tracks: readonly TrackWire[] }>>;
  applyForLanguage(language: string): Promise<ApiResult<{ track: TrackWire }>>;
  consent(language: string): Promise<ApiResult<ConsentState>>;
  acceptConsent(
    language: string,
    input: { accepted: boolean; typed: string; consentVersion: string },
  ): Promise<ApiResult<{ consentId: string }>>;
  elicitation(language: string): Promise<ApiResult<ElicitationState>>;
  saveElicitation(
    language: string,
    entries: readonly EntryWire[],
  ): Promise<ApiResult<{ answered: number; complete: boolean }>>;
  freezeElicitation(language: string): Promise<ApiResult<FrozenWire>>;
  assignments(): Promise<ApiResult<{ assignments: readonly AssignmentWire[] }>>;
  packet(assignmentId: string): Promise<ApiResult<ReviewPacket>>;
  recordVerdict(
    assignmentId: string,
    verdict: Record<string, unknown>,
  ): Promise<ApiResult<{ judged: number; total: number }>>;
  submissions(): Promise<ApiResult<{ submissions: readonly SubmissionWire[] }>>;
}

/**
 * Bind the API to one deployment and one session.
 *
 * `token` may be null for the public programme description, which is the one
 * call the recruitment page makes before anybody has signed in.
 */
export function createSpecialistApi(accountUrl: string, token: string | null): SpecialistApi {
  const base = accountUrl.replace(/\/$/u, '');
  const json = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
  return {
    programme: () => request<Programme>(base, null, '/specialists/programme'),
    me: () => request<Me>(base, token, '/specialists/me'),
    apply: (input) =>
      request<{ applied: boolean }>(base, token, '/specialists/me', json(input)),
    languages: () => request(base, token, '/specialists/languages'),
    applyForLanguage: (language) =>
      request(base, token, `/specialists/languages/${encodeURIComponent(language)}/apply`, json({})),
    consent: (language) =>
      request<ConsentState>(base, token, `/specialists/consent/${encodeURIComponent(language)}`),
    acceptConsent: (language, input) =>
      request(base, token, `/specialists/consent/${encodeURIComponent(language)}`, json(input)),
    elicitation: (language) =>
      request<ElicitationState>(
        base,
        token,
        `/specialists/elicitation/${encodeURIComponent(language)}`,
      ),
    saveElicitation: (language, entries) =>
      request(base, token, `/specialists/elicitation/${encodeURIComponent(language)}`, {
        method: 'PUT',
        body: JSON.stringify({ entries }),
      }),
    freezeElicitation: (language) =>
      request<FrozenWire>(
        base,
        token,
        `/specialists/elicitation/${encodeURIComponent(language)}/freeze`,
        json({}),
      ),
    assignments: () => request(base, token, '/specialists/assignments'),
    packet: (assignmentId) =>
      request<ReviewPacket>(
        base,
        token,
        `/specialists/assignments/${encodeURIComponent(assignmentId)}`,
      ),
    recordVerdict: (assignmentId, verdict) =>
      request(
        base,
        token,
        `/specialists/assignments/${encodeURIComponent(assignmentId)}/verdicts`,
        json(verdict),
      ),
    submissions: () => request(base, token, '/specialists/submissions'),
  };
}

/* ------------------------------------------------------------------- words */

/**
 * How a qualification state is printed.
 *
 * The STATES come from the server; only their casing is decided here, and the
 * mapping is total so an unrecognised state prints as itself rather than as an
 * empty chip. A dashboard that silently shows nothing for a state it does not
 * know is worse than one that shows the raw word: the raw word is a bug report.
 */
export const STATE_WORDS: Readonly<Record<string, string>> = {
  APPLIED: 'Applied',
  ASSESSMENT_PENDING: 'Assessment pending',
  ASSESSMENT_IN_PROGRESS: 'Assessment in progress',
  SUBMITTED: 'Submitted',
  UNDER_REVIEW: 'Under review',
  QUALIFIED: 'Qualified',
  NOT_QUALIFIED: 'Not qualified',
  REASSESSMENT_ALLOWED: 'Reassessment allowed',
  SUSPENDED: 'Suspended',
  NOT_ASSESSED: 'Not assessed',
  /*
   * The voice states, which share this table because they share the chip.
   * Without them `NOT_INVITED` printed as a raw enum on the dashboard -- the
   * fallback below doing exactly its job, on a state that was simply never
   * named. Caught by looking at the rendered page.
   */
  NOT_INVITED: 'Not invited',
  INVITED: 'Invited',
  AUDITION_PENDING: 'Audition pending',
  VOICE_APPROVED: 'Voice approved',
  VOICE_AGREEMENT_REQUIRED: 'Voice agreement required',
  ACTIVE: 'Active',
  WITHDRAWN: 'Withdrawn',
};

export function stateWord(state: string): string {
  return STATE_WORDS[state] ?? state;
}

/**
 * The chip tone for a state.
 *
 * `positive`, `caution`, `negative`, `neutral` -- four tones, mapped to the
 * design system's status colours in CSS. Colour is never the only signal: the
 * chip always carries the word too (design system §5.1.13).
 */
export function stateTone(state: string): 'positive' | 'caution' | 'negative' | 'neutral' {
  switch (state) {
    case 'QUALIFIED':
      return 'positive';
    case 'ASSESSMENT_PENDING':
    case 'ASSESSMENT_IN_PROGRESS':
    case 'SUBMITTED':
    case 'UNDER_REVIEW':
    case 'REASSESSMENT_ALLOWED':
      return 'caution';
    case 'NOT_QUALIFIED':
    case 'SUSPENDED':
      return 'negative';
    default:
      return 'neutral';
  }
}

/** A date as a person reads it. Absent dates print as an em dash, not "null". */
export function dayWord(atMs: number | null | undefined): string {
  if (atMs === null || atMs === undefined) return '—';
  return new Date(atMs).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
