import { z } from 'zod';

export const TimestampedTranslationStatusSchema = z.enum([
  'queued',
  'translating',
  'translated',
  'failed',
  'retrying',
]);

export const TimestampedTranslationLatencySchema = z.object({
  queuedMs: z.number().nonnegative(),
  providerMs: z.number().nonnegative(),
  totalMs: z.number().nonnegative(),
});

export const TimestampedTranslationEventSchema = z
  .object({
    sessionId: z.string().min(1),
    streamId: z.string().min(1),
    segmentId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    sourceLanguage: z.string().min(2).max(16),
    sourceLanguageRevision: z.number().int().nonnegative().optional(),
    targetLanguage: z.string().min(2).max(16),
    sourceText: z.string(),
    translatedText: z.string(),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    status: TimestampedTranslationStatusSchema,
    latency: TimestampedTranslationLatencySchema,
    // Streaming captions (§22.1). Optional and literal-false: absence means
    // final. Declared so zod carries the flag instead of stripping it.
    isFinal: z.literal(false).optional(),
    partialSequence: z.number().int().nonnegative().optional(),
    error: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
  })
  .refine((event) => event.endMs > event.startMs, {
    message: 'endMs must be greater than startMs',
    path: ['endMs'],
  });

export type ValidatedTimestampedTranslationEvent = z.infer<
  typeof TimestampedTranslationEventSchema
>;

export function parseTimestampedTranslationEvent(
  raw: unknown,
): ValidatedTimestampedTranslationEvent {
  return TimestampedTranslationEventSchema.parse(raw);
}

export function safeParseTimestampedTranslationEvent(raw: unknown) {
  return TimestampedTranslationEventSchema.safeParse(raw);
}
