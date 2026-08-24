/**
 * Telling a voice from a door.
 *
 * The gate used to be pure RMS energy, so anything loud enough opened a
 * segment: a cough, a keyboard, a chair, room noise. The recogniser downstream,
 * handed noise, returns WORDS for it -- which is how a call ends up with
 * sentences nobody said. These tests use synthetic signals with known
 * character rather than assertions about intent.
 */
import { describe, expect, it } from 'vitest';
import {
  SPEECH_SAMPLE_RATE,
  SpeechActivityGate,
  VOICING_THRESHOLD,
  frameEnergy,
  voicingStrength,
} from './index';

const FRAME = 480; // 30 ms at 16 kHz

/** Deterministic pseudo-noise: broadband, aperiodic, loud. A room, a fan, a hiss. */
function noise(amplitude = 8000): Int16Array {
  const out = new Int16Array(FRAME);
  let seed = 12345;
  for (let i = 0; i < FRAME; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = Math.round(((seed / 0x7fffffff) * 2 - 1) * amplitude);
  }
  return out;
}

/** A glottal-ish pulse train at 120 Hz with harmonics: what a vowel looks like. */
function voice(amplitude = 8000): Int16Array {
  const out = new Int16Array(FRAME);
  const f0 = 120;
  for (let i = 0; i < FRAME; i += 1) {
    const t = i / SPEECH_SAMPLE_RATE;
    const value =
      Math.sin(2 * Math.PI * f0 * t) +
      0.5 * Math.sin(2 * Math.PI * f0 * 2 * t) +
      0.33 * Math.sin(2 * Math.PI * f0 * 3 * t);
    out[i] = Math.round((value / 1.83) * amplitude);
  }
  return out;
}

/** A single sharp transient: a key press, a door, a tap on the desk. */
function click(amplitude = 20000): Int16Array {
  const out = new Int16Array(FRAME);
  for (let i = 0; i < 40; i += 1) {
    out[i] = Math.round(amplitude * Math.exp(-i / 6) * (i % 2 === 0 ? 1 : -1));
  }
  return out;
}

describe('voicingStrength', () => {
  it('PIN: rates a voice ABOVE the threshold', () => {
    expect(voicingStrength(voice())).toBeGreaterThan(VOICING_THRESHOLD);
  });

  it('PIN: rates broadband noise BELOW the threshold, however loud', () => {
    // The failure this exists to stop: noise is loud, so an energy gate opens
    // for it, and the recogniser invents words to fill the segment.
    expect(frameEnergy(noise(12000))).toBeGreaterThan(0.012);
    expect(voicingStrength(noise(12000))).toBeLessThan(VOICING_THRESHOLD);
  });

  it('PIN: rates a click BELOW the threshold, however loud', () => {
    expect(frameEnergy(click())).toBeGreaterThan(0.012);
    expect(voicingStrength(click())).toBeLessThan(VOICING_THRESHOLD);
  });

  it('is a measure of periodicity, not loudness', () => {
    // Same signal, quarter the amplitude: the answer must barely move.
    const loud = voicingStrength(voice(16000));
    const quiet = voicingStrength(voice(4000));
    expect(Math.abs(loud - quiet)).toBeLessThan(0.1);
  });

  it('answers zero for silence rather than dividing by it', () => {
    expect(voicingStrength(new Int16Array(FRAME))).toBe(0);
  });
});

describe('SpeechActivityGate with voicing', () => {
  function feed(gate: SpeechActivityGate, frame: Int16Array, count: number) {
    const events = [];
    for (let i = 0; i < count; i += 1) {
      events.push(...gate.push(frame, i * 30));
    }
    return events;
  }

  it('opens for a voice', () => {
    const gate = new SpeechActivityGate();
    const events = feed(gate, voice(), 10);
    expect(events.some((e) => e.kind === 'speech-start')).toBe(true);
  });

  it('PIN: does NOT open for sustained loud noise', () => {
    // Ten frames of it -- a fan, a road, a busy room. The old gate opened on
    // the first one.
    const gate = new SpeechActivityGate();
    const events = feed(gate, noise(12000), 10);
    expect(events.some((e) => e.kind === 'speech-start')).toBe(false);
  });

  it('PIN: does NOT open for a burst of key presses', () => {
    const gate = new SpeechActivityGate();
    const events = feed(gate, click(), 10);
    expect(events.some((e) => e.kind === 'speech-start')).toBe(false);
  });

  it('PIN: voicingThreshold 0 restores the previous energy-only behaviour', () => {
    // A deployment that needs exactly what it had before can still have it.
    const gate = new SpeechActivityGate({ voicingThreshold: 0 });
    const events = feed(gate, noise(12000), 10);
    expect(events.some((e) => e.kind === 'speech-start')).toBe(true);
  });
});

/**
 * The gate with a learned detector.
 *
 * Silero itself is exercised against real audio by
 * scripts/check-silero.mjs; these pin how the GATE uses whatever detector it
 * is given, without loading a 2 MB model into a unit test.
 */
describe('SpeechActivityGate with a learned detector', () => {
  function detectorAt(probability: number) {
    return { push: () => {}, probability, reset: () => {} };
  }

  const loudVoice = voice(12000);

  it('PIN: the detector can veto audio the energy gate would have passed', () => {
    // Music, a tone, a television in the room: loud, periodic, not speech.
    const gate = new SpeechActivityGate({ detector: detectorAt(0.02) });
    const events = [];
    for (let i = 0; i < 10; i += 1) events.push(...gate.push(loudVoice, i * 30));
    expect(events.some((e) => e.kind === 'speech-start')).toBe(false);
  });

  it('opens when the detector is confident and the audio is loud enough', () => {
    const gate = new SpeechActivityGate({ detector: detectorAt(0.97) });
    const events = [];
    for (let i = 0; i < 10; i += 1) events.push(...gate.push(loudVoice, i * 30));
    expect(events.some((e) => e.kind === 'speech-start')).toBe(true);
  });

  it('PIN: still requires energy, so leakage from another room is not speech', () => {
    // Silero scores speech, not level. A neighbouring conversation bleeding
    // into the mic can score highly while being nobody in THIS call talking.
    const gate = new SpeechActivityGate({ detector: detectorAt(0.99) });
    const events = [];
    for (let i = 0; i < 10; i += 1) events.push(...gate.push(voice(60), i * 30));
    expect(events.some((e) => e.kind === 'speech-start')).toBe(false);
  });

  it('builds its OWN detector from a factory, so streams never share state', () => {
    // Silero carries recurrent state per conversation; one instance shared
    // across concurrent speakers judges each against the other's audio.
    const built: number[] = [];
    const gateA = new SpeechActivityGate({
      createDetector: () => {
        built.push(1);
        return detectorAt(0.9);
      },
    });
    const gateB = new SpeechActivityGate({
      createDetector: () => {
        built.push(1);
        return detectorAt(0.9);
      },
    });
    void gateA;
    void gateB;
    expect(built).toHaveLength(2);
  });
});
