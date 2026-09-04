/** @author masterzee001 */
/**
 * Reads a programme's vocabulary from the authority that owns it.
 *
 * One call, when a recognition session opens, and the answer is then pinned
 * for that session's whole life. Not because refreshing would be hard, but
 * because a recogniser cannot be handed new terms once it has connected: it
 * took them at the handshake. Pretending otherwise would show an operator a
 * version number that nothing was using.
 *
 * A FAILED READ IS NOT AN EMPTY VOCABULARY. The two are indistinguishable in
 * the terms they produce and completely different in what they mean, so they
 * are different results here. A programme whose vocabulary could not be
 * fetched must never be described as running with vocabulary active -- that is
 * the reassuring lie this module exists to prevent.
 *
 * NOTHING HERE LOGS A TERM. Vocabulary is the broadcaster's own material and
 * can be commercially sensitive. Diagnostics carry the programme, the
 * revision, the count and the fingerprint, which is enough to answer "which
 * vocabulary was this session running" without reproducing it.
 */

export interface VocabularySnapshotIdentity {
  readonly programmeId: string;
  readonly revision: number;
  readonly termCount: number;
  readonly fingerprint: string;
}

export type VocabularySnapshotResult =
  | { readonly kind: 'ready'; readonly keyterms: readonly string[]; readonly identity: VocabularySnapshotIdentity }
  /** The authority answered, and this programme has no terms. */
  | { readonly kind: 'empty'; readonly identity: VocabularySnapshotIdentity }
  /** The authority could not be reached, or refused. NOT the same as empty. */
  | { readonly kind: 'unavailable'; readonly reason: string };

export interface VocabularySnapshotClient {
  fetch(input: {
    readonly programmeId: string;
    readonly sourceLanguage: string;
    readonly targetLanguage: string;
  }): Promise<VocabularySnapshotResult>;
}

export interface VocabularySnapshotClientOptions {
  /** The account service's base URL. Absent means the seam is not configured. */
  readonly accountUrl: string | null;
  readonly internalToken: string | null;
  /** Does the configured recogniser accept keyterms at all? */
  readonly sttKeyterms: boolean;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (message: string, detail: Record<string, unknown>) => void;
}

const DEFAULT_TIMEOUT_MS = 4000;

function identityOf(body: Record<string, unknown>, programmeId: string): VocabularySnapshotIdentity {
  return {
    programmeId,
    revision: typeof body['revision'] === 'number' ? body['revision'] : -1,
    termCount: typeof body['termCount'] === 'number' ? body['termCount'] : 0,
    fingerprint: typeof body['fingerprint'] === 'string' ? body['fingerprint'] : 'unknown',
  };
}

/**
 * A client that always answers `unavailable`.
 *
 * What a deployment gets when the seam is not configured, so the absence is a
 * stated result rather than a silently empty list.
 */
export function vocabularyUnavailable(reason: string): VocabularySnapshotClient {
  return {
    async fetch() {
      return { kind: 'unavailable', reason };
    },
  };
}

export function createVocabularySnapshotClient(
  options: VocabularySnapshotClientOptions,
): VocabularySnapshotClient {
  const { accountUrl, internalToken } = options;
  if (accountUrl === null || accountUrl.trim() === '' || internalToken === null || internalToken === '') {
    return vocabularyUnavailable('no internal vocabulary seam configured');
  }
  const base = accountUrl.replace(/\/+$/u, '');
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async fetch(input) {
      const query = new URLSearchParams({
        sourceLanguage: input.sourceLanguage,
        targetLanguage: input.targetLanguage,
        sttKeyterms: options.sttKeyterms ? '1' : '0',
      });
      const url = `${base}/internal/programmes/${encodeURIComponent(input.programmeId)}/vocabulary/snapshot?${query.toString()}`;

      // A recogniser is waiting to open. A vocabulary read may not hold a
      // programme's first words hostage, so it is bounded and then given up on.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      try {
        const response = await fetchImpl(url, {
          headers: { 'X-Videofy-Internal-Token': internalToken },
          signal: controller.signal,
        });
        if (!response.ok) {
          return { kind: 'unavailable', reason: `authority answered ${response.status}` };
        }
        const body = (await response.json()) as Record<string, unknown>;
        const raw = body['sttKeyterms'];
        if (!Array.isArray(raw)) {
          return { kind: 'unavailable', reason: 'authority answered without a keyterm list' };
        }
        const keyterms = raw.filter((term): term is string => typeof term === 'string');
        const identity = identityOf(body, input.programmeId);
        options.log?.('programme vocabulary snapshot taken', { ...identity });
        return keyterms.length === 0
          ? { kind: 'empty', identity }
          : { kind: 'ready', keyterms, identity };
      } catch (error) {
        const reason =
          error instanceof Error && error.name === 'AbortError'
            ? 'the authority did not answer in time'
            : error instanceof Error
              ? error.message
              : 'unknown';
        options.log?.('programme vocabulary snapshot unavailable', {
          programmeId: input.programmeId,
          reason,
        });
        return { kind: 'unavailable', reason };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
