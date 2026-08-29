/**
 * @owner masterzee001
 *
 * The language catalogue: what a language CODE means to a human.
 *
 * Why this exists as data and nothing else: every surface that shows a
 * language (the channel language picker, the listener's "translate to"
 * menu, the tariff's per-pair grade, the router's capability table) had
 * been growing its own little list of names, each drifting from the
 * others. One list, keyed by the same shape the gateway already validates
 * (`^[a-z]{2,3}(-[A-Z]{2})?$`), stops that drift. Vendor capability is
 * deliberately NOT here -- the language-router owns "who can do en->yo".
 *
 * Keys are BCP-47 BASE subtags only. Script and region are attributes,
 * never part of the key, so `zh` is one entry (Mandarin, Simplified by
 * default; Traditional is a rendering choice made downstream, not a
 * separate language). The regional-suffix form (`en-US`) is accepted by
 * `baseSubtag`, which is how callers reduce a wire tag to a catalogue key.
 *
 * Filipino: the catalogue uses `fil` (ISO 639-3, BCP-47 primary subtag).
 * Deepgram lists the language as `tl`; Azure Speech uses `fil-PH`. The
 * router maps `fil` to whatever each vendor wants; the user-facing key is
 * `fil`. `tl` is treated as a legacy alias by `lookupLanguage` so old rows
 * still resolve.
 *
 * Rank is by combined native + second-language reach (1 = English). It is
 * a coarse ordering for sorting pickers, not a statistic anyone should
 * quote.
 */

export type LanguageScript =
  | 'Latn'
  | 'Arab'
  | 'Cyrl'
  | 'Deva'
  | 'Hans'
  | 'Hant'
  | 'Beng'
  | 'Guru'
  | 'Gujr'
  | 'Taml'
  | 'Telu'
  | 'Knda'
  | 'Mlym'
  | 'Orya'
  | 'Sinh'
  | 'Jpan'
  | 'Kore'
  | 'Thai'
  | 'Grek'
  | 'Hebr'
  | 'Armn'
  | 'Geor'
  | 'Mymr'
  | 'Khmr'
  | 'Laoo'
  | 'Ethi';

export interface CatalogueLanguage {
  /** BCP-47 base subtag, lowercase, 2-3 letters. The catalogue key. */
  readonly code: string;
  readonly englishName: string;
  readonly nativeName: string;
  readonly script: LanguageScript;
  readonly rtl: boolean;
  /** ISO 3166-1 alpha-2, most significant first, at most four. */
  readonly regions: readonly string[];
  /** 1 = widest reach. Unique across the catalogue. */
  readonly rank: number;
  /** Free-text caveat a picker may surface (script choice, code aliases). */
  readonly note?: string;
}

/** The gateway's wire shape for a language tag; the catalogue key is the first group. */
export const LANGUAGE_TAG_PATTERN = /^[a-z]{2,3}(-[A-Z]{2})?$/;

const L = (
  code: string,
  englishName: string,
  nativeName: string,
  script: LanguageScript,
  regions: readonly string[],
  rank: number,
  extra: { rtl?: boolean; note?: string } = {},
): CatalogueLanguage => ({
  code,
  englishName,
  nativeName,
  script,
  rtl: extra.rtl ?? false,
  regions,
  rank,
  ...(extra.note === undefined ? {} : { note: extra.note }),
});

const RTL = { rtl: true } as const;

