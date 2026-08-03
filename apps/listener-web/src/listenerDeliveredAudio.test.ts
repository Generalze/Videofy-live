import { describe, expect, it } from 'vitest';
import {
  applyDeliveredGeneratedAudioOutput,
  DELIVERED_GENERATED_AUDIO_SELECTOR,
} from './listenerDeliveredAudio';

describe('delivered generated audio controls', () => {
  it('applies translated volume and mute to visible generated audio players', () => {
    const first = { muted: false, volume: 1 } as HTMLAudioElement;
    const second = { muted: false, volume: 1 } as HTMLAudioElement;
    const unrelated = { muted: false, volume: 1 } as HTMLAudioElement;
    const root = {
      querySelectorAll: (selector: string) =>
        selector === DELIVERED_GENERATED_AUDIO_SELECTOR ? [first, second] : [],
    } as unknown as ParentNode;

    applyDeliveredGeneratedAudioOutput(root, 0.35, false);

    expect(first.volume).toBe(0.35);
    expect(second.volume).toBe(0.35);
    expect(unrelated.volume).toBe(1);

    applyDeliveredGeneratedAudioOutput(root, 0.9, true);

    expect(first.volume).toBe(0);
    expect(second.volume).toBe(0);
    expect(first.muted).toBe(true);
    expect(second.muted).toBe(true);
  });
});
