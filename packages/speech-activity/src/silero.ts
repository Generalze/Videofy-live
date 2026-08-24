/**
 * Silero VAD: a learned answer to "is this a voice?".
 *
 * The energy gate opened for anything loud and the voicing test opened for
 * anything periodic, so a steady tone or music still got through — and a
 * recogniser handed non-speech returns WORDS for it. Silero is a small trained
 * model that answers the question directly, and it is the right tool for it.
 *
 * WHY INFERENCE IS FIRE-AND-FORGET. onnxruntime has no synchronous run, and
 * SpeechActivityGate.push is synchronous — it is called per frame from a hot
 * audio path, and making it async would ripple through the chunker, the live
 * pipeline and every caller of both. Instead each window is submitted without
 * being awaited and the newest probability is kept for the gate to read.
 *
 * That costs ONE WINDOW of lag, about 32 ms. It is affordable precisely here:
 * the gate already requires ~150 ms of sustained speech before it opens and
 * keeps 200 ms of post-roll before it closes, so a 32 ms-old verdict cannot
 * change either decision. Anywhere those margins were tighter, this trade
 * would be wrong.
 *
 * A window is DROPPED rather than queued while inference is in flight. A VAD
 * wants the most recent answer, and a backlog would deliver stale ones later
 * and more slowly — the opposite of the point.
 */
/*
 * TYPE-ONLY at the top, loaded on demand below.
 *
 * onnxruntime-node is a NATIVE binary. Imported eagerly it becomes a hard
 * requirement for every consumer of this package -- including the gateway,
 * which uses the gate and never Silero -- so a platform where the binary fails
 * to load would take down services that had no need of it. Imported inside the
 * factory, only a deployment that actually asks for Silero can be hurt by it,
 * and that path already falls back.
 */
import type * as OrtTypes from 'onnxruntime-node';

type Ort = typeof OrtTypes;

/**
 * Fixed by the model, and NOT what you would guess.
 *
 * Silero v5 at 16 kHz advances 512 samples per step but its tensor is 576: the
 * 512 new samples preceded by 64 of CONTEXT carried from the previous step.
 * Feed it a bare 512 and it runs without complaint and scores real speech at
 * 0.055 -- indistinguishable from noise. It fails silently and looks like a bad
 * model rather than a bad call, which is exactly how an hour disappears.
 */
export const SILERO_STEP_SAMPLES = 512;
export const SILERO_CONTEXT_SAMPLES = 64;
export const SILERO_WINDOW_SAMPLES = SILERO_STEP_SAMPLES + SILERO_CONTEXT_SAMPLES;
export const SILERO_SAMPLE_RATE = 16000;

/** Recurrent state carried between windows: [2, 1, 128]. */
const STATE_LENGTH = 2 * 1 * 128;

/**
 * Speech probability above which a window counts as voice.
 *
 * Silero's own documentation suggests 0.5 as a general default, and it is
 * deliberately not tuned tighter here: the gate's voiced-fraction and
 * minimum-duration rules still have to be satisfied, so this decides frames,
 * not utterances.
 */
export const SILERO_SPEECH_THRESHOLD = 0.5;

export interface SpeechProbabilityDetector {
  /** Submit audio. Never throws, never blocks. */
  push(samples: Int16Array): void;
  /** The most recent probability, 0..1. */
  readonly probability: number;
  /** Forget recurrent state at a discontinuity. */
  reset(): void;
}

export class SileroSpeechDetector implements SpeechProbabilityDetector {
  private state = new Float32Array(STATE_LENGTH);
  /** Samples not yet forming a full step. */
  private pending: number[] = [];
  /** The trailing 64 samples of the previous step, prepended to the next. */
  private context = new Float32Array(SILERO_CONTEXT_SAMPLES);
  private latest = 0;
  private inFlight = false;
  private failures = 0;

  private constructor(
    private readonly ort: Ort,
    private readonly session: OrtTypes.InferenceSession,
  ) {}

