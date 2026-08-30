// No default target language exists (founder ruling, 30 Aug 2026: no EN->ES
// preset anywhere). Removing the last target leaves NO target and the start
// flow refuses to run without one.

export interface TargetLanguageSelection {
  targetLanguage: string;
  targetLanguages: string[];
}

export function selectSessionTargetLanguage(
  currentLanguages: readonly string[],
  language: string,
): TargetLanguageSelection {
  return {
    targetLanguage: language,
    targetLanguages: currentLanguages.includes(language)
      ? [...currentLanguages]
      : [...currentLanguages, language],
  };
}

export function toggleTargetLanguage(
  currentLanguages: readonly string[],
  currentTargetLanguage: string,
  language: string,
  checked: boolean,
): TargetLanguageSelection {
  const selected = [...new Set(currentLanguages)];

  if (checked) {
    const targetLanguages = selected.includes(language) ? selected : [...selected, language];
    return {
      targetLanguage: targetLanguages.includes(currentTargetLanguage)
        ? currentTargetLanguage
        : language,
      targetLanguages,
    };
  }

  const targetLanguages = selected.filter((current) => current !== language);
  return {
    targetLanguage: targetLanguages.includes(currentTargetLanguage)
      ? currentTargetLanguage
      : targetLanguages[0] ?? '',
    targetLanguages,
  };
}
