import { z } from 'zod';

export const LatencyBreakdownSchema = z.object({
  audioCaptureMs: z.number().nonnegative(),
  transcriptionMs: z.number().nonnegative(),
  translationMs: z.number().nonnegative(),
  speechGenerationMs: z.number().nonnegative(),
  deliveryMs: z.number().nonnegative(),
  synchronizationOffsetMs: z.number(),
});

export const AudioFormatSchema = z.enum(['mp3', 'ogg', 'wav', 'webm']).nullable();

export const TranslationEventSchema = z.object({
  eventId: z.string().min(1),
  sequence: z.number().int().positive(),
  sourceLanguage: z.string().min(2).max(10),
  targetLanguage: z.string().min(2).max(10),
  sourceText: z.string().min(1),
  translatedText: z.string().min(1),
  audioUrl: z.string().url().nullable(),
  audioFormat: AudioFormatSchema,
  audioDurationMs: z.number().positive().nullable(),
  final: z.boolean(),
  videoTimestampMs: z.number().nonnegative(),
  createdAt: z.string().datetime(),
  latency: LatencyBreakdownSchema,
});

export type ValidatedTranslationEvent = z.infer<typeof TranslationEventSchema>;

/** Parse and validate a translation event, throwing a ZodError on failure. */
export function parseTranslationEvent(raw: unknown): ValidatedTranslationEvent {
  return TranslationEventSchema.parse(raw);
}

/** Safe-parse: returns success/failure without throwing. */
export function safeParseTranslationEvent(raw: unknown) {
  return TranslationEventSchema.safeParse(raw);
}
