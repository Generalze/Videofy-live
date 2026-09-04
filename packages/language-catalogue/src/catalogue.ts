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
  L('pcm', 'Nigerian Pidgin', 'Naijá', 'Latn', ['NG'], 24, {
    note: "A language in its own right (ISO 639-3 pcm), not \"broken English\": the "
      + 'everyday tongue of tens of millions across Nigeria. 9jaLingo synthesises it; no '
      + 'general translation engine in this deployment lists it, so the capability '
      + 'resolver will report the translation stage honestly rather than guess.',
  }),
  L('gu', 'Gujarati', 'ગુજરાતી', 'Gujr', ['IN'], 25),
  L('th', 'Thai', 'ไทย', 'Thai', ['TH'], 26),
  L('pa', 'Punjabi', 'ਪੰਜਾਬੀ', 'Guru', ['IN', 'PK'], 27, {
    note: 'Gurmukhi (India). The Pakistani Shahmukhi form is Arabic-script; a display choice, not a separate key.',
  }),
  L('kn', 'Kannada', 'ಕನ್ನಡ', 'Knda', ['IN'], 28),
  L('fil', 'Filipino', 'Filipino', 'Latn', ['PH'], 29, {
    note: 'Catalogue key is fil (BCP-47). Deepgram calls this tl; Azure Speech uses fil-PH. The router maps per vendor; tl resolves here as an alias.',
  }),
  L('pl', 'Polish', 'Polski', 'Latn', ['PL'], 30),
  L('yo', 'Yoruba', 'Èdè Yorùbá', 'Latn', ['NG', 'BJ'], 31),
  L('ml', 'Malayalam', 'മലയാളം', 'Mlym', ['IN'], 32),
  L('ms', 'Malay', 'Bahasa Melayu', 'Latn', ['MY', 'BN', 'SG'], 33),
  L('or', 'Odia', 'ଓଡ଼ିଆ', 'Orya', ['IN'], 34),
  L('my', 'Burmese', 'မြန်မာစာ', 'Mymr', ['MM'], 35),
  L('uk', 'Ukrainian', 'Українська', 'Cyrl', ['UA'], 36),
  L('ig', 'Igbo', 'Asụsụ Igbo', 'Latn', ['NG'], 37),
  L('am', 'Amharic', 'አማርኛ', 'Ethi', ['ET'], 38),
  L('uz', 'Uzbek', 'Oʻzbekcha', 'Latn', ['UZ', 'AF'], 39),
  L('nl', 'Dutch', 'Nederlands', 'Latn', ['NL', 'BE', 'SR'], 40),
  L('ro', 'Romanian', 'Română', 'Latn', ['RO', 'MD'], 41),
  L('ne', 'Nepali', 'नेपाली', 'Deva', ['NP', 'IN'], 42),
  L('sd', 'Sindhi', 'سنڌي', 'Arab', ['PK', 'IN'], 43, RTL),
  L('ps', 'Pashto', 'پښتو', 'Arab', ['AF', 'PK'], 44, RTL),
  L('om', 'Oromo', 'Afaan Oromoo', 'Latn', ['ET', 'KE'], 45),
  L('ku', 'Kurdish', 'Kurdî', 'Latn', ['TR', 'IQ', 'IR', 'SY'], 46, {
    note: 'Kurmanji (Latin). Sorani is Arabic-script; a display choice, not a separate key.',
  }),
  L('az', 'Azerbaijani', 'Azərbaycan dili', 'Latn', ['AZ', 'IR'], 47),
  L('el', 'Greek', 'Ελληνικά', 'Grek', ['GR', 'CY'], 48),
  L('hu', 'Hungarian', 'Magyar', 'Latn', ['HU', 'RO'], 49),
  L('cs', 'Czech', 'Čeština', 'Latn', ['CZ'], 50),
  L('sv', 'Swedish', 'Svenska', 'Latn', ['SE', 'FI'], 51),
  L('zu', 'Zulu', 'isiZulu', 'Latn', ['ZA'], 52),
  L('kk', 'Kazakh', 'Қазақ тілі', 'Cyrl', ['KZ'], 53),
  L('so', 'Somali', 'Af-Soomaali', 'Latn', ['SO', 'ET', 'KE', 'DJ'], 54),
  L('km', 'Khmer', 'ខ្មែរ', 'Khmr', ['KH'], 55),
  L('rw', 'Kinyarwanda', 'Ikinyarwanda', 'Latn', ['RW'], 56),
  L('mg', 'Malagasy', 'Malagasy', 'Latn', ['MG'], 57),
  L('he', 'Hebrew', 'עברית', 'Hebr', ['IL'], 58, RTL),
  L('si', 'Sinhala', 'සිංහල', 'Sinh', ['LK'], 59),
  L('bg', 'Bulgarian', 'Български', 'Cyrl', ['BG'], 60),
  L('sr', 'Serbian', 'Српски', 'Cyrl', ['RS', 'BA', 'ME'], 61, {
    note: 'Cyrillic default; Latin is co-official and a display choice, not a separate key.',
  }),
  L('xh', 'Xhosa', 'isiXhosa', 'Latn', ['ZA'], 62),
  L('af', 'Afrikaans', 'Afrikaans', 'Latn', ['ZA', 'NA'], 63),
  L('ti', 'Tigrinya', 'ትግርኛ', 'Ethi', ['ER', 'ET'], 64),
  L('wo', 'Wolof', 'Wolof', 'Latn', ['SN', 'GM'], 65),
  L('ff', 'Fula', 'Fulfulde', 'Latn', ['NG', 'SN', 'GN', 'ML'], 66),
  L('ln', 'Lingala', 'Lingála', 'Latn', ['CD', 'CG'], 67),
  L('sn', 'Shona', 'chiShona', 'Latn', ['ZW'], 68),
  L('tg', 'Tajik', 'Тоҷикӣ', 'Cyrl', ['TJ'], 69),
  L('ky', 'Kyrgyz', 'Кыргызча', 'Cyrl', ['KG'], 70),
  L('da', 'Danish', 'Dansk', 'Latn', ['DK'], 71),
  L('fi', 'Finnish', 'Suomi', 'Latn', ['FI'], 72),
  L('sk', 'Slovak', 'Slovenčina', 'Latn', ['SK'], 73),
  L('no', 'Norwegian', 'Norsk', 'Latn', ['NO'], 74),
  L('hr', 'Croatian', 'Hrvatski', 'Latn', ['HR', 'BA'], 75),
  L('ca', 'Catalan', 'Català', 'Latn', ['ES', 'AD'], 76),
  L('nso', 'Northern Sotho', 'Sesotho sa Leboa', 'Latn', ['ZA'], 77),
  L('st', 'Southern Sotho', 'Sesotho', 'Latn', ['LS', 'ZA'], 78),
  L('tn', 'Tswana', 'Setswana', 'Latn', ['BW', 'ZA'], 79),
  L('hy', 'Armenian', 'Հայերեն', 'Armn', ['AM'], 80),
  L('ka', 'Georgian', 'ქართული', 'Geor', ['GE'], 81),
  L('mn', 'Mongolian', 'Монгол', 'Cyrl', ['MN'], 82),
  L('lo', 'Lao', 'ລາວ', 'Laoo', ['LA'], 83),
  L('ht', 'Haitian Creole', 'Kreyòl ayisyen', 'Latn', ['HT'], 84),
  L('sq', 'Albanian', 'Shqip', 'Latn', ['AL', 'XK', 'MK'], 85),
  L('bs', 'Bosnian', 'Bosanski', 'Latn', ['BA'], 86),
  L('lt', 'Lithuanian', 'Lietuvių', 'Latn', ['LT'], 87),
  L('ts', 'Tsonga', 'Xitsonga', 'Latn', ['ZA', 'MZ'], 88),
  L('sl', 'Slovenian', 'Slovenščina', 'Latn', ['SI'], 89),
  L('mk', 'Macedonian', 'Македонски', 'Cyrl', ['MK'], 90),
  L('lv', 'Latvian', 'Latviešu', 'Latn', ['LV'], 91),
  L('gl', 'Galician', 'Galego', 'Latn', ['ES'], 92),
  L('et', 'Estonian', 'Eesti', 'Latn', ['EE'], 93),
  L('eu', 'Basque', 'Euskara', 'Latn', ['ES', 'FR'], 94),
  L('ve', 'Venda', 'Tshivenḓa', 'Latn', ['ZA'], 95),
  L('cy', 'Welsh', 'Cymraeg', 'Latn', ['GB'], 96),
  L('ga', 'Irish', 'Gaeilge', 'Latn', ['IE'], 97),
  L('is', 'Icelandic', 'Íslenska', 'Latn', ['IS'], 98),
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
