/** @author masterzee001 */
/**
 * The thin React binding over the vocabulary controller.
 *
 * Deliberately does almost nothing: the state machine, and every rule worth
 * testing, lives in `vocabularyController` where it can be driven without a
 * rendering library. What is left here is subscription and lifecycle, which is
 * the part React is actually for.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  INITIAL_STATE,
  createVocabularyController,
  type VocabularyClient,
  type VocabularyState,
} from './vocabularyController';
import type { VocabularyEntryDto } from './vocabularyClient';

export interface UseVocabularyOptions {
  readonly accountUrl: string;
  readonly ingestUrl: string;
  readonly programmeId: string | null;
  readonly client?: VocabularyClient;
}

export type UseVocabularyResult = VocabularyState & {
  readonly reload: () => Promise<void>;
  readonly save: (entry: VocabularyEntryDto, expectedRevision: number) => Promise<void>;
  readonly remove: (entryId: string, expectedRevision: number) => Promise<void>;
};

export function useVocabulary(options: UseVocabularyOptions): UseVocabularyResult {
  const [state, setState] = useState<VocabularyState>(INITIAL_STATE);
  const { accountUrl, ingestUrl, programmeId, client } = options;

  const controller = useMemo(
    () =>
      createVocabularyController({
        accountUrl,
        ingestUrl,
        programmeId,
        onState: setState,
        ...(client === undefined ? {} : { client }),
      }),
    [accountUrl, ingestUrl, programmeId, client],
  );

  useEffect(() => {
    void controller.reload();
  }, [controller]);

  return {
    ...state,
    reload: controller.reload,
    save: controller.save,
    remove: controller.remove,
  };
}
