/** @author masterzee001 */
/**
 * An UPLOADED programme speaks with the chosen voice, through the APPROVED vendor.
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
 *   1. an uploaded segment reaches the APPROVED Nigerian vendor, at the exact
 *      voice the session chose
 *   2. no audio is a FAILURE, never a small file
 *
 * They drive the real `buildLiveSynthesis` and the real batch factory, with
 * `fetch` injected at the outermost edge. Nothing here re-implements routing or
 * voice resolution: a test that declares its own table proves the table.
 *
 * WHAT THE 2026-09-18 RULING CHANGED HERE, AND WHAT IT DID NOT. The approved
 * vendor is now ElevenLabs rather than 9jaLingo, so the URL and the voice ids
 * differ. The claim does not: the voice a session chose must survive every join
 * between the upload and the vendor, and an uploaded Nigerian segment must
 * never be spoken by the general fallback.
 *
 * ONE PRODUCT CONSEQUENCE IS DELIBERATELY NOT HIDDEN HERE. 9jaLingo had a
 * DISTINCT chosen speaker per language -- yo, ig and ha were three different
 * people. ElevenLabs voices are multilingual, so unless a deployment maps a
 * separate voice per language in ELEVENLABS_VOICE_IDS, those three now share
 * one. That is a decision for whoever chose the voices by ear, not something a
 * test should quietly assert either way.
 */
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildLiveSynthesis } from '../live-provider-wiring.js';
import { createTextToSpeechProvider } from '../text-to-speech-provider.js';
import type { TextToSpeechProviderInput } from '../text-to-speech-provider.js';

/** 0.25 s of raw 16 kHz mono PCM16: what the approved vendor actually returns. */
function vendorPcm(samples = 4_000): Buffer {
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) b.writeInt16LE(((i % 200) - 100) * 120, i * 2);
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
    return new Response(new Uint8Array(vendorPcm()), {
      status: 200,
      headers: { 'content-type': 'audio/pcm' },
    });
  }) as unknown as typeof fetch;

  const live = buildLiveSynthesis(
    { streamingSynthesisProvider: 'chain' },
    {
      /*
       * AZURE IS CONFIGURED ON PURPOSE, exactly as it is in production. It is
       * the vendor the ruling refuses for these languages, and a Nigerian
       * segment reaching `azure` below would be the defect this file exists to
       * catch -- not a gap in the fixture.
       */
      azureSpeechKey: 'test-key-not-a-real-credential',
      azureSpeechRegion: 'westeurope',
      azureDefaultVoiceId: 'en-NG-EzinneNeural',
      elevenLabsApiKey: 'test-key-not-a-real-credential',
      elevenLabsVoiceId: 'el-default-voice',
      // Platform voice -> vendor voice. The mapping the session's choice has to
      // survive; without it every participant shares one voice.
      elevenLabsVoiceIds: 'yo:female=el-yoruba-female,yo:male=el-yoruba-male',
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

  /** Only synthesis requests: the approved vendor carries its text in the body. */
  const speechCalls = (): Sent[] => sent.filter((call) => 'text' in call.body);
  return { speak, speechCalls, sent };
}

describe('an uploaded programme uses the chosen voices', () => {
  it('sends Yoruba to the APPROVED vendor, never to the one the ruling refuses', async () => {
    const h = await harness();
    await h.speak('yo');

    const call = h.speechCalls().at(-1);
    expect(call?.url).toContain('api.elevenlabs.io');
    // The defect this replaces, exactly: on the live box this segment resolved
    // to `azure-speech:tts-northeurope` while every test was green.
    expect(h.sent.map((c) => c.url).join(' ')).not.toMatch(/azure|microsoft/iu);
  });

  it('carries the chosen voice all the way to the vendor', async () => {
    /*
     * The preference is computed correctly at every step and has been discarded
     * at this boundary before: the vendor voice lives in the URL, so a mapping
     * that silently misses sends every participant the same default.
     */
    const h = await harness();
    await h.speak('yo', 'yo:male');

    const call = h.speechCalls().at(-1);
    expect(call?.url).toContain('el-yoruba-male');
    expect(call?.url).not.toContain('el-yoruba-female');
    expect(call?.url).not.toContain('el-default-voice');
  });

  it('sends Igbo and Hausa to the approved vendor too, not just Yoruba', async () => {
    // All four routed languages, or the route is a Yoruba special case that
    // happens to be named after a region.
    const h = await harness();
    await h.speak('ig');
    const igbo = h.speechCalls().at(-1);
    await h.speak('ha');
    const hausa = h.speechCalls().at(-1);

    expect(igbo?.url).toContain('api.elevenlabs.io');
    expect(hausa?.url).toContain('api.elevenlabs.io');
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
