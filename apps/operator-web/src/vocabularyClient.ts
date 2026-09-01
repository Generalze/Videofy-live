/** @author masterzee001 */
/**
 * The real vocabulary client. No cache, no local fallback.
 *
 * NOTHING HERE REMEMBERS ANYTHING. A browser-held copy of a programme's
 * vocabulary would be a second source of truth that survives a failed save, and
 * an operator would edit against it believing it was current. Every read is a
 * request; a failure is reported as a failure.
 *
 * THE CAPABILITY IS NOT COMPUTED HERE EITHER. It comes from media-ingest, which
 * builds the actual Deepgram request. A model-name check written in this file
 * would be a second answer to a question the service already answers, and the
 * day they disagree the console tells an operator a term is consumed while the
 * wire sends nothing.
 */

export interface VocabularyEntryDto {
  readonly id: string;
  readonly term: string;
  readonly canonicalRendering: string;
  readonly language: string;
  readonly pronunciationHint: string;
  readonly doNotTranslate: boolean;
  readonly sttKeyterm: boolean;
  readonly kind: string;
  readonly notes: string;
  readonly enabled: boolean;
}

export interface VocabularyCapabilities {
  readonly sttKeyterms: boolean;
  readonly sttRouteName: string;
  readonly pronunciationHints: boolean;
  readonly synthesisRouteName: string;
}

export interface VocabularySnapshotDto {
  readonly programmeId: string;
  readonly revision: number;
  readonly entries: readonly VocabularyEntryDto[];
}

export class VocabularyUnavailableError extends Error {
  constructor() {
    super('Vocabulary is unavailable on this deployment.');
    this.name = 'VocabularyUnavailableError';
  }
}

export interface RevisionConflict {
  readonly expectedRevision: number;
  readonly currentRevision: number;
}

export type SaveOutcome =
  | { readonly ok: true; readonly revision: number }
  | { readonly ok: false; readonly conflict: RevisionConflict };

function base(url: string): string {
  return url.replace(/\/$/u, '');
}

/**
 * A 404 here means the routes were not registered, which happens when the
 * service has no durable storage. That is a CAPABILITY answer, not an error to
 * show as a failed request -- the page says the feature is unavailable rather
 * than offering an editor that would lose what an operator typed.
 */
export async function fetchVocabulary(
  accountUrl: string,
  programmeId: string,
): Promise<VocabularySnapshotDto> {
  const response = await fetch(
    `${base(accountUrl)}/operator/programmes/${encodeURIComponent(programmeId)}/vocabulary`,
    { method: 'GET', credentials: 'include' },
  );
  if (response.status === 404) throw new VocabularyUnavailableError();
  if (!response.ok) throw new Error(`Vocabulary request failed (${response.status}).`);
  return (await response.json()) as VocabularySnapshotDto;
}

export async function fetchVocabularyCapabilities(
  ingestUrl: string,
): Promise<VocabularyCapabilities> {
  const response = await fetch(`${base(ingestUrl)}/vocabulary/capabilities`, { method: 'GET' });
  if (!response.ok) throw new Error(`Capability request failed (${response.status}).`);
  const body = (await response.json()) as Partial<VocabularyCapabilities>;
  return {
    // Defaults are the CAUTIOUS ones. A service that did not answer must not
    // cause the console to claim a term is consumed.
    sttKeyterms: body.sttKeyterms === true,
    sttRouteName: body.sttRouteName ?? 'unknown recognition route',
    pronunciationHints: body.pronunciationHints === true,
    synthesisRouteName: body.synthesisRouteName ?? 'unknown synthesis route',
  };
}

export async function saveVocabularyEntry(
  accountUrl: string,
  programmeId: string,
  entry: VocabularyEntryDto,
  expectedRevision: number,
): Promise<SaveOutcome> {
  const response = await fetch(
    `${base(accountUrl)}/operator/programmes/${encodeURIComponent(programmeId)}` +
      `/vocabulary/${encodeURIComponent(entry.id)}`,
    {
      method: 'PUT',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      // expectedRevision ALWAYS. The server refuses without it, and this client
      // must never be the reason a stale edit reaches the durable port.
      body: JSON.stringify({ ...entry, expectedRevision }),
    },
  );
  if (response.status === 409) {
    const body = (await response.json()) as RevisionConflict;
    // NO RETRY. The caller shows the conflict; the software cannot know which
    // of two operators is right.
    return {
      ok: false,
      conflict: {
        expectedRevision: body.expectedRevision,
        currentRevision: body.currentRevision,
      },
    };
  }
  if (!response.ok) throw new Error(`Save failed (${response.status}).`);
  const body = (await response.json()) as { revision: number };
  return { ok: true, revision: body.revision };
}

export async function deleteVocabularyEntry(
  accountUrl: string,
  programmeId: string,
  entryId: string,
  expectedRevision: number,
): Promise<SaveOutcome> {
  const response = await fetch(
    `${base(accountUrl)}/operator/programmes/${encodeURIComponent(programmeId)}` +
      `/vocabulary/${encodeURIComponent(entryId)}`,
    {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      // The identical precondition. A delete from a stale view discards
      // whatever was edited since.
      body: JSON.stringify({ expectedRevision }),
    },
  );
  if (response.status === 409) {
    const body = (await response.json()) as RevisionConflict;
    return {
      ok: false,
      conflict: {
        expectedRevision: body.expectedRevision,
        currentRevision: body.currentRevision,
      },
    };
  }
  if (!response.ok) throw new Error(`Delete failed (${response.status}).`);
  const body = (await response.json()) as { revision: number };
  return { ok: true, revision: body.revision };
}