export const LANGUAGE_CATALOGUE: readonly CatalogueLanguage[] = Object.freeze([
  L('en', 'English', 'English', 'Latn', ['US', 'GB', 'IN', 'NG'], 1),
  L('zh', 'Chinese (Mandarin)', '中文', 'Hans', ['CN', 'TW', 'SG', 'MY'], 2, {
    note: 'One entry for Mandarin. Simplified (Hans) is the default rendering; Traditional (Hant) is a display choice made downstream, not a separate catalogue key.',
  }),
  L('hi', 'Hindi', 'हिन्दी', 'Deva', ['IN', 'FJ'], 3),
  L('es', 'Spanish', 'Español', 'Latn', ['MX', 'ES', 'CO', 'AR'], 4),
  L('fr', 'French', 'Français', 'Latn', ['FR', 'CD', 'CA', 'BE'], 5),
  L('ar', 'Arabic', 'العربية', 'Arab', ['EG', 'SA', 'DZ', 'MA'], 6, RTL),
  L('bn', 'Bengali', 'বাংলা', 'Beng', ['BD', 'IN'], 7),
  L('pt', 'Portuguese', 'Português', 'Latn', ['BR', 'PT', 'AO', 'MZ'], 8),
  L('ru', 'Russian', 'Русский', 'Cyrl', ['RU', 'BY', 'KZ', 'UA'], 9),
  L('ur', 'Urdu', 'اردو', 'Arab', ['PK', 'IN'], 10, RTL),
  L('id', 'Indonesian', 'Bahasa Indonesia', 'Latn', ['ID'], 11),
  L('de', 'German', 'Deutsch', 'Latn', ['DE', 'AT', 'CH'], 12),
  L('ja', 'Japanese', '日本語', 'Jpan', ['JP'], 13),
  L('sw', 'Swahili', 'Kiswahili', 'Latn', ['TZ', 'KE', 'UG', 'CD'], 14),
  L('mr', 'Marathi', 'मराठी', 'Deva', ['IN'], 15),
  L('te', 'Telugu', 'తెలుగు', 'Telu', ['IN'], 16),
  L('tr', 'Turkish', 'Türkçe', 'Latn', ['TR', 'CY'], 17),
  L('ta', 'Tamil', 'தமிழ்', 'Taml', ['IN', 'LK', 'SG', 'MY'], 18),
  L('vi', 'Vietnamese', 'Tiếng Việt', 'Latn', ['VN'], 19),
  L('ko', 'Korean', '한국어', 'Kore', ['KR', 'KP'], 20),
  L('fa', 'Persian', 'فارسی', 'Arab', ['IR', 'AF', 'TJ'], 21, RTL),
  L('it', 'Italian', 'Italiano', 'Latn', ['IT', 'CH'], 22),
  L('ha', 'Hausa', 'Harshen Hausa', 'Latn', ['NG', 'NE', 'GH'], 23),
  L('gu', 'Gujarati', 'ગુજરાતી', 'Gujr', ['IN'], 24),
  L('th', 'Thai', 'ไทย', 'Thai', ['TH'], 25),
  L('pa', 'Punjabi', 'ਪੰਜਾਬੀ', 'Guru', ['IN', 'PK'], 26, {
    note: 'Gurmukhi (India). The Pakistani Shahmukhi form is Arabic-script; a display choice, not a separate key.',
  }),
  L('kn', 'Kannada', 'ಕನ್ನಡ', 'Knda', ['IN'], 27),
  L('fil', 'Filipino', 'Filipino', 'Latn', ['PH'], 28, {
    note: 'Catalogue key is fil (BCP-47). Deepgram calls this tl; Azure Speech uses fil-PH. The router maps per vendor; tl resolves here as an alias.',
  }),
  L('pl', 'Polish', 'Polski', 'Latn', ['PL'], 29),
  L('yo', 'Yoruba', 'Èdè Yorùbá', 'Latn', ['NG', 'BJ'], 30),
  L('ml', 'Malayalam', 'മലയാളം', 'Mlym', ['IN'], 31),
  L('ms', 'Malay', 'Bahasa Melayu', 'Latn', ['MY', 'BN', 'SG'], 32),
  L('or', 'Odia', 'ଓଡ଼ିଆ', 'Orya', ['IN'], 33),
  L('my', 'Burmese', 'မြန်မာစာ', 'Mymr', ['MM'], 34),
  L('uk', 'Ukrainian', 'Українська', 'Cyrl', ['UA'], 35),
  L('ig', 'Igbo', 'Asụsụ Igbo', 'Latn', ['NG'], 36),
  L('am', 'Amharic', 'አማርኛ', 'Ethi', ['ET'], 37),
  L('uz', 'Uzbek', 'Oʻzbekcha', 'Latn', ['UZ', 'AF'], 38),
  L('nl', 'Dutch', 'Nederlands', 'Latn', ['NL', 'BE', 'SR'], 39),
  L('ro', 'Romanian', 'Română', 'Latn', ['RO', 'MD'], 40),
  L('ne', 'Nepali', 'नेपाली', 'Deva', ['NP', 'IN'], 41),
  L('sd', 'Sindhi', 'سنڌي', 'Arab', ['PK', 'IN'], 42, RTL),
  L('ps', 'Pashto', 'پښتو', 'Arab', ['AF', 'PK'], 43, RTL),
  L('om', 'Oromo', 'Afaan Oromoo', 'Latn', ['ET', 'KE'], 44),
  L('ku', 'Kurdish', 'Kurdî', 'Latn', ['TR', 'IQ', 'IR', 'SY'], 45, {
    note: 'Kurmanji (Latin). Sorani is Arabic-script; a display choice, not a separate key.',
  }),
  L('az', 'Azerbaijani', 'Azərbaycan dili', 'Latn', ['AZ', 'IR'], 46),
  L('el', 'Greek', 'Ελληνικά', 'Grek', ['GR', 'CY'], 47),
  L('hu', 'Hungarian', 'Magyar', 'Latn', ['HU', 'RO'], 48),
  L('cs', 'Czech', 'Čeština', 'Latn', ['CZ'], 49),
  L('sv', 'Swedish', 'Svenska', 'Latn', ['SE', 'FI'], 50),
  L('zu', 'Zulu', 'isiZulu', 'Latn', ['ZA'], 51),
  L('kk', 'Kazakh', 'Қазақ тілі', 'Cyrl', ['KZ'], 52),
  L('so', 'Somali', 'Af-Soomaali', 'Latn', ['SO', 'ET', 'KE', 'DJ'], 53),
  L('km', 'Khmer', 'ខ្មែរ', 'Khmr', ['KH'], 54),
  L('rw', 'Kinyarwanda', 'Ikinyarwanda', 'Latn', ['RW'], 55),
  L('mg', 'Malagasy', 'Malagasy', 'Latn', ['MG'], 56),
  L('he', 'Hebrew', 'עברית', 'Hebr', ['IL'], 57, RTL),
  L('si', 'Sinhala', 'සිංහල', 'Sinh', ['LK'], 58),
  L('bg', 'Bulgarian', 'Български', 'Cyrl', ['BG'], 59),
  L('sr', 'Serbian', 'Српски', 'Cyrl', ['RS', 'BA', 'ME'], 60, {
    note: 'Cyrillic default; Latin is co-official and a display choice, not a separate key.',
  }),
  L('xh', 'Xhosa', 'isiXhosa', 'Latn', ['ZA'], 61),
  L('af', 'Afrikaans', 'Afrikaans', 'Latn', ['ZA', 'NA'], 62),
  L('ti', 'Tigrinya', 'ትግርኛ', 'Ethi', ['ER', 'ET'], 63),
  L('wo', 'Wolof', 'Wolof', 'Latn', ['SN', 'GM'], 64),
  L('ff', 'Fula', 'Fulfulde', 'Latn', ['NG', 'SN', 'GN', 'ML'], 65),
  L('ln', 'Lingala', 'Lingála', 'Latn', ['CD', 'CG'], 66),
  L('sn', 'Shona', 'chiShona', 'Latn', ['ZW'], 67),
  L('tg', 'Tajik', 'Тоҷикӣ', 'Cyrl', ['TJ'], 68),
  L('ky', 'Kyrgyz', 'Кыргызча', 'Cyrl', ['KG'], 69),
  L('da', 'Danish', 'Dansk', 'Latn', ['DK'], 70),
  L('fi', 'Finnish', 'Suomi', 'Latn', ['FI'], 71),
  L('sk', 'Slovak', 'Slovenčina', 'Latn', ['SK'], 72),
  L('no', 'Norwegian', 'Norsk', 'Latn', ['NO'], 73),
  L('hr', 'Croatian', 'Hrvatski', 'Latn', ['HR', 'BA'], 74),
  L('ca', 'Catalan', 'Català', 'Latn', ['ES', 'AD'], 75),
  L('nso', 'Northern Sotho', 'Sesotho sa Leboa', 'Latn', ['ZA'], 76),
  L('st', 'Southern Sotho', 'Sesotho', 'Latn', ['LS', 'ZA'], 77),
  L('tn', 'Tswana', 'Setswana', 'Latn', ['BW', 'ZA'], 78),
  L('hy', 'Armenian', 'Հայերեն', 'Armn', ['AM'], 79),
  L('ka', 'Georgian', 'ქართული', 'Geor', ['GE'], 80),
  L('mn', 'Mongolian', 'Монгол', 'Cyrl', ['MN'], 81),
  L('lo', 'Lao', 'ລາວ', 'Laoo', ['LA'], 82),
  L('ht', 'Haitian Creole', 'Kreyòl ayisyen', 'Latn', ['HT'], 83),
  L('sq', 'Albanian', 'Shqip', 'Latn', ['AL', 'XK', 'MK'], 84),
  L('bs', 'Bosnian', 'Bosanski', 'Latn', ['BA'], 85),
  L('lt', 'Lithuanian', 'Lietuvių', 'Latn', ['LT'], 86),
  L('ts', 'Tsonga', 'Xitsonga', 'Latn', ['ZA', 'MZ'], 87),
  L('sl', 'Slovenian', 'Slovenščina', 'Latn', ['SI'], 88),
  L('mk', 'Macedonian', 'Македонски', 'Cyrl', ['MK'], 89),
  L('lv', 'Latvian', 'Latviešu', 'Latn', ['LV'], 90),
  L('gl', 'Galician', 'Galego', 'Latn', ['ES'], 91),
  L('et', 'Estonian', 'Eesti', 'Latn', ['EE'], 92),
  L('eu', 'Basque', 'Euskara', 'Latn', ['ES', 'FR'], 93),
  L('ve', 'Venda', 'Tshivenḓa', 'Latn', ['ZA'], 94),
  L('cy', 'Welsh', 'Cymraeg', 'Latn', ['GB'], 95),
  L('ga', 'Irish', 'Gaeilge', 'Latn', ['IE'], 96),
  L('is', 'Icelandic', 'Íslenska', 'Latn', ['IS'], 97),
]);

