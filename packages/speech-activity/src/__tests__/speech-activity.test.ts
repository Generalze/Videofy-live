/** @author masterzee001 */
/**
 * Pins for the shared speech judgement. These are the fabrications the
 * measurements were taken to prevent.
 */
import { describe, expect, it } from 'vitest';
import {
  SPEECH_DEFAULTS,
  SPEECH_SAMPLE_RATE,
  SpeechActivityGate,
  VAD_MIN_VOICED_FRACTION,
  frameEnergy,
} from '../index.js';

const FRAME = 320; // 20 ms at 16 kHz
const FRAME_MS = 20;

function voicedFrame(): Int16Array {
  // Well above the 0.012 RMS gate.
  const samples = new Int16Array(FRAME);
  for (let i = 0; i < FRAME; i += 1) samples[i] = i % 2 === 0 ? 6000 : -6000;
  return samples;
}

function quietFrame(): Int16Array {
  return new Int16Array(FRAME);
}

function drive(
  gate: SpeechActivityGate,
  pattern: readonly ('v' | 'q')[],
  startMs = 1000,
): ReturnType<SpeechActivityGate['push']> {
  const events: ReturnType<SpeechActivityGate['push']> = [];
  pattern.forEach((token, index) => {
    events.push(...gate.push(token === 'v' ? voicedFrame() : quietFrame(), startMs + index * FRAME_MS));
  });
  return events;
}

describe('energy is measured, not guessed', () => {
  it('silence is zero and a loud frame is well above the gate', () => {
    expect(frameEnergy(new Int16Array(FRAME))).toBe(0);
    expect(frameEnergy(voicedFrame())).toBeGreaterThan(SPEECH_DEFAULTS.speechThreshold);
    expect(frameEnergy(new Int16Array(0))).toBe(0);
  });

  it('PIN: a single click DOES cross the per-frame gate, and that is expected', () => {
    const click = new Int16Array(FRAME);
    click[0] = 32_000;
    // Worth stating plainly, because it is tempting to believe otherwise: one
    // full-scale sample in a 20 ms frame gives an RMS of about 0.055, well
    // over the 0.012 gate. The per-frame energy test is NOT what rejects a
    // door closing -- the voiced-fraction and minimum-duration rules are, and
    // the next test is the one that proves it. Tightening this threshold to
    // catch clicks would take quiet speech with it.
    expect(frameEnergy(click)).toBeGreaterThan(SPEECH_DEFAULTS.speechThreshold);
  });

  it('PIN: a click is rejected by duration and fraction, not by energy', () => {
    const gate = new SpeechActivityGate({ endSilenceMs: 200, minSpeechMs: 150 });
    const click = new Int16Array(FRAME);
    click[0] = 32_000;
    const events = [...gate.push(click, 1000)];
    for (let i = 1; i <= 20; i += 1) events.push(...gate.push(quietFrame(), 1000 + i * FRAME_MS));
    // It opens an utterance -- and then never becomes one.
    expect(events.map((e) => e.kind)).toEqual(['speech-start', 'too-quiet-to-be-speech']);
  });
});

