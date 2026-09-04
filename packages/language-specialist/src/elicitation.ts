/** @author masterzee001 */
/**
 * The fifteen prompts, and what the English column is for.
 *
 * TRANSCRIBED, NOT REDESIGNED. Every `purpose` string below is the wording
 * already sent to contributors in
 * `docs/certification/review-packets-v2/elicitation/elicitation-{yo,ha,ig}.csv`.
 * The categories were chosen against observed engine failures -- item 3 says
 * "this exact shape has already broken two engines" because it had -- and
 * rewording them to read more nicely would quietly change what is being
 * measured while every result still cited the same fifteen items.
 *
 * THE ENGLISH COLUMN IS A SEMANTIC REFERENCE. It says what the message MEANS.
 * It is not a model answer, not canonical wording, and candidate output must
 * never be scored by similarity to it: "I haven't received the money yet" and
 * "The payment hasn't reached me yet" are the same answer, and a lexical check
 * calls the second one wrong. This project's automatic checker has made
 * precisely that mistake four times. The field is named
 * `englishSemanticReference` rather than `english` so that nobody downstream
 * can read it as ground-truth wording without first typing the word "semantic".
 *
 * ITEM 15 MAY BE BLANK. Code-switching is natural for some contributors and not
 * others, and a form that forces it collects a sentence nobody would send.
 * `optional` sits on the prompt rather than in a special case in the validator.
 */

/**
 * The category a row measures. Stable identifiers, because results are grouped
 * by them and a renamed category orphans every past result.
 */
export const ELICITATION_CATEGORIES = [
  'money',
  'payment-received',
  'payment-not-received',
  'send-money-amount',
  'phone',
  'account-or-code',
  'meeting-date-time',
  'changed-plan',
  'running-late',
  'instruction',
  'negative-instruction',
  'bring-or-collect',
  'greeting',
  'ordinary-question',
  'code-switch',
] as const;

export type ElicitationCategory = (typeof ELICITATION_CATEGORIES)[number];

export interface ElicitationPrompt {
  /** 1..15, as printed on the form and cited in every result. */
  readonly item: number;
  readonly category: ElicitationCategory;
  /** The words the contributor reads. Transcribed from the CSV. */
  readonly purpose: string;
  /** True only for the code-switch row. See the module note. */
  readonly optional: boolean;
}

export const ELICITATION_PROMPTS: readonly ElicitationPrompt[] = [
  {
    item: 1,
    category: 'money',
    purpose: 'A price or an amount — what something costs, or what is owed',
    optional: false,
  },
  {
    item: 2,
    category: 'payment-received',
    purpose: 'Confirming you HAVE received a payment',
    optional: false,
  },
  {
    item: 3,
    category: 'payment-not-received',
    purpose:
      'Saying you have NOT received a payment. Use your normal way of saying ' +
      '‘not’ — this exact shape has already broken two engines',
    optional: false,
  },
  {
    item: 4,
    category: 'send-money-amount',
    purpose: 'Asking someone to send money, with the amount',
    optional: false,
  },
  {
    item: 5,
    category: 'phone',
    purpose: 'A message containing a phone number',
    optional: false,
  },
  {
    item: 6,
    category: 'account-or-code',
    purpose: 'A message containing an account number or a code (like an OTP)',
    optional: false,
  },
  {
    item: 7,
    category: 'meeting-date-time',
    purpose: 'Arranging a meeting — with a day and a time',
    optional: false,
  },
  {
    item: 8,
    category: 'changed-plan',
    purpose: 'Telling someone a plan has changed to a different day or time',
    optional: false,
  },
  {
    item: 9,
    category: 'running-late',
    purpose: 'Saying you are running late, with how long',
    optional: false,
  },
  {
    item: 10,
    category: 'instruction',
    purpose: 'Telling someone to do something',
    optional: false,
  },
  {
    item: 11,
    category: 'negative-instruction',
    purpose: 'Telling someone NOT to do something, or a warning',
    optional: false,
  },
  {
    item: 12,
    category: 'bring-or-collect',
    purpose: 'Asking someone to bring or collect something',
    optional: false,
  },
  {
    item: 13,
    category: 'greeting',
    purpose: 'A greeting — how you would really open a message',
    optional: false,
  },
  {
    item: 14,
    category: 'ordinary-question',
    purpose: 'A question to a friend or family member',
    optional: false,
  },
  {
    item: 15,
    category: 'code-switch',
    purpose:
      'A message that MIXES English with your language, if that is how you ' +
      'normally write. Leave blank if that is not natural for you',
    optional: true,
  },
];

export const ELICITATION_ITEM_COUNT = ELICITATION_PROMPTS.length;

/**
 * The fifteen prompts in five groups of three.
 *
 * PROGRESS IS UNREADABLE AS FIFTEEN ROWS. A contributor part-way through the
 * form needs to know how much is left, and a column of fifteen "to do" chips
 * answers that by making them count. Five counted groups is the same
 * information at a glance, and it is how the visual reference shows it.
 *
 * The grouping is presentational and says nothing about scoring: results are
 * grouped by CATEGORY, which is per-item and unchanged. Two items in one group
 * here are still two independent categories everywhere it matters.
 */
