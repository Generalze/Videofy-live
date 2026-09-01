/** @author masterzee001 */
/**
 * The operator half of the Language Specialist API.
 *
 * A 404 IS THE REFUSAL, AND THIS LAYER MUST NOT DRESS IT UP. The service
 * answers an unauthorised caller with 404 rather than 403 so that finding the
 * URL teaches nothing -- the same rule the tariff and organization admin routes
 * follow. If this client turned that into "you do not have permission", it
 * would hand back exactly the fact the status code was chosen to withhold, to
 * anybody who opened the page. So a 404 on the list is reported as
 * `forbidden`, and the console shows the same screen it would show if the
 * feature did not exist here.
 *
 * The engine identity IS present in the operator's evidence payload, and that
 * asymmetry is the design rather than an oversight: the identity was withheld
 * at the moment judgement was formed, and reading it afterwards is how the
 * result gets interpreted.
 */

export type AdminResult<T> =
  | { readonly ok: true; readonly value: T }
  /** 404 from any admin path: not an operator, or not verified, or no such row. */
  | { readonly ok: false; readonly forbidden: true }
  | { readonly ok: false; readonly forbidden?: false; readonly error: string };

export interface ApplicantLanguage {
  readonly language: string;
  readonly englishName: string;
  readonly state: string;
  readonly attempt: number;
  readonly appliedAtMs: number;
  readonly decidedAtMs: number | null;
}

export interface ApplicantRow {
  readonly accountId: string;
  readonly applicationState: string;
  readonly appliedAtMs: number;
  readonly updatedAtMs: number;
  readonly country: string | null;
  readonly timeZone: string | null;
  readonly languages: readonly ApplicantLanguage[];
}

export interface ApplicantList {
  readonly applicants: readonly ApplicantRow[];
  readonly states: readonly string[];
  readonly capabilities: readonly string[];
}

export interface DecisionRow {
  readonly decisionId: string;
  readonly fromState: string | null;
  readonly toState: string;
  readonly decidedBy: string;
  readonly reason: string;
  readonly atMs: number;
}

export interface ApplicantTrack {
  readonly language: string;
  readonly englishName: string;
  readonly state: string;
  readonly attempt: number;
  readonly appliedAtMs: number;
  readonly decidedAtMs: number | null;
  readonly elicitation: {
    readonly answered: number;
    readonly total: number;
    readonly complete: boolean;
    readonly frozen: boolean;
    readonly sha256: string | null;
  };
  readonly reviewUnlocked: boolean;
  readonly decisions: readonly DecisionRow[];
}

export interface ApplicantDetail {
  readonly accountId: string;
  readonly applicationState: string;
  readonly appliedAtMs: number;
  readonly country: string | null;
  readonly timeZone: string | null;
  readonly motivation: string;
  readonly languages: readonly ApplicantTrack[];
  readonly capabilities: readonly {
    readonly language: string;
    readonly capability: string;
    readonly grantedBy: string;
    readonly grantedAtMs: number;
  }[];
  readonly assignments: readonly {
    readonly assignmentId: string;
    readonly language: string;
    readonly kind: string;
    readonly state: string;
    readonly createdAtMs: number;
  }[];
  readonly voice: { readonly state: string; readonly voiceRightsGranted: boolean };
}

export interface CorpusItem {
  readonly item: number;
  readonly category: string;
  readonly purpose: string;
  readonly nativeMessage: string;
  readonly englishSemanticReference: string;
}

export interface Evidence {
  readonly accountId: string;
  readonly language: string;
  readonly state: string;
  readonly corpora: readonly {
    readonly revision: number;
    readonly sourceCount: number;
    readonly sha256: string;
    readonly frozenAtMs: number;
    readonly consentId: string;
    readonly consentVersion: string;
    readonly items: readonly CorpusItem[];
    readonly englishIsSemanticReference: boolean;
  }[];
  readonly reviews: readonly {
    readonly assignmentId: string;
    readonly state: string;
    readonly candidates: readonly {
      readonly candidateId: string;
      readonly ordinal: number;
      readonly direction: string;
      readonly category: string;
      readonly sourceText: string;
      readonly candidateText: string;
      readonly provider: string;
      readonly model: string;
    }[];
    readonly verdicts: readonly Record<string, unknown>[];
  }[];
}