  /**
   * Loads the model, or throws.
   *
   * The caller is expected to catch and fall back: a missing or corrupt model
   * must degrade to the energy-and-voicing gate, never take calls down.
   */
  static async create(modelPath: string): Promise<SileroSpeechDetector> {
    return (await SileroSpeechDetector.factory(modelPath))();
  }

  /**
   * One session, many detectors.
   *
   * The MODEL is shared -- loading it costs time and memory and it is
   * stateless. The recurrent STATE is not: it describes one conversation, and
   * two participants speaking at once through a single detector would each be
   * judged against the other's audio. So the session is loaded once and every
   * stream gets its own detector over it.
   */
  static async factory(modelPath: string): Promise<() => SileroSpeechDetector> {
    const ort = (await import('onnxruntime-node')) as unknown as Ort;
    const session = await ort.InferenceSession.create(modelPath);
    const required = ['input', 'state', 'sr'];
    const missing = required.filter((name) => !session.inputNames.includes(name));
    if (missing.length > 0) {
      // A different Silero revision with a different signature. Better to
      // refuse and fall back than to feed it tensors it did not ask for.
      throw new Error(
        `silero model at ${modelPath} does not expose ${missing.join(', ')}; ` +
          `found ${session.inputNames.join(', ')}`,
      );
    }
    return () => new SileroSpeechDetector(ort, session);
  }

  get probability(): number {
    return this.latest;
  }

  reset(): void {
    this.state = new Float32Array(STATE_LENGTH);
    this.context = new Float32Array(SILERO_CONTEXT_SAMPLES);
    this.pending = [];
    this.latest = 0;
  }

  push(samples: Int16Array): void {
    for (const sample of samples) this.pending.push(sample / 32768);
    // Only ever the NEWEST step: if audio arrived faster than inference, the
    // older ones describe a moment already past. The context still advances
    // for every step, so a dropped inference does not desynchronise the model.
    while (this.pending.length >= SILERO_STEP_SAMPLES) {
      const step = Float32Array.from(this.pending.slice(0, SILERO_STEP_SAMPLES));
      this.pending = this.pending.slice(SILERO_STEP_SAMPLES);

      const window = new Float32Array(SILERO_WINDOW_SAMPLES);
      window.set(this.context, 0);
      window.set(step, SILERO_CONTEXT_SAMPLES);
      this.context = step.slice(SILERO_STEP_SAMPLES - SILERO_CONTEXT_SAMPLES);

      if (this.pending.length < SILERO_STEP_SAMPLES) void this.run(window);
    }
  }

  private async run(window: Float32Array): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const feeds: Record<string, OrtTypes.Tensor> = {
        input: new this.ort.Tensor('float32', window, [1, SILERO_WINDOW_SAMPLES]),
        state: new this.ort.Tensor('float32', this.state, [2, 1, 128]),
        sr: new this.ort.Tensor('int64', BigInt64Array.from([BigInt(SILERO_SAMPLE_RATE)]), [1]),
      };
      const outputs = await this.session.run(feeds);
      const probability = outputs['output']?.data as Float32Array | undefined;
      const nextState = outputs['stateN']?.data as Float32Array | undefined;
      if (probability && probability.length > 0) this.latest = probability[0] ?? 0;
      // Length-checked: a differently shaped stateN would otherwise grow the
      // array every step and the model would start rejecting its own input.
      if (nextState && nextState.length === STATE_LENGTH) this.state = Float32Array.from(nextState);
      this.failures = 0;
    } catch {
      /*
       * A failed inference must not silently freeze the gate at its last
       * verdict — held at 1.0 that would open segments forever, held at 0 it
       * would deafen the call. Fall back to "no opinion" so the caller's own
       * energy gate decides.
       */
      this.failures += 1;
      this.latest = 0;
    } finally {
      this.inFlight = false;
    }
  }

  /** Consecutive inference failures, for a health surface to report. */
  get failureCount(): number {
    return this.failures;
  }
}
