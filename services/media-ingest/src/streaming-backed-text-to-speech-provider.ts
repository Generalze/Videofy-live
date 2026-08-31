/** @author masterzee001 */
/**
 * The live synthesis stack, presented as a file-writing batch provider.
 *
 * WHY THIS EXISTS. Uploaded programmes and live calls had two different speech
 * engines, and only one of them had been taught anything. The Nigerian
 * specialist routing, the certified fallback chain, the founder's chosen
 * voices and the degraded mark all hang off `StreamingSpeechSynthesisProvider`
 * -- reached from the live path alone. An uploaded programme ran
 * `TextToSpeechProvider`, whose only configured value on the deployment was
 * `mock`, so every translated segment of a real programme was written as a
 * 44-byte WAV: a header, a zero-length data chunk, and `providerLatencyMs: 0`
 * reported as success. Eight of them shipped to a listener on 31 Aug 2026.
 * Nothing anywhere said the word "silent" -- the pipeline logged "Generated
 * audio ready" for each one, because from its side each one had arrived.
 *
 * The two contracts still differ for good reasons -- a programme needs a
 * finished file and lip-fit pacing, a call needs samples the moment they exist
 * -- so this adapts rather than replaces. One synthesis AUTHORITY, two call
 * shapes: what a caller gets is decided by language and configuration in
 * exactly one place, and a fix to Yoruba lands on both paths or neither.
 *
 * ZERO SAMPLES IS A FAILURE. `StreamingSynthesisResult.samples` already says
 * so in its own comment; the batch path is where that went unenforced. A
 * provider returning nothing now throws instead of writing an empty file that
 * every downstream signal reads as audio.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MediaIngestError } from './ingest-error.js';
import type {
  StreamingSpeechSynthesisProvider,
  SynthesisDegradation,
} from './streaming-speech-synthesis-provider.js';
import type {
  TextToSpeechProvider,
  TextToSpeechProviderInput,
  TextToSpeechProviderResult,
} from './text-to-speech-provider.js';

/** The engine's own format, and the only one `SynthesisChunk` speaks. */
const SAMPLE_RATE_HZ = 16_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

export interface StreamingBackedTextToSpeechOptions {
  readonly provider: StreamingSpeechSynthesisProvider;
  /**
   * Told, not asked, when a segment was served by a fallback vendor.
   *
   * The batch result has nowhere to carry `degraded`, and adding it there
   * would ripple through every caller of a contract this change is meant to
   * leave alone. A programme still must not be able to hide the one failure no
   * server signal can see, so the mark is reported out of band to whoever is
   * keeping the session's record.
   */
  readonly onDegraded?: (
    input: TextToSpeechProviderInput,
    degradation: SynthesisDegradation,
  ) => void;
}

export class StreamingBackedTextToSpeechProvider implements TextToSpeechProvider {
  readonly name: string;

  constructor(private readonly options: StreamingBackedTextToSpeechOptions) {
    this.name = `streaming:${options.provider.name}`;
  }

  async generate(input: TextToSpeechProviderInput): Promise<TextToSpeechProviderResult> {
    const chunks: Int16Array[] = [];
    let total = 0;
    /*
     * Kept, not thrown from. `onError` may fire for a vendor this request
     * survived -- a chain reports the primary's failure on its way to the
     * fallback -- so the verdict belongs to the result, not to the first
     * complaint. It is only used to explain a result that produced no audio.
     */
    let lastError: Error | null = null;

    const started = Date.now();
    const result = await this.options.provider.synthesize({
      text: input.translatedText,
      targetLanguage: input.targetLanguage,
      /*
       * Passed through untouched, because this is how the founder's chosen
       * voices are reached. The specialist resolves `voiceIds[voiceId]` first,
       * so a session that set `<language>:<gender>` gets that exact chosen
       * voice, and a session that set nothing falls to the chosen default for
       * the language. Substituting a voice here would silently overrule both.
       */
      voiceId: input.voiceId,
      onChunk: (chunk) => {
        if (chunk.samples.length === 0) return;
        chunks.push(chunk.samples);
        total += chunk.samples.length;
      },
      onError: (error) => {
        lastError = error;
      },
    });

    if (total === 0 || result.samples === 0) {
      throw new MediaIngestError(
        `Speech synthesis produced no audio for ${input.targetLanguage}` +
          (lastError === null ? '.' : `: ${(lastError as Error).message}`),
        'tts-empty-output',
        502,
      );
    }

    if (result.degraded !== undefined) {
      this.options.onDegraded?.(input, result.degraded);
    }

    await mkdir(dirname(input.outputPath), { recursive: true });
    await writeFile(input.outputPath, encodeWav(chunks, total));

    return {
      audioPath: input.outputPath,
      providerLatencyMs: result.timeToFirstChunkMs ?? Date.now() - started,
    };
  }
}

/**
 * 16-bit PCM mono WAV, written little-endian.
 *
 * Sized from the sample count rather than measured afterwards: a header whose
 * declared length disagrees with the payload is how a file plays for one
 * second and stops, which looks like a synthesis fault and is not one.
 */
function encodeWav(chunks: readonly Int16Array[], totalSamples: number): Buffer {
  const dataBytes = totalSamples * (BITS_PER_SAMPLE / 8);
  const buffer = Buffer.alloc(44 + dataBytes);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(CHANNELS, 22);
  buffer.writeUInt32LE(SAMPLE_RATE_HZ, 24);
  buffer.writeUInt32LE((SAMPLE_RATE_HZ * CHANNELS * BITS_PER_SAMPLE) / 8, 28); // byte rate
  buffer.writeUInt16LE((CHANNELS * BITS_PER_SAMPLE) / 8, 32); // block align
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataBytes, 40);

  let offset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      buffer.writeInt16LE(sample, offset);
      offset += 2;
    }
  }
  return buffer;
}
