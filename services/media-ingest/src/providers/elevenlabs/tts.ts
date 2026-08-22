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
 * TWO SURFACES, ONE VENDOR. `ElevenLabsTextToSpeechProvider` writes a finished
 * file and remains correct for uploaded programmes, lip-fit pacing and
 * personal-voice synthesis, where the pipeline genuinely wants a file.
 * `ElevenLabsStreamingSynthesisProvider` hands audio onward as it arrives, for
 * live calls, where waiting for a complete file is waiting for the end of a
 * sentence before starting to say its beginning.
 *
 * C-AI1.1C recorded honestly that streaming here lowered time-to-complete-file
 * and changed nothing a caller could hear, because delivery required a finished
 * file. C-AI1.1D removed that requirement, so the second surface exists now.
 *
 * `pcm_16000` is requested because it is the engine's own format: 16 kHz mono
 * signed 16-bit. No resample, no transcode, no quality loss on the way in.
 */
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { MediaIngestError } from '../../ingest-error.js';
import type {
  StreamingSpeechSynthesisProvider,
  StreamingSynthesisOptions,
  StreamingSynthesisResult,
} from '../../streaming-speech-synthesis-provider.js';
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

import { Pcm16Decoder } from '../pcm16-decoder.js';

// Re-exported so existing importers and their tests are unaffected. The class
// moved because Azure streams the same raw PCM16 and the split-sample carry is
// a fact about bytes, not about a vendor.
export { Pcm16Decoder };

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

/**
 * The live-call surface: audio handed onward as it arrives.
 *
 * Emits nothing but samples. It cannot name a segment, number a frame, or
 * declare that a sentence finished being spoken -- `TranslatedAudioFramer`
 * does all three on the platform side of the seam, so those meanings stay the
 * same when the next TTS vendor arrives with different chunking.
 */
export class ElevenLabsStreamingSynthesisProvider implements StreamingSpeechSynthesisProvider {
  readonly name: string;

  constructor(private readonly config: ElevenLabsTtsConfig) {
    this.name = `elevenlabs-streaming:${config.modelId}`;
  }

  async synthesize(options: StreamingSynthesisOptions): Promise<StreamingSynthesisResult> {
    const vendorVoice = this.config.voiceIds[options.voiceId] ?? this.config.defaultVoiceId;
    const base = this.config.baseUrl ?? 'https://api.elevenlabs.io';
    const url = `${base}/v1/text-to-speech/${encodeURIComponent(vendorVoice)}/stream?output_format=pcm_16000`;

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.config.timeoutMs ?? 30_000);
    // A superseded sentence must stop costing money and bandwidth immediately;
    // on a call it is also competing for the same bounded queue as the sentence
    // that replaced it.
    const onCallerAbort = (): void => abort.abort();
    options.signal?.addEventListener('abort', onCallerAbort, { once: true });

    const started = Date.now();
    let timeToFirstChunkMs: number | null = null;
    let samples = 0;

    try {
      let response: Response;
      try {
        response = await (this.config.fetchImpl ?? fetch)(url, {
          method: 'POST',
          headers: {
            'xi-api-key': this.config.apiKey,
            'content-type': 'application/json',
            accept: 'audio/pcm',
          },
          body: JSON.stringify({ text: options.text, model_id: this.config.modelId }),
          signal: abort.signal,
        });
      } catch (error) {
        if (options.signal?.aborted === true) {
          return { samples: 0, timeToFirstChunkMs: null, totalMs: Date.now() - started, aborted: true };
        }
        throw new MediaIngestError(
          `ElevenLabs request failed: ${error instanceof Error ? error.message : 'unknown'}`,
          'tts-failed',
          502,
        );
      }

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new MediaIngestError(
          `ElevenLabs returned ${response.status}: ${body.slice(0, 200)}`,
          'tts-failed',
          502,
        );
      }
      if (response.body === null) {
        throw new MediaIngestError('ElevenLabs returned no audio stream.', 'tts-failed', 502);
      }

      const decoder = new Pcm16Decoder();
      const reader = response.body.getReader();
      for (;;) {
        if (options.signal?.aborted === true) {
          await reader.cancel('superseded').catch(() => {});
          return { samples, timeToFirstChunkMs, totalMs: Date.now() - started, aborted: true };
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        const decoded = decoder.push(value);
        if (decoded.length === 0) continue;
        if (timeToFirstChunkMs === null) timeToFirstChunkMs = Date.now() - started;
        samples += decoded.length;
        options.onChunk({ samples: decoded });
      }

      if (samples === 0) {
        // Silence would be served as valid audio and a listener would hear
        // nothing with nobody knowing why.
        throw new MediaIngestError('ElevenLabs returned no audio bytes.', 'tts-failed', 502);
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onCallerAbort);
    }

    const totalMs = Date.now() - started;
    this.config.log?.('elevenlabs streaming synthesis', {
      model: this.config.modelId,
      timeToFirstChunkMs,
      totalMs,
      samples,
    });
    return { samples, timeToFirstChunkMs, totalMs, aborted: false };
  }
}
