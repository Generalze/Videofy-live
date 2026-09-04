/** @author masterzee001 */
/**
 * An UPLOADED programme speaks with the founder's chosen voices.
 *
 * WHAT WENT WRONG, 31 Aug 2026. A real programme was uploaded to staging and
 * came back with no translated audio. The pipeline had logged "Generated audio
 * ready" for all eight segments; on disk each one was 44 bytes -- a WAV header
 * with a zero-length data chunk, written by the batch path's `mock` provider
 * and reported with `providerLatencyMs: 0` as a success. The Nigerian
 * specialist, the fallback chain and the chosen voices all lived on the LIVE
 * synthesis stack, which the batch path never touched.
 *
 * So these tests do not check that a Yoruba request "works". They check the
 * two specific things that were false while every signal said fine:
 *
 *   1. an uploaded segment reaches 9jaLingo, at the exact chosen SPEAKER ID
 *   2. no audio is a FAILURE, never a small file
 *
 * They drive the real `buildLiveSynthesis` and the real batch factory, with
 * `fetch` injected at the outermost edge. Nothing here re-implements routing or
 * voice resolution: a test that declares its own table proves the table.
 */
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLiveSynthesis } from '../live-provider-wiring.js';
import { createTextToSpeechProvider } from '../text-to-speech-provider.js';
import { NAIJALINGO_SELECTED_VOICE_IDS } from '../providers/naijalingo/streaming-tts.js';
import type { TextToSpeechProviderInput } from '../text-to-speech-provider.js';

/** A 0.25 s 22.05 kHz mono 16-bit WAV: what the vendor actually returns. */
function vendorWav(samples = 5_512): Buffer {
  const data = samples * 2;
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(22_050, 24);
  b.writeUInt32LE(44_100, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(data, 40);
  for (let i = 0; i < samples; i += 1) b.writeInt16LE(((i % 200) - 100) * 120, 44 + i * 2);
  return b;
}

interface Sent {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/**
 * The whole stack a deployment boots, with only `fetch` replaced.
 *
 * `speak` is a full round trip: live wiring, specialist routing, batch factory,
 * file on disk. If any join in that chain is missing, it throws.
 */
async function harness(options: { readonly vendorStatus?: number } = {}) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    const request = init as { body?: string };
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
    } catch {
      body = {};
    }
    sent.push({ url: String(url), body });
    const status = options.vendorStatus ?? 200;
    if (status !== 200) {
      return new Response('upstream unavailable', { status });
    }
    return new Response(new Uint8Array(vendorWav()), {
      status: 200,
      headers: { 'content-type': 'audio/wav' },
    });
  }) as unknown as typeof fetch;

  const live = buildLiveSynthesis(
    { streamingSynthesisProvider: 'chain' },
    {
      naijaLingoApiKey: 'test-key-not-a-real-credential',
      naijaLingoBaseUrl: 'https://vendor.invalid',
      azureSpeechKey: 'test-key-not-a-real-credential',
      azureSpeechRegion: 'westeurope',
      azureDefaultVoiceId: 'en-NG-EzinneNeural',
      // The chain's general member. Present so the chain builds; the
      // assertions below are about which vendor gets the Nigerian languages,
      // and reaching this one for `yo` would be the defect, not the fixture.
      elevenLabsApiKey: 'test-key-not-a-real-credential',
      elevenLabsVoiceId: 'test-voice',
    },
    fetchImpl,
  );
  const streaming = live.provider;
  if (streaming === null) {
    throw new Error('the chain must build; without it the batch path has nothing to speak with');
  }

  const batch = createTextToSpeechProvider({
    providerName: 'streaming',
    streaming,
    timeoutMs: 30_000,
    supportedLanguages: ['yo', 'ig', 'ha'],
    defaultVoiceId: 'standard',
    piper: { executable: 'piper', voices: [], timeoutMs: 30_000 },
  });

  const dir = await mkdtemp(join(tmpdir(), 'c7-batch-tts-'));
  let n = 0;

  async function speak(targetLanguage: string, voiceId = 'standard'): Promise<string> {
    n += 1;
    const outputPath = join(dir, `seg-${n}.wav`);
    const input: TextToSpeechProviderInput = {
      sessionId: 'ps_1',
      streamId: 'st_1',
      segmentId: `seg-${n}`,
      sequence: n,
      targetLanguage,
      translatedText: 'E ku aaro, e ku ile.',
      startMs: 0,
      endMs: 2_000,
      voiceId,
      outputPath,
    };
    await batch.generate(input);
    return outputPath;
  }

  /** Only requests that carry a `voice`: the vendor warm-up also fires. */
  const speechCalls = (): Sent[] => sent.filter((call) => 'voice' in call.body);
  return { speak, speechCalls, sent };
}

describe('an uploaded programme uses the chosen voices', () => {
  it('sends Yoruba to 9jaLingo at the exact chosen speaker id', async () => {
    const h = await harness();
    await h.speak('yo');

    const call = h.speechCalls().at(-1);
    expect(call?.url).toContain('vendor.invalid');
    // The literal chosen id, not "a Yoruba voice". A vendor default that
    // happens to be Yoruba would pass a looser assertion and be the wrong
    // person speaking.
    expect(call?.body['voice']).toBe(NAIJALINGO_SELECTED_VOICE_IDS['yo:female']);
    expect(call?.body['lang']).toBe('yo');
  });

  it('sends Igbo and Hausa to their own chosen speakers, not one shared voice', async () => {
    const h = await harness();
    await h.speak('ig');
    const igbo = h.speechCalls().at(-1);
    await h.speak('ha');
    const hausa = h.speechCalls().at(-1);

    expect(igbo?.body['voice']).toBe(NAIJALINGO_SELECTED_VOICE_IDS['ig:female']);
    expect(hausa?.body['voice']).toBe(NAIJALINGO_SELECTED_VOICE_IDS['ha:female']);
    expect(igbo?.body['voice']).not.toBe(hausa?.body['voice']);
  });

  it('reaches the chosen MALE voice when the session asked for one', async () => {
    // Both halves of every pair were chosen by ear. A session carries its
    // preference as `<language>:<gender>` through voiceIdsByLanguage, and this
    // is the assertion that the preference survives the whole chain.
    const h = await harness();
    await h.speak('yo', 'yo:male');

    const call = h.speechCalls().at(-1);
    expect(call?.body['voice']).toBe(NAIJALINGO_SELECTED_VOICE_IDS['yo:male']);
    expect(call?.body['voice']).not.toBe(NAIJALINGO_SELECTED_VOICE_IDS['yo:female']);
  });

  it('writes real audio, not the 44-byte header that shipped', async () => {
    const h = await harness();
    const path = await h.speak('yo');

    const { size } = await stat(path);
    expect(size).toBeGreaterThan(1_000);

    const wav = await readFile(path);
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    // The header must agree with the payload: a declared length that does not
    // match plays for a moment and stops, which reads as a synthesis fault.
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44);
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.readUInt32LE(24)).toBe(16_000);
  });

  it('fails loudly when synthesis produces nothing', async () => {
    // The defect in one line. Every downstream signal reads a written file as
    // audio, so "no samples" has to stop here or it becomes silence in front
    // of an audience.
    const h = await harness({ vendorStatus: 503 });
    await expect(h.speak('yo')).rejects.toMatchObject({ code: 'tts-empty-output' });
  });
});
