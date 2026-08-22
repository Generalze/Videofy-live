/** @author masterzee001 */
/**
 * ElevenLabs text-to-speech, against the existing TTS contract.
 *
 * EVIDENCE (read 2026-08-22):
 *   POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream
 *     returns streamed audio rather than a complete file
 *   `output_format` includes `pcm_16000` (and other pcm_* / mp3_* values)
 *   `model_id` defaults to `eleven_multilingual_v2`
 *   `eleven_flash_v2_5`  ~75 ms inference claimed, 32 languages
 *   `eleven_multilingual_v2`  29 languages, positioned for stability
 *   `optimize_streaming_latency` is documented as DEPRECATED
 *   -- elevenlabs.io/docs/api-reference/text-to-speech/stream
 *   -- elevenlabs.io/docs/overview/capabilities/text-to-speech
 *
 * WHY THE STREAMING ENDPOINT EVEN THOUGH THE TEXT IS COMPLETE. Translation is
 * request/response, so the whole sentence is known before synthesis begins --
 * which is precisely the case the vendor recommends this endpoint for. A
 * bidirectional TTS WebSocket exists for text that arrives incrementally, and
 * we have no incremental text. Using it would be complexity bought for a
 * problem we do not have.
 *
 * WHAT THIS DOES NOT YET IMPROVE, stated plainly. Audio reaches a listener as a
 * URL served by the generated-audio route, which sets `Content-Length` from the
 * finished file's size. So streaming here lowers the time to a COMPLETE FILE --
 * real, and worth having -- but perceived end-to-end latency does not drop
 * until delivery itself becomes progressive. That is a delivery-architecture
 * change and it is not in this wave. `timeToFirstChunkMs` is recorded so
 * C-AI1.2 can measure what the change would actually be worth.
 *
 * `pcm_16000` is requested because it is the engine's own format: 16 kHz mono
 * signed 16-bit. No resample, no transcode, no quality loss on the way in.
 */
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { MediaIngestError } from '../../ingest-error.js';
import type {
  TextToSpeechProvider,
  TextToSpeechProviderInput,
  TextToSpeechProviderResult,
} from '../../text-to-speech-provider.js';

export interface ElevenLabsTtsConfig {
  readonly apiKey: string;
  /** e.g. `eleven_flash_v2_5` or `eleven_multilingual_v2`. Part of the identity. */
  readonly modelId: string;
  /** Videofy voiceId -> vendor voice_id. Platform owns the mapping, not the vendor. */
  readonly voiceIds: Readonly<Record<string, string>>;
  readonly defaultVoiceId: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  /** `stream` is the default; `complete` is retained for comparison benchmarks. */
  readonly mode?: 'stream' | 'complete';
  readonly fetchImpl?: typeof fetch;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
}

export interface ElevenLabsSynthesisMetrics {
  readonly timeToFirstChunkMs: number | null;
  readonly totalMs: number;
  readonly bytes: number;
  readonly chunks: number;
}

export class ElevenLabsTextToSpeechProvider implements TextToSpeechProvider {
  readonly name: string;
  /** Per-request metrics, kept for certification evidence. */
  readonly metrics: ElevenLabsSynthesisMetrics[] = [];

  constructor(private readonly config: ElevenLabsTtsConfig) {
    this.name = `elevenlabs:${config.modelId}`;
  }

  async generate(input: TextToSpeechProviderInput): Promise<TextToSpeechProviderResult> {
    const vendorVoice = this.config.voiceIds[input.voiceId] ?? this.config.defaultVoiceId;
    const base = this.config.baseUrl ?? 'https://api.elevenlabs.io';
    const streaming = (this.config.mode ?? 'stream') === 'stream';
    const path = `/v1/text-to-speech/${encodeURIComponent(vendorVoice)}${streaming ? '/stream' : ''}`;
    // pcm_16000 matches the engine format exactly.
    const url = `${base}${path}?output_format=pcm_16000`;

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.config.timeoutMs ?? 30_000);
    const started = Date.now();
    let response: Response;
    try {
      response = await (this.config.fetchImpl ?? fetch)(url, {
        method: 'POST',
        headers: {
          'xi-api-key': this.config.apiKey,
          'content-type': 'application/json',
          accept: 'audio/pcm',
        },
        body: JSON.stringify({
          text: input.translatedText,
          model_id: this.config.modelId,
          // `optimize_streaming_latency` is deliberately absent: the vendor
          // documents it as deprecated, and shipping a deprecated knob is
          // borrowing a migration from the future.
        }),
        signal: abort.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      throw new MediaIngestError(
        `ElevenLabs request failed: ${error instanceof Error ? error.message : 'unknown'}`,
        'tts-failed',
        502,
      );
    }

    if (!response.ok) {
      clearTimeout(timer);
      const body = await response.text().catch(() => '');
      throw new MediaIngestError(
        `ElevenLabs returned ${response.status}: ${body.slice(0, 200)}`,
        'tts-failed',
        502,
      );
    }

    let timeToFirstChunkMs: number | null = null;
    let bytes = 0;
    let chunks = 0;

    try {
      if (response.body === null) {
        // No stream to consume; fall back to buffering the whole body.
        const buffer = Buffer.from(await response.arrayBuffer());
        bytes = buffer.length;
        chunks = 1;
        timeToFirstChunkMs = Date.now() - started;
        await writeFile(input.outputPath, buffer);
      } else {
        const sink = createWriteStream(input.outputPath);
        const reader = response.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value === undefined) continue;
            if (timeToFirstChunkMs === null) timeToFirstChunkMs = Date.now() - started;
            chunks += 1;
            bytes += value.byteLength;
            if (!sink.write(Buffer.from(value))) {
              // Respect backpressure rather than buffering an unbounded amount
              // of audio in memory while the disk catches up.
              await new Promise<void>((resolve) => sink.once('drain', () => resolve()));
            }
          }
        } finally {
          await new Promise<void>((resolve, reject) => {
            sink.end((error?: Error | null) => (error ? reject(error) : resolve()));
          });
        }
      }
    } finally {
      clearTimeout(timer);
    }

    if (bytes === 0) {
      // A zero-byte file would be served as valid silence. Better to fail here
      // than to have a listener hear nothing and no one know why.
      throw new MediaIngestError(
        'ElevenLabs returned no audio bytes.',
        'tts-failed',
        502,
      );
    }

    const totalMs = Date.now() - started;
    this.metrics.push({ timeToFirstChunkMs, totalMs, bytes, chunks });
    this.config.log?.('elevenlabs synthesis', {
      model: this.config.modelId,
      streaming,
      timeToFirstChunkMs,
      totalMs,
      chunks,
    });

    return {
      audioPath: input.outputPath,
      providerLatencyMs: totalMs,
      ...(vendorVoice === this.config.voiceIds[input.voiceId] ? {} : { effectiveVoiceId: input.voiceId }),
    };
  }
}
