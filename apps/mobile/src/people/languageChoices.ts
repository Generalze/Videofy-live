/** @author masterzee001 */
/**
 * The phone's language picker: the SAME catalogue and the SAME capability
 * words the operator console shows, from the same place.
 *
 * What this replaces. Profile offered three languages -- English, Spanish,
 * French -- written into the screen as a tuple, with a hint promising the rest
 * "with the programme wave". Meanwhile media-ingest was already publishing a
 * ninety-eight language catalogue with a capability state per language, and the
 * console was already showing it. The phone was not missing a feature; it was
 * missing a wire.
 *
 * TWO SOURCES, DELIBERATELY, and they degrade in that order:
 *
 *   the catalogue   @videofy-live/language-catalogue, bundled. Names, endonyms
 *                   and ordering are known offline, so the picker WORKS on a
 *                   phone that cannot reach media ingest.
 *   the capability  GET /languages/catalogue on media-ingest -- public, no
 *                   token, the same rows the console reads. It adds the state
 *                   words and nothing else.
 *
 * When the capability read fails, every row reports `unknown` rather than
 * `available`. A phone that cannot reach the service does not thereby know
 * that a language works, and saying so would be the exact failure this
 * codebase keeps meeting: a green-looking signal that measured nothing.
 *
 * THE NIGERIAN LANGUAGES CARRY A WARNING, not a hidden row. When Hausa, Igbo,
 * Yoruba or Nigerian Pidgin are being served by a general voice vendor instead
 * of the 9jaLingo specialist, the row says `degraded` in words. Hiding them
 * would be quieter and less honest: the audio plays either way, and only a
 * speaker of the language can hear that it is wrong.
 */
import { LANGUAGE_CATALOGUE, searchLanguages } from '@videofy-live/language-catalogue';

/** The four words the capability resolver uses, plus "we could not ask". */
export type LanguageCapabilityWord = 'qualified' | 'available' | 'limited' | 'unavailable' | 'unknown';

export interface LanguageChoice {
  readonly code: string;
  readonly label: string;
  readonly nativeName: string;
  /** The conservative word: the weakest stage of the chain. */
  readonly state: LanguageCapabilityWord;
  /** Speaking it INTO a call or programme: recognition and translation. */
  readonly sourceState: LanguageCapabilityWord;
  /** Hearing it: translation and a voice. */
  readonly targetState: LanguageCapabilityWord;
  /** Translatable with no voice on this chain. Offerable, and labelled. */
  readonly captionsOnly: boolean;
  /** A Nigerian language served by a general vendor, not the specialist. */
  readonly degraded: boolean;
  readonly reason?: string;
}

/** One row of media-ingest's GET /languages/catalogue, as much as is used here. */
export interface CapabilityRow {
  readonly language: string;
  readonly state?: string;
  readonly sourceState?: string;
  readonly targetState?: string;
  readonly captionsOnly?: boolean;
  readonly degraded?: boolean;
  readonly reason?: string;
}

const WORDS: readonly LanguageCapabilityWord[] = [
  'qualified',
  'available',
  'limited',
  'unavailable',
];

function word(value: string | undefined, fallback: LanguageCapabilityWord): LanguageCapabilityWord {
  return WORDS.includes(value as LanguageCapabilityWord) ? (value as LanguageCapabilityWord) : fallback;
}

/**
 * Every catalogue language, in catalogue order, with whatever the deployment
 * told us about each. `capabilities` undefined means the read has not happened
 * or did not work, and every row is honestly `unknown`.
 */
export function languageChoices(capabilities?: readonly CapabilityRow[]): LanguageChoice[] {
  const byCode = new Map((capabilities ?? []).map((row) => [row.language, row]));
  return LANGUAGE_CATALOGUE.map((language) => {
    const row = byCode.get(language.code);
    const state = word(row?.state, 'unknown');
    const choice: LanguageChoice = {
      code: language.code,
      label: language.englishName,
      nativeName: language.nativeName,
      state,
      sourceState: word(row?.sourceState, state),
      targetState: word(row?.targetState, state),
      captionsOnly: row?.captionsOnly === true,
      degraded: row?.degraded === true,
      ...(row?.reason === undefined ? {} : { reason: row.reason }),
    };
    return choice;
  });
}

/**
 * May this person say they SPEAK this language? Recognition and translation.
 *
 * `unknown` is permitted on purpose. A phone that could not reach media ingest
 * must not stop somebody recording their own language; refusing on an unread
 * signal would be a worse failure than allowing one that later reports limited.
 */
export function canSpeak(choice: LanguageChoice): boolean {
  return choice.sourceState !== 'unavailable';
}

/** May they ask to HEAR it? Translation and a voice -- or captions. */
export function canHear(choice: LanguageChoice): boolean {
  return choice.targetState !== 'unavailable' || choice.captionsOnly;
}

/**
 * Search by English name, endonym or code, folding case and diacritics --
 * the catalogue's own scorer, so the phone and the console rank `ma` the same
 * way. An empty query is the whole list, which is what a picker opens on.
 */
export function filterChoices(
  choices: readonly LanguageChoice[],
  query: string,
  limit = 40,
): LanguageChoice[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return choices.slice(0, limit);
  const byCode = new Map(choices.map((choice) => [choice.code, choice]));
  const found: LanguageChoice[] = [];
  for (const language of searchLanguages(trimmed, limit)) {
    const choice = byCode.get(language.code);
    if (choice !== undefined) found.push(choice);
  }
  return found;
}

/**
 * The chosen row first, then the rest. A picker that hides the current choice
 * behind a search box invites somebody to set a language they cannot see.
 */
export function withChosenFirst(
  choices: readonly LanguageChoice[],
  chosen: string | null | undefined,
): LanguageChoice[] {
  if (chosen === null || chosen === undefined) return [...choices];
  const index = choices.findIndex((choice) => choice.code === chosen);
  if (index <= 0) return [...choices];
  const picked = choices[index];
  if (picked === undefined) return [...choices];
  return [picked, ...choices.filter((choice) => choice.code !== chosen)];
}

/** The English name for a code, for a subtitle. Falls back to the code itself. */
export function languageName(code: string | null | undefined): string {
  if (code === null || code === undefined || code === '') return '—';
  return LANGUAGE_CATALOGUE.find((language) => language.code === code)?.englishName ?? code;
}

/** A short word for the chip beside a row, or null when there is nothing to say. */
export function capabilityNote(choice: LanguageChoice): string | null {
  if (choice.degraded) return 'degraded voice';
  if (choice.captionsOnly) return 'captions only';
  if (choice.targetState === 'limited') return 'beta';
  if (choice.targetState === 'unavailable') return 'no voice yet';
  return null;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Read the deployment's capability rows. Public route, no token: it is the
 * deployment's capability list and nothing an anonymous caller could act on.
 *
 * Returns null on ANY failure -- unreachable, non-200, or a body that is not
 * the shape this expects -- so the caller shows `unknown` instead of a
 * confident answer it did not receive.
 */
export async function fetchLanguageCapabilities(input: {
  readonly fetch: FetchLike;
  readonly ingestUrl: string;
}): Promise<CapabilityRow[] | null> {
  try {
    const response = await input.fetch(`${input.ingestUrl}/languages/catalogue`, { method: 'GET' });
    if (!response.ok) return null;
    const body = (await response.json()) as { catalogue?: unknown };
    if (!Array.isArray(body.catalogue)) return null;
    return body.catalogue.filter(
      (row): row is CapabilityRow =>
        typeof row === 'object' && row !== null && typeof (row as CapabilityRow).language === 'string',
    );
  } catch {
    return null;
  }
}
