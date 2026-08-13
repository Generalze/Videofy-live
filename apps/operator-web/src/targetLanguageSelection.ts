export const DEFAULT_TARGET_LANGUAGE = 'es';

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
  const selected = currentLanguages.length > 0 ? [...new Set(currentLanguages)] : [DEFAULT_TARGET_LANGUAGE];

  if (checked) {
    const targetLanguages = selected.includes(language) ? selected : [...selected, language];
    return {
      targetLanguage: targetLanguages.includes(currentTargetLanguage)
        ? currentTargetLanguage
        : language,
      targetLanguages,
    };
  }

  const remaining = selected.filter((current) => current !== language);
  const targetLanguages = remaining.length > 0 ? remaining : [DEFAULT_TARGET_LANGUAGE];
  return {
    targetLanguage: targetLanguages.includes(currentTargetLanguage)
      ? currentTargetLanguage
      : targetLanguages[0] ?? DEFAULT_TARGET_LANGUAGE,
    targetLanguages,
  };
}