/**
 * Legacy or vendor-flavoured codes that should resolve to a catalogue key.
 * Kept tiny on purpose: a growing alias table is the router's job.
 */
const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  tl: 'fil',
  iw: 'he',
  in: 'id',
  nb: 'no',
  nn: 'no',
});

const BY_CODE: ReadonlyMap<string, CatalogueLanguage> = new Map(
  LANGUAGE_CATALOGUE.map((language) => [language.code, language]),
);

/**
 * Reduce any tag the gateway accepts (`en`, `en-US`, `EN-us`) to its base
 * subtag. Returns null for anything that is not tag-shaped, so callers never
 * get a "base" of garbage.
 */
export function baseSubtag(tag: string): string | null {
  const trimmed = tag.trim();
  if (trimmed.length === 0) return null;
  const primary = trimmed.split(/[-_]/, 1)[0]?.toLowerCase() ?? '';
  return /^[a-z]{2,3}$/.test(primary) ? primary : null;
}

/** Resolve a tag (regional suffix and legacy aliases tolerated) to its entry, or null. */
export function lookupLanguage(code: string): CatalogueLanguage | null {
  const base = baseSubtag(code);
  if (base === null) return null;
  return BY_CODE.get(ALIASES[base] ?? base) ?? null;
}

export function isCatalogueLanguage(code: string): boolean {
  return lookupLanguage(code) !== null;
}

