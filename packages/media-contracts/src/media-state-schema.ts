import { z } from 'zod';

export const StreamStatusSchema = z.enum([
  'idle',
  'connecting',
  'live',
  'paused',
  'ended',
  'error',
]);

export const VideoSourceSchema = z.enum([
  'mock',
  'local-file',
  'webcam',
  'zoom',
  'teams',
  'meet',
  'obs',
  'rtmp',
  'webrtc',
  'hls',
]);

export const MediaStateEventSchema = z.object({
  eventId: z.string().min(1),
  streamStatus: StreamStatusSchema,
  videoSource: VideoSourceSchema,
  videoTimestampMs: z.number().nonnegative(),
  sourceAudioActive: z.boolean(),
  translatedLanguages: z.array(z.string().min(2).max(10)),
  connectedListeners: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
});

export type ValidatedMediaStateEvent = z.infer<typeof MediaStateEventSchema>;

export function parseMediaStateEvent(raw: unknown): ValidatedMediaStateEvent {
  return MediaStateEventSchema.parse(raw);
}

export function safeParseMediaStateEvent(raw: unknown) {
  return MediaStateEventSchema.safeParse(raw);
}
