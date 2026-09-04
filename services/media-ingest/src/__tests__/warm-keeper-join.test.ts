/** @author masterzee001 */
/**
 * The warm-keeper is actually CONNECTED to the specialist.
 *
 * `warm-keeper.test.ts` proves the keeper works. This proves somebody calls it,
 * which is a different claim and was the false one: `createWarmKeeper` was
 * written on 2026-08-30 for the vendor's scale-to-zero problem and, until
 * today, **nothing in the service imported it**. It was correct, tested, and
 * unreachable.
 *
 * The cost of that gap, measured 31 Aug 2026: a programme was uploaded to
 * staging and all twelve segments -- ha, ig and yo -- were spoken by the
 * fallback vendor. `GET /v1/health` said `engine_ready: false`; synthesis
 * answered 503 "capacity is starting after an idle period". The routing was
 * right, the degraded labelling was right, the audio was real. The specialist
 * was asleep.
 *
 * So these assertions are about the JOIN and nothing else: does building the
 * live stack produce warm-up traffic on a timer, and does it stop when nobody
 * is using it. Related lesson: [[unwired-seam-tally]].
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildLiveSynthesis } from '../live-provider-wiring.js';

interface Probe {
  readonly warmUps: () => number;
  readonly synthesize: (language: string) => Promise<unknown>;
}

/** A 0.1 s WAV, so a synthesis attempt succeeds and counts as real demand. */
function wav(samples = 2_205): Buffer {
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
  return b;
}

function build(alwaysOn: boolean, intervalMs = 1_000): Probe {
  /*
   * EVERY vendor request, not "requests that look like a warm-up". The warm-up
   * sends `voiceId: 'voice_warmup'`, but the adapter resolves that to a real
   * speaker id before it goes out, so it is indistinguishable on the wire --
   * which is correct behaviour and makes counting by shape wrong. In these
   * tests the only other traffic is the synthesis each case performs itself,
   * so the DELTA after that point is warm-up traffic and nothing else.
   */
  let calls = 0;
  const fetchImpl = (async (_url: unknown, _init: unknown) => {
    calls += 1;
    return new Response(new Uint8Array(wav()), {
      status: 200,
      headers: { 'content-type': 'audio/wav' },
    });
  }) as unknown as typeof fetch;

  const live = buildLiveSynthesis(
    { streamingSynthesisProvider: 'chain' },
    {
      naijaLingoApiKey: 'test-key-not-a-real-credential',
      naijaLingoBaseUrl: 'https://vendor.invalid',
      naijaLingoWarmAlwaysOn: alwaysOn ? 'true' : 'false',
      naijaLingoWarmIntervalMs: String(intervalMs),
      naijaLingoWarmIdleAfterMs: '5000',
      azureSpeechKey: 'test-key-not-a-real-credential',
      azureSpeechRegion: 'westeurope',
      azureDefaultVoiceId: 'en-NG-EzinneNeural',
      elevenLabsApiKey: 'test-key-not-a-real-credential',
      elevenLabsVoiceId: 'test-voice',
    },
    fetchImpl,
  );
  const provider = live.provider;
  if (provider === null) throw new Error('the chain must build');

  return {
    warmUps: () => calls,
    synthesize: (language) =>
      provider.synthesize({
        text: 'Bawo ni.',
        targetLanguage: language,
        voiceId: 'standard',
        onChunk: () => {},
        onError: () => {},
      }),
  };
}

describe('the warm-keeper is joined to the specialist', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps pinging on a timer when a deployment asks to always be warm', async () => {
    vi.useFakeTimers();
    const probe = build(true, 1_000);
    const atBoot = probe.warmUps();

    await vi.advanceTimersByTimeAsync(3_500);

    // The assertion that would have failed yesterday: nothing imported the
    // keeper, so no amount of elapsed time produced a single ping.
    expect(probe.warmUps()).toBeGreaterThan(atBoot);
  });

  it('does not ping forever when nobody is using it', async () => {
    // Always-warm has a real bill. Off by default means off, not quieter.
    vi.useFakeTimers();
    const probe = build(false, 1_000);

    await vi.advanceTimersByTimeAsync(20_000);
    const idle = probe.warmUps();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(probe.warmUps()).toBe(idle);
  });

  it('starts keeping warm once the specialist is actually used', async () => {
    vi.useFakeTimers();
    const probe = build(false, 1_000);
    await probe.synthesize('yo');
    const afterUse = probe.warmUps();

    await vi.advanceTimersByTimeAsync(3_500);

    expect(probe.warmUps()).toBeGreaterThan(afterUse);
  });
});
