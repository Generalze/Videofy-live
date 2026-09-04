export type SourceLanguageMode = 'manual' | 'auto-detect';
export type SourceLanguageStatus =
  | 'manual'
  | 'detecting'
  | 'detected'
  | 'needs-confirmation'
  | 'confirmed'
  | 'rejected'
  | 'locked';

export interface SourceLanguageControlMetadata {
  defaultLanguage: string;
  activeLanguage: string;
  mode: SourceLanguageMode;
  status: SourceLanguageStatus;
  detectedLanguage: string | null;
  detectionConfidence: number | null;
  confirmedLanguage: string | null;
  rejectedLanguage: string | null;
  locked: boolean;
  revision: number;
  confidenceThreshold: number;
  updatedAt: string;
}

export type TargetLanguageAvailability =
  | 'translation-available'
  | 'voice-available'
  | 'text-only'
  | 'unavailable'
  | 'experimental';

/**
 * Evidence grade of the LIVE translation chain for a language, mirrored from
 * ai-registry's resolver (shared-types cannot depend on a service). The
 * deployment-level `availability` says what THIS box is configured to do; the
 * state says how much the vendor chain behind it has been proven.
 */
export type TargetLanguageCapabilityState = 'available' | 'qualified' | 'limited' | 'unavailable';

export interface TargetLanguageCapabilityProviders {
  stt?: string;
  mt?: string;
  tts?: string;
}

export interface TargetLanguageCapability {
  language: string;
  label: string;
  /** Catalogue endonym; absent for a target that is outside the catalogue. */
  nativeName?: string;
  state?: TargetLanguageCapabilityState;
  /**
   * The same evidence read for one direction at a time.
   *
   * `state` is the weakest of all three chain stages, which is the right
   * conservative answer and the wrong one for a picker: it refused Igbo as a
   * TARGET because no recogniser transcribes Igbo, which has nothing to do
   * with whether a listener can hear it.
   */
  sourceState?: TargetLanguageCapabilityState;
  targetState?: TargetLanguageCapabilityState;
  /** Translatable, with no voice on the chain. A product state, not a fault. */
  captionsOnly?: boolean;
  /**
   * A Nigerian language served by a general voice vendor rather than the
   * 9jaLingo specialist. The audio plays and is wrong; every surface that
   * shows this language must say so. See `reason` for the words.
   */
  degraded?: boolean;
  providers?: TargetLanguageCapabilityProviders;
  /** Names the chain stage(s) holding the state below `qualified`. */
  reason?: string;
  translationAvailable: boolean;
  voiceAvailable: boolean;
  textOnly: boolean;
  experimental: boolean;
  availability: TargetLanguageAvailability;
  translationModel: string | null;
  voiceId: string | null;
  license: string;
  commercialUse: 'allowed' | 'unknown' | 'restricted';
  /**
   * Whether this language may carry a PROGRAMME.
   *
   * A DIFFERENT QUESTION FROM `availability`, and the distinction is the whole
   * point. `availability` says whether the chain can produce audio; this says
   * whether anyone who reads the language has judged that audio fit to
   * broadcast. For Yoruba, Igbo, Hausa and Nigerian Pidgin a general vendor
   * returns HTTP 200 and fluent-sounding speech with the wrong pronunciation,
   * so "the chain produced audio" is precisely the evidence that must not be
   * accepted as readiness.
   *
   * Absent means this catalogue was built without asking. Every surface that
   * gates a broadcast must treat absent as false rather than as unrestricted.
   */
  programmeRoute?: {
    readonly available: boolean;
    /** Why not, in words an operator can act on. Null when available. */
    readonly reason: string | null;
  };
}

export type TargetLanguageOutputStatus =
  | 'unavailable'
  | 'queued'
  | 'translating'
  | 'captions-ready'
  | 'generating-audio'
  | 'ready'
  | 'failed';

export interface TargetLanguageOutput {
  language: string;
  status: TargetLanguageOutputStatus;
  translationProgressPct: number;
  audioProgressPct: number;
  captionsAvailable: boolean;
  audioAvailable: boolean;
  error: string | null;
}

export interface AiProviderStatusMetadata {
  worker: 'offline' | 'ready' | 'processing' | 'delayed' | 'failed';
  vad: 'inactive' | 'active' | 'fallback' | 'failed';
  transcription: 'idle' | 'loading' | 'ready' | 'processing' | 'failed';
  translation: 'idle' | 'loading' | 'ready' | 'processing' | 'failed';
  textToSpeech: 'idle' | 'loading' | 'ready' | 'text-only' | 'processing' | 'failed';
  lastError: string | null;
}
