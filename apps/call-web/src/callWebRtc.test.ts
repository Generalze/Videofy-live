import { describe, expect, it } from 'vitest';
import { stopMediaStreamTracks, type StoppableMediaStream } from './callWebRtc';

function fakeStream(trackCount: number, options: { throwAt?: number } = {}) {
  const stopped: number[] = [];
  const stream: StoppableMediaStream = {
    getTracks: () =>
      Array.from({ length: trackCount }, (_, index) => ({
        stop: () => {
          if (index === options.throwAt) {
            throw new Error('already stopped');
          }
          stopped.push(index);
        },
      })),
  };
  return { stream, stopped };
}

describe('stopMediaStreamTracks', () => {
  it('stops every track on the stream', () => {
    const { stream, stopped } = fakeStream(3);

    stopMediaStreamTracks(stream);

    expect(stopped).toEqual([0, 1, 2]);
  });

  it('tolerates a missing stream', () => {
    expect(() => stopMediaStreamTracks(null)).not.toThrow();
    expect(() => stopMediaStreamTracks(undefined)).not.toThrow();
  });

  it('keeps stopping the remaining tracks when one throws', () => {
    const { stream, stopped } = fakeStream(3, { throwAt: 1 });

    expect(() => stopMediaStreamTracks(stream)).not.toThrow();
    expect(stopped).toEqual([0, 2]);
  });
});