export interface ElicitationGroup {
  readonly name: string;
  readonly items: readonly number[];
}

export const ELICITATION_GROUPS: readonly ElicitationGroup[] = [
  { name: 'Money', items: [1, 2, 3] },
  { name: 'Numbers & codes', items: [4, 5, 6] },
  { name: 'Dates & times', items: [7, 8, 9] },
  { name: 'Instructions', items: [10, 11, 12] },
  { name: 'Everyday', items: [13, 14, 15] },
];

/** How the English column must be described anywhere it is shown or stored. */
export const ENGLISH_COLUMN_LABEL = 'what it means in English';
export const ENGLISH_IS_SEMANTIC_REFERENCE = true;

/** One row as the contributor fills it in. */
export interface ElicitationEntry {
  readonly item: number;
  /** What they wrote, in their language. Empty means "not answered". */
  readonly nativeMessage: string;
  /** What it MEANS in English. Never treated as canonical wording. */
  readonly englishSemanticReference: string;
}

/** A row as it is stored, carrying the prompt it answers. */
export interface ElicitationItem extends ElicitationEntry {
  readonly category: ElicitationCategory;
  readonly purpose: string;
}

export type ElicitationProblem =
  | { readonly kind: 'unknown-item'; readonly item: number }
  | { readonly kind: 'duplicate-item'; readonly item: number }
  | { readonly kind: 'missing-message'; readonly item: number }
  | { readonly kind: 'missing-english'; readonly item: number }
  | { readonly kind: 'too-long'; readonly item: number };

/**
 * A generous ceiling, not a style rule.
 *
 * The form asks for one or two sentences and most answers are under a hundred
 * characters. This is here so a paste of an entire document cannot become a
 * corpus row, not to argue with somebody whose greeting is long.
 */
export const MAX_ENTRY_LENGTH = 2000;

/**
 * Read untrusted rows into stored items, and say what is wrong with them.
 *
 * `complete` is separate from `problems` on purpose. A DRAFT is allowed to be
 * half-finished -- the form saves as you go, and refusing an incomplete draft
 * means a contributor loses twenty minutes to a closed tab -- but only a
 * COMPLETE draft may be frozen. So this returns the items it could read plus an
 * honest verdict, and the caller decides which of the two rules applies.
 * `problems` covers what is malformed; `complete` covers what is unfinished.
 */
export interface ElicitationReading {
  readonly items: readonly ElicitationItem[];
  readonly problems: readonly ElicitationProblem[];
  /** Every required prompt answered, in both columns. */
  readonly complete: boolean;
  /** Rows carrying a message, which is what `sourceCount` records at freeze. */
  readonly answered: number;
}

function promptFor(item: number): ElicitationPrompt | undefined {
  return ELICITATION_PROMPTS.find((prompt) => prompt.item === item);
}

export function readElicitation(input: unknown): ElicitationReading {
  const rows = Array.isArray(input) ? input : [];
  const problems: ElicitationProblem[] = [];
  const byItem = new Map<number, ElicitationItem>();

  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) continue;
    const row = raw as Record<string, unknown>;
    const item = typeof row['item'] === 'number' ? row['item'] : Number.NaN;
    const prompt = promptFor(item);
    if (prompt === undefined) {
      problems.push({ kind: 'unknown-item', item });
      continue;
    }
    if (byItem.has(item)) {
      problems.push({ kind: 'duplicate-item', item });
      continue;
    }
    const nativeMessage =
      typeof row['nativeMessage'] === 'string' ? row['nativeMessage'].trim() : '';
    const englishSemanticReference =
      typeof row['englishSemanticReference'] === 'string'
        ? row['englishSemanticReference'].trim()
        : '';
    if (
      nativeMessage.length > MAX_ENTRY_LENGTH ||
      englishSemanticReference.length > MAX_ENTRY_LENGTH
    ) {
      problems.push({ kind: 'too-long', item });
      continue;
    }
    byItem.set(item, {
      item,
      category: prompt.category,
      purpose: prompt.purpose,
      nativeMessage,
      englishSemanticReference,
    });
  }

  /*
   * Completeness is judged against the PROMPTS, not against what arrived. A
   * body that simply omits item 11 must not read as complete merely because
   * every row it did contain was fine.
   */
  let complete = true;
  for (const prompt of ELICITATION_PROMPTS) {
    const entry = byItem.get(prompt.item);
    const message = entry?.nativeMessage ?? '';
    if (message.length === 0) {
      if (!prompt.optional) {
        complete = false;
        problems.push({ kind: 'missing-message', item: prompt.item });
      }
      continue;
    }
    /*
     * An answered row needs its meaning. Without it the row cannot be reviewed
     * for semantic accuracy at all -- there is nothing to compare a candidate
     * translation against -- and the existing freeze script already warns that
     * such rows are excluded from scoring. Refusing at the form is better than
     * freezing a corpus with silent holes in it.
     */
    if ((entry?.englishSemanticReference ?? '').length === 0) {
      complete = false;
      problems.push({ kind: 'missing-english', item: prompt.item });
    }
  }

  const items = [...byItem.values()].sort((a, b) => a.item - b.item);
  return {
    items,
    problems,
    complete,
    answered: items.filter((entry) => entry.nativeMessage.length > 0).length,
  };
}
