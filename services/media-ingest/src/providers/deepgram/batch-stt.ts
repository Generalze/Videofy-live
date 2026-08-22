/** @author masterzee001 */
/**
 * Deepgram pre-recorded transcription, against the existing batch contract.
 *
 * The uploaded-programme path. No listener is waiting, so accuracy, context and
 * cost per hour matter more than time-to-first-token -- which is the whole
 * reason the batch contract was kept rather than replaced when streaming
 * arrived.
 *
 * EVIDENCE (read 2026-08-22): the same model catalogue as the streaming
 * adapter; `nova-3` is documented as supporting both streaming and batch.
 *   -- developers.deepgram.com/docs/models-languages-overview
 *
 * NOT VERIFIED: the exact pre-recorded response envelope was not read during
 * this pass, so parsing is written defensively and every field is treated as
 * optional. The credential-gated smoke test is what confirms the shape.
 */
import { readFile } from 'node:fs/promises';
import { MediaIngestError } from '../../ingest-error.js';
import type {
  TranscriptionProvider,
  TranscriptionProviderInput,
  TranscriptionProviderResult,
  TranscriptionSegment,
} from '../../transcription-provider.js';

export interface DeepgramBatchConfig {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly punctuate?: boolean;
  /** Ask for utterance-level segmentation rather than one wall of text. */
  readonly utterances?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (line: string, detail?: Record<string, unknown>) => void;
}

export class DeepgramBatchTranscriptionProvider implements TranscriptionProvider {
  readonly name: string;

  constructor(private readonly config: DeepgramBatchConfig) {
    // Flux is STREAMING ONLY. The first pass recorded `batch: 'yes'` for it from
    // a summary page; the Flux documentation describes no pre-recorded path.
    // Refused at construction so a misconfiguration is a startup error rather
    // than an uploaded programme that silently transcribes to nothing.
    if (config.model.startsWith('flux')) {
      throw new Error(
        `${config.model} is streaming-only; Deepgram documents no batch path for Flux. ` +
          `Use a Nova model for uploaded programmes.`,
      );
    }
    this.name = `deepgram-batch:${config.model}`;
  }

  async transcribe(input: TranscriptionProviderInput): Promise<TranscriptionProviderResult> {
    const started = Date.now();
    const base = this.config.baseUrl ?? 'https://api.deepgram.com/v1/listen';
    const params = new URLSearchParams({
      model: this.config.model,
      punctuate: String(this.config.punctuate ?? true),
      utterances: String(this.config.utterances ?? true),
    });
    if (input.sourceLanguage !== undefined && input.sourceLanguageMode !== 'auto-detect') {
      params.set('language', input.sourceLanguage);
    } else {
      // Only ask for detection when the platform genuinely does not know. A
      // session that HAS declared its language must not have that overridden by
      // a guess.
      params.set('detect_language', 'true');
    }

    const audio = await readFile(input.audioPath);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.config.timeoutMs ?? 120_000);
    let response: Response;
    try {
      response = await (this.config.fetchImpl ?? fetch)(`${base}?${params.toString()}`, {
        method: 'POST',
        headers: {
          Authorization: `Token ${this.config.apiKey}`,
          'content-type': 'audio/wav',
        },
        body: audio,
        signal: abort.signal,
      });
    } catch (error) {
      throw new MediaIngestError(
        `Deepgram batch request failed: ${error instanceof Error ? error.message : 'unknown'}`,
        'transcription-failed',
        502,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new MediaIngestError(
        `Deepgram batch returned ${response.status}: ${body.slice(0, 200)}`,
        'transcription-failed',
        502,
      );
    }

    const payload = (await response.json()) as DeepgramBatchResponse;
    const channel = payload.results?.channels?.[0];
    const alternative = channel?.alternatives?.[0];

    // Prefer utterance segmentation; fall back to the single transcript. A
    // wall of text with one timestamp pair would make the whole chunk one
    // segment, and downstream timing would be wrong for everything after the
    // first sentence.
    const utterances = payload.results?.utterances ?? [];
    const segments: TranscriptionSegment[] =
      utterances.length > 0
        ? utterances
            .filter((utterance) => (utterance.transcript ?? '').trim() !== '')
            .map((utterance) => ({
              text: (utterance.transcript ?? '').trim(),
              startMs: Math.round((utterance.start ?? 0) * 1000),
              endMs: Math.round((utterance.end ?? 0) * 1000),
            }))
        : (alternative?.transcript ?? '').trim() === ''
          ? []
          : [
              {
                text: (alternative?.transcript ?? '').trim(),
                startMs: 0,
                endMs: Math.round((payload.metadata?.duration ?? 0) * 1000),
              },
            ];

    return {
      segments,
      detectedLanguage: channel?.detected_language ?? input.sourceLanguage ?? '',
      confidence: alternative?.confidence ?? null,
      providerLatencyMs: Date.now() - started,
    };
  }
}

/** The vendor's response shape. Confined to this file by design. */
interface DeepgramBatchResponse {
  metadata?: { duration?: number };
  results?: {
    channels?: {
      detected_language?: string;
      alternatives?: { transcript?: string; confidence?: number }[];
    }[];
    utterances?: { transcript?: string; start?: number; end?: number }[];
  };
}