async function request<T>(
  accountUrl: string,
  token: string | null,
  path: string,
  init?: RequestInit,
): Promise<AdminResult<T>> {
  let response: Response;
  try {
    response = await fetch(`${accountUrl}${path}`, {
      ...init,
      headers: {
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
    });
  } catch {
    return { ok: false, error: 'Could not reach the account service.' };
  }

  /*
   * 401 is folded into `forbidden` alongside 404. From this console's point of
   * view "you are not signed in" and "you are not an operator" lead to the same
   * screen, and distinguishing them here would put the console in the business
   * of explaining an authorization decision it did not make.
   */
  if (response.status === 404 || response.status === 401) return { ok: false, forbidden: true };

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
   * A 200 THAT IS NOT JSON IS A FAILURE, not an empty success. A deployment
   * whose reverse proxy does not route the account prefix answers every API
   * call with the SPA shell — status 200, `text/html` — and reading that as an
   * empty payload puts an object with no fields into a component that then
   * throws on the first property it reads. The console gets a blank page; the
   * operator gets nothing to act on.
   */
  if (response.ok && unreadable) {
    return {
      ok: false,
      error: 'The account service answered with something this console could not read.',
    };
  }

  if (!response.ok) {
    const detail = (body ?? {}) as Record<string, unknown>;
    return {
      ok: false,
      error: typeof detail['error'] === 'string' ? detail['error'] : 'Something went wrong.',
    };
  }
  return { ok: true, value: (body ?? {}) as T };
}

export interface SpecialistAdminApi {
  applicants(): Promise<AdminResult<ApplicantList>>;
  applicant(accountId: string): Promise<AdminResult<ApplicantDetail>>;
  evidence(accountId: string, language: string): Promise<AdminResult<Evidence>>;
  decide(
    accountId: string,
    language: string,
    input: { state: string; reason: string },
  ): Promise<AdminResult<{ state: string }>>;
  grant(
    accountId: string,
    language: string,
    capability: string,
  ): Promise<AdminResult<{ granted: string }>>;
  /**
   * Issue a blind review packet.
   *
   * `candidates` is passed through as the operator pasted it. Validating the
   * shape here as well as on the server would be a second copy of the contract,
   * and the server is the one that has to be right.
   */
  issueAssignment(
    accountId: string,
    language: string,
    candidates: unknown,
  ): Promise<AdminResult<{ assignmentId: string; candidates: number }>>;
}

export function createSpecialistAdminApi(
  accountUrl: string,
  token: string | null,
): SpecialistAdminApi {
  const base = accountUrl.replace(/\/$/u, '');
  const root = '/admin/language-specialists';
  const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
  const id = encodeURIComponent;
  return {
    applicants: () => request<ApplicantList>(base, token, root),
    applicant: (accountId) => request<ApplicantDetail>(base, token, `${root}/${id(accountId)}`),
    evidence: (accountId, language) =>
      request<Evidence>(base, token, `${root}/${id(accountId)}/${id(language)}/evidence`),
    decide: (accountId, language, input) =>
      request(base, token, `${root}/${id(accountId)}/${id(language)}/decision`, post(input)),
    grant: (accountId, language, capability) =>
      request(base, token, `${root}/${id(accountId)}/${id(language)}/capabilities`, post({ capability })),
    issueAssignment: (accountId, language, candidates) =>
      request(base, token, `${root}/${id(accountId)}/${id(language)}/assignments`, post({ candidates })),
  };
}

/** Human words for a state. The states themselves come from the server. */
export function stateWord(state: string): string {
  return state.charAt(0) + state.slice(1).toLowerCase().replace(/_/gu, ' ');
}

export function stateTone(state: string): 'ok' | 'warn' | 'danger' | 'muted' {
  switch (state) {
    case 'QUALIFIED':
      return 'ok';
    case 'NOT_QUALIFIED':
    case 'SUSPENDED':
      return 'danger';
    case 'APPLIED':
      return 'muted';
    default:
      return 'warn';
  }
}

export function dayWord(atMs: number | null | undefined): string {
  if (atMs === null || atMs === undefined) return '—';
  return new Date(atMs).toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}
