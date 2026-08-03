export const DELIVERED_GENERATED_AUDIO_SELECTOR = '[data-delivered-generated-audio="true"]';

export function applyDeliveredGeneratedAudioOutput(
  root: ParentNode,
  volume: number,
  muted: boolean,
): void {
  const effectiveVolume = muted ? 0 : clampVolume(volume);
  root
    .querySelectorAll<HTMLAudioElement>(DELIVERED_GENERATED_AUDIO_SELECTOR)
    .forEach((audio) => {
      audio.volume = effectiveVolume;
      audio.muted = muted;
    });
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
