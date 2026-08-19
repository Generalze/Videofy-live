// owner: masterzee001
/**
 * The lobby camera mirror: acquiring is polite, releasing is mandatory.
 */
import { describe, expect, it, vi } from 'vitest';
import { createCameraPreview, type PreviewMediaDevices } from '../cameraPreview';

interface FakeTrack {
  stop: ReturnType<typeof vi.fn>;
}

function fakeStream(): { stream: MediaStream; tracks: FakeTrack[] } {
  const tracks: FakeTrack[] = [{ stop: vi.fn() }, { stop: vi.fn() }];
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  return { stream, tracks };
}

function fakeDevices(streams: Array<ReturnType<typeof fakeStream>>): PreviewMediaDevices {
  let index = 0;
  return {
    getUserMedia: vi.fn(async (constraints: MediaStreamConstraints) => {
      expect(constraints).toEqual({ video: true, audio: false });
      const next = streams[index] ?? streams[streams.length - 1];
      index += 1;
      if (next === undefined) throw new Error('no stream');
      return next.stream;
    }),
  };
}

describe('createCameraPreview', () => {
  it('acquires a video-only stream and releases every track on stop', async () => {
    const first = fakeStream();
    const preview = createCameraPreview(fakeDevices([first]));
    await preview.start();
    expect(preview.current()).toBe(first.stream);
    preview.stop();
    for (const track of first.tracks) expect(track.stop).toHaveBeenCalledTimes(1);
    expect(preview.current()).toBeNull();
  });

  it('never leaks the previous stream when started twice', async () => {
    const first = fakeStream();
    const second = fakeStream();
    const preview = createCameraPreview(fakeDevices([first, second]));
    await preview.start();
    await preview.start();
    for (const track of first.tracks) expect(track.stop).toHaveBeenCalledTimes(1);
    expect(preview.current()).toBe(second.stream);
  });

  it('stop is safe to call repeatedly and before start', () => {
    const preview = createCameraPreview(fakeDevices([fakeStream()]));
    preview.stop();
    preview.stop();
    expect(preview.current()).toBeNull();
  });

  it('degrades honestly when the browser has no media devices', async () => {
    const preview = createCameraPreview(undefined);
    expect(preview.supported()).toBe(false);
    await expect(preview.start()).rejects.toThrow('cannot show a camera preview');
  });
});
