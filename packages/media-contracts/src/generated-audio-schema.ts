import { z } from 'zod';

export const GeneratedAudioReadyEventSchema = z
  .object({
    sessionId: z.string().min(1),
    streamId: z.string().min(1),
    segmentId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    targetLanguage: z.string().min(2).max(16),
    translatedText: z.string(),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    voiceId: z.string().min(1),
    durationMs: z.number().int().nonnegative(),
    providerLatencyMs: z.number().int().nonnegative().nullable(),
    audioUrl: z
      .string()
      .url()
      .refine((value) => {
        const protocol = new URL(value).protocol;
        return protocol === 'http:' || protocol === 'https:';
      }, 'audioUrl must use http or https'),
    createdAt: z.string().datetime(),
  })
  .refine((event) => event.endMs > event.startMs, {
    message: 'endMs must be greater than startMs',
    path: ['endMs'],
  });

export type ValidatedGeneratedAudioReadyEvent = z.infer<typeof GeneratedAudioReadyEventSchema>;

export function parseGeneratedAudioReadyEvent(raw: unknown): ValidatedGeneratedAudioReadyEvent {
  return GeneratedAudioReadyEventSchema.parse(raw);
}

export function safeParseGeneratedAudioReadyEvent(raw: unknown) {
  return GeneratedAudioReadyEventSchema.safeParse(raw);
}
