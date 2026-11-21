/** @author masterzee001 */
/**
 * Turning a review packet on disk into a QA set definition.
 *
 * THE PACKETS IN docs/certification/review-packets ARE REAL MATERIAL that no
 * service has ever read. `review-fr.csv` is forty items from the deployed
 * OPUS-MT models in both directions; `review-yo.csv`, `-ha` and `-ig` are 136
 * items each, a blind head-to-head of two engines whose ANSWER-KEY-*.csv maps
 * item number to engine tag. Seeding sets from them is the honest choice over
 * inventing fixtures: the sentences were chosen for the categories where these
 * engines have actually failed.
 *
 * WHAT THE PACKET DOES NOT SAY, THE CALLER MUST. A packet names an engine by a
 * tag (`opus`, `m2m100`) and never by model id or version, because the model
 * id would identify the engine to a reviewer who saw the file. So the caller
 * supplies the tag -> (provider, model, modelVersion) mapping, per direction,
 * and this module refuses a row whose tag it cannot resolve rather than
 * guessing. A single-engine packet with no answer key takes one tag for every
 * row.
 *
 * NO MODEL IS INFERRED FROM THE ROUTE DOCUMENT. It would be convenient to read
 * `Helsinki-NLP/opus-mt-en-fr` off the seed for `en->fr`; it would also make
 * the QA set's identity depend on a file that promotion edits, and a set is
 * supposed to be evidence about a model whoever runs the packet named on
 * purpose.
 */
import type { QaSetDefinition, QaSetEngine, QaSetItem } from '@videofy-live/language-specialist';

/** The header columns a packet must carry, by name. Position is not trusted. */
const REQUIRED_COLUMNS = ['item', 'direction', 'category', 'source_text', 'translation_to_review'] as const;

/** RFC-4180-ish: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] as string;
    if (quoted) {
      if (char === '"') {
        if (body[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && body[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  /* A trailing blank line is not a row. */
  return rows.filter((entry) => entry.some((cell) => cell.trim().length > 0));
}

/** An engine tag, resolved per direction. `*` is any direction. */
export type EngineMapping = Readonly<Record<string, Readonly<Record<string, QaSetEngine>>>>;

export interface PacketImportInput {
  readonly language: string;
  readonly version: string;
  readonly sourceReference: string;
  readonly reviewCsv: string;
  /** Absent for a single-engine packet; then `singleEngineTag` is required. */
  readonly answerKeyCsv?: string;
  readonly singleEngineTag?: string;
  /** tag -> direction (or `*`) -> engine. */
  readonly engines: EngineMapping;
}

export type PacketImport =
  | { readonly ok: true; readonly definition: QaSetDefinition }
  | { readonly ok: false; readonly problems: readonly string[] };

function resolveEngine(engines: EngineMapping, tag: string, direction: string): QaSetEngine | null {
  const byDirection = engines[tag];
  if (byDirection === undefined) return null;
  return byDirection[direction] ?? byDirection['*'] ?? null;
}

/**
 * Read a packet, join it to its answer key, and produce a definition ready
 * for `readQaSetDefinition`. Every problem is reported, not the first.
 */
export function packetToQaSetDefinition(input: PacketImportInput): PacketImport {
  const problems: string[] = [];
  const rows = parseCsv(input.reviewCsv);
  const header = rows[0] ?? [];
  const column = new Map(header.map((name, index) => [name.trim(), index]));
  for (const name of REQUIRED_COLUMNS) {
    if (!column.has(name)) problems.push(`review packet has no "${name}" column`);
  }
  if (problems.length > 0) return { ok: false, problems };

  /* item -> engine tag, from the answer key or from the single tag. */
  const tags = new Map<number, string>();
  if (input.answerKeyCsv !== undefined) {
    const keyRows = parseCsv(input.answerKeyCsv);
    const keyHeader = keyRows[0] ?? [];
    const keyColumn = new Map(keyHeader.map((name, index) => [name.trim(), index]));
    const itemAt = keyColumn.get('item');
    const engineAt = keyColumn.get('engine');
    if (itemAt === undefined || engineAt === undefined) {
      return { ok: false, problems: ['answer key needs "item" and "engine" columns'] };
    }
    for (const keyRow of keyRows.slice(1)) {
      const item = Number(keyRow[itemAt]);
      const tag = (keyRow[engineAt] ?? '').trim();
      if (!Number.isInteger(item) || tag.length === 0) {
        problems.push(`answer key row "${keyRow.join(',')}" is not an item and an engine`);
        continue;
      }
      if (tags.has(item)) problems.push(`answer key names item ${item} twice`);
      tags.set(item, tag);
    }
  } else if (input.singleEngineTag === undefined) {
    return {
      ok: false,
      problems: ['a packet with no answer key needs singleEngineTag, naming the one engine every row came from'],
    };
  }

  const at = (row: string[], name: (typeof REQUIRED_COLUMNS)[number]): string =>
    (row[column.get(name) as number] ?? '').trim();

  const items: QaSetItem[] = [];
  const used = new Map<string, QaSetEngine>();
  for (const row of rows.slice(1)) {
    const ordinal = Number(at(row, 'item'));
    const direction = at(row, 'direction');
    if (!Number.isInteger(ordinal) || ordinal < 1) {
      problems.push(`row "${at(row, 'item')}" has no integer item number`);
      continue;
    }
    const tag = input.answerKeyCsv === undefined ? (input.singleEngineTag as string) : tags.get(ordinal);
    if (tag === undefined) {
      problems.push(`item ${ordinal} has no engine in the answer key`);
      continue;
    }
    const engine = resolveEngine(input.engines, tag, direction);
    if (engine === null) {
      problems.push(`item ${ordinal}: no engine mapping for tag "${tag}" on ${direction}`);
      continue;
    }
    used.set(`${engine.provider}::${engine.model}`, engine);
    items.push({
      ordinal,
      direction,
      category: at(row, 'category'),
      sourceText: at(row, 'source_text'),
      candidateText: at(row, 'translation_to_review'),
      provider: engine.provider,
      model: engine.model,
    });
  }
  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    definition: {
      language: input.language,
      version: input.version,
      /* Only the engines actually present; a declared-but-unused engine is noise. */
      engines: [...used.values()],
      items,
      sourceReference: input.sourceReference,
    },
  };
}