describe('speech boundaries land on the platform clock', () => {
  it('PIN: speech starts at the frame that crossed the gate', () => {
    const gate = new SpeechActivityGate();
    const events = drive(gate, ['q', 'q', 'v'], 5000);
    expect(events).toEqual([{ kind: 'speech-start', platformTimestampMs: 5040 }]);
    expect(gate.isSpeaking).toBe(true);
  });

  it('PIN: speech ends only after the full end-silence, not the first quiet frame', () => {
    const gate = new SpeechActivityGate({ endSilenceMs: 100, minSpeechMs: 40 });
    const events = drive(gate, ['v', 'v', 'v', 'q', 'q']);
    // A pause between words is not the end of a sentence.
    expect(events.filter((e) => e.kind === 'speech-end')).toHaveLength(0);

    const more = drive(gate, ['q', 'q', 'q'], 2000);
    expect(more.map((e) => e.kind)).toEqual(['speech-end']);
  });

  it('PIN: a pause inside speech never counts as voice', () => {
    // 500 ms of quiet plus two blips once satisfied a 500 ms speech minimum,
    // because silence was promoted into the voiced counter. An eight-second
    // near-silent stretch then reached the recogniser, which answered it with
    // the highest-prior sentence it knew.
    const gate = new SpeechActivityGate({ endSilenceMs: 200, minSpeechMs: 300 });
    const pattern: ('v' | 'q')[] = ['v'];
    for (let i = 0; i < 25; i += 1) pattern.push('q');
    const events = drive(gate, pattern);
    expect(events.map((e) => e.kind)).toEqual(['speech-start', 'too-quiet-to-be-speech']);
  });

  it('PIN: too-quiet is not a speech-end, because there was no speech to end', () => {
    const gate = new SpeechActivityGate({ endSilenceMs: 400, minSpeechMs: 150 });
    const pattern: ('v' | 'q')[] = ['v'];
    for (let i = 0; i < 24; i += 1) pattern.push('q'); // 20 ms voiced in 500 ms
    const events = drive(gate, pattern);
    const quiet = events.find((e) => e.kind === 'too-quiet-to-be-speech');
    expect(quiet).toBeDefined();
    // Reporting an end would open and close a segment around a creaking chair.
    expect(events.some((e) => e.kind === 'speech-end')).toBe(false);
    if (quiet?.kind === 'too-quiet-to-be-speech') {
      expect(quiet.voicedFraction).toBeLessThan(VAD_MIN_VOICED_FRACTION);
    }
  });

  it('PIN: a speaker who never pauses still produces a boundary', () => {
    const gate = new SpeechActivityGate({ maxSegmentMs: 100, endSilenceMs: 10_000, minSpeechMs: 40 });
    const events = drive(gate, ['v', 'v', 'v', 'v', 'v', 'q']);
    const end = events.find((e) => e.kind === 'speech-end');
    expect(end?.kind === 'speech-end' && end.reason).toBe('max-duration');
  });

  it('PIN: a short real word survives the fraction test', () => {
    // "Non." was measured at 29% voiced in about a second. A rule that dropped
    // it would be a rule that removes one-word answers from the product.
    const gate = new SpeechActivityGate({ endSilenceMs: 200, minSpeechMs: 150 });
    const pattern: ('v' | 'q')[] = [];
    for (let i = 0; i < 15; i += 1) pattern.push('v'); // 300 ms voiced
    for (let i = 0; i < 12; i += 1) pattern.push('q'); // 240 ms of quiet
    const events = drive(gate, pattern);
    expect(events.map((e) => e.kind)).toEqual(['speech-start', 'speech-end']);
  });
});

describe('a stream that stops mid-utterance', () => {
  it('finishing reports a boundary when somebody was genuinely talking', () => {
    const gate = new SpeechActivityGate({ minSpeechMs: 40 });
    drive(gate, ['v', 'v', 'v']);
    expect(gate.finish(9000).map((e) => e.kind)).toEqual(['speech-end']);
  });

  it('PIN: finishing mid-tap does not manufacture an utterance', () => {
    const gate = new SpeechActivityGate({ minSpeechMs: 500 });
    drive(gate, ['v']);
    expect(gate.finish(9000).map((e) => e.kind)).toEqual(['too-quiet-to-be-speech']);
  });

  it('finishing when nothing was open reports nothing', () => {
    expect(new SpeechActivityGate().finish(1)).toEqual([]);
  });

  it('reset abandons an open utterance without claiming it ended', () => {
    const gate = new SpeechActivityGate({ minSpeechMs: 40 });
    drive(gate, ['v', 'v', 'v']);
    gate.reset();
    // Audio was lost; whatever was open cannot be continued across the hole,
    // and it certainly did not finish.
    expect(gate.isSpeaking).toBe(false);
    expect(gate.finish(9000)).toEqual([]);
  });

  it('the sample rate is the engine rate', () => {
    expect(SPEECH_SAMPLE_RATE).toBe(16000);
  });
});