/**
 * Case- and diacritic-insensitive fold so `français`, `FRANCAIS` and
 * `Francais` all meet the same string. NFD then strip combining marks covers
 * every Latin/Cyrillic/Greek diacritic; non-Latin scripts pass through
 * unchanged, which is right -- nobody types Japanese without its marks.
 */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u02bb\u02bc\u2019'\x60]/g, '')
    .toLowerCase()
    .trim();
}

/**
 * Search by code, English name or native name. Scored so an exact code hit
 * beats a name prefix, which beats a substring; ties fall back to rank so
 * `search('ma')` puts Marathi ahead of Malagasy.
 */
export function searchLanguages(query: string, limit = 10): CatalogueLanguage[] {
  const needle = fold(query);
  if (needle.length === 0 || limit <= 0) return [];

  const scored: { language: CatalogueLanguage; score: number }[] = [];
  for (const language of LANGUAGE_CATALOGUE) {
    const code = language.code;
    const english = fold(language.englishName);
    const native = fold(language.nativeName);
    let score = 0;
    if (code === needle || ALIASES[needle] === code) score = 5;
    else if (english === needle || native === needle) score = 4;
    else if (english.startsWith(needle) || native.startsWith(needle)) score = 3;
    else if (code.startsWith(needle)) score = 2;
    else if (english.includes(needle) || native.includes(needle)) score = 1;
    if (score > 0) scored.push({ language, score });
  }

  scored.sort((a, b) => b.score - a.score || a.language.rank - b.language.rank);
  return scored.slice(0, limit).map((entry) => entry.language);
}
