import { z } from 'zod';

export const TranscriptionStatusSchema = z.enum([
  'queued',
  'transcribing',
  'transcribed',
  'failed',
  'retrying',
]);

export const TranscriptionEventSchema = z.object({
  sessionId: z.string().min(1),
  streamId: z.string().min(1),
  chunkId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  sourceText: z.string(),
  detectedLanguage: z.string().min(2).max(16),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().positive(),
  confidence: z.number().min(0).max(1).nullable(),
  providerLatencyMs: z.number().int().nonnegative().nullable().optional(),
  status: TranscriptionStatusSchema,
  // Streaming captions (§22.1). Optional and literal-false: absence means
  // final, so every existing producer stays valid. These MUST be declared or
  // zod strips them and the partial flag never reaches the call runtime.
  isFinal: z.literal(false).optional(),
  partialSequence: z.number().int().nonnegative().optional(),
  error: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
});

export type ValidatedTranscriptionEvent = z.infer<typeof TranscriptionEventSchema>;

export function parseTranscriptionEvent(raw: unknown): ValidatedTranscriptionEvent {
  return TranscriptionEventSchema.parse(raw);
}

export function safeParseTranscriptionEvent(raw: unknown) {
  return TranscriptionEventSchema.safeParse(raw);
}
