/** @owner masterzee001 */
import { describe, expect, it } from 'vitest';
import {
  containerExtension,
  declaredTypeMatches,
  detectAudioContainer,
} from '../audio-container.js';

function bytes(...values: (number | string)[]): Uint8Array {
  const flat: number[] = [];
  for (const value of values) {
    if (typeof value === 'number') flat.push(value);
    else for (const char of value) flat.push(char.charCodeAt(0));
  }
  return new Uint8Array(flat);
}

const WEBM = bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00);
const OGG = bytes('OggS', 0x00, 0x02, 0x00, 0x00);
const WAV = bytes('RIFF', 0x24, 0x00, 0x00, 0x00, 'WAVE');
const MP4 = bytes(0x00, 0x00, 0x00, 0x20, 'ftypM4A ');
const MP3 = bytes('ID3', 0x03, 0x00, 0x00, 0x00);

describe('detectAudioContainer', () => {
  it('identifies what the browser actually sends', () => {
    // MediaRecorder in Chrome and Edge produces WebM/Opus, which is why the
    // previous `.wav` suffix was a lie waiting to mislead a decoder.
    expect(detectAudioContainer(WEBM)).toBe('webm');
    expect(detectAudioContainer(OGG)).toBe('ogg');
  });

  it('identifies the formats an engine might be handed instead', () => {
    expect(detectAudioContainer(WAV)).toBe('wav');
    expect(detectAudioContainer(MP4)).toBe('mp4');
    expect(detectAudioContainer(MP3)).toBe('mp3');
  });

  it('admits when it does not know rather than guessing', () => {
    // A confident wrong format name sends a decoder down the wrong path, which
    // is harder to diagnose than an honest refusal.
    expect(detectAudioContainer(bytes('not audio at all'))).toBe('unknown');
    expect(detectAudioContainer(new Uint8Array(0))).toBe('unknown');
    expect(detectAudioContainer(bytes(0x1a, 0x45))).toBe('unknown');
  });

  it('does not mistake a RIFF container that is not WAVE', () => {
    expect(detectAudioContainer(bytes('RIFF', 0, 0, 0, 0, 'AVI '))).toBe('unknown');
  });
});

describe('containerExtension', () => {
  it('names the file after what is in it', () => {
    expect(containerExtension('webm')).toBe('webm');
    expect(containerExtension('mp4')).toBe('m4a');
  });

  it('refuses to invent a format for unknown bytes', () => {
    // `.bin` is honest. `.wav` would be the exact bug this module exists for.
    expect(containerExtension('unknown')).toBe('bin');
  });
});

describe('declaredTypeMatches', () => {
  it('accepts a header that agrees with the bytes', () => {
    expect(declaredTypeMatches('audio/webm;codecs=opus', 'webm')).toBe(true);
    expect(declaredTypeMatches('audio/ogg', 'ogg')).toBe(true);
  });

  it('rejects a header that disagrees with the bytes', () => {
    // Announcing audio/wav while sending WebM is either confusion or probing,
    // and neither earns the filename it asked for.
    expect(declaredTypeMatches('audio/wav', 'webm')).toBe(false);
  });

  it('rejects anything when the container could not be identified', () => {
    expect(declaredTypeMatches('audio/wav', 'unknown')).toBe(false);
  });
});
