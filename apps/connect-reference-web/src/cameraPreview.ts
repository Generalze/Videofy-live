// owner: masterzee001
/**
 * Lobby camera preview, on the plain browser API. The preview is a courtesy
 * mirror before joining — the SDK owns the camera once you are in the room —
 * so this manager has exactly two duties: acquire a video-only stream, and
 * RELEASE every track the moment the preview turns off or the person joins.
 * A preview that keeps the camera light on after leaving the lobby is a bug,
 * not a style choice.
 */

export interface PreviewMediaDevices {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

export interface CameraPreviewController {
  supported(): boolean;
  /** Idempotent: stops any earlier stream before acquiring a fresh one. */
  start(): Promise<MediaStream>;
  /** Stops and releases every track. Safe to call repeatedly. */
  stop(): void;
  current(): MediaStream | null;
}

export function createCameraPreview(
  devices: PreviewMediaDevices | undefined,
): CameraPreviewController {
  let stream: MediaStream | null = null;

  function stop(): void {
    if (stream === null) return;
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }

  return {
    supported: () => devices !== undefined,
    async start() {
      if (devices === undefined) {
        throw new Error('This browser cannot show a camera preview.');
      }
      stop();
      const fresh = await devices.getUserMedia({ video: true, audio: false });
      stream = fresh;
      return fresh;
    },
    stop,
    current: () => stream,
  };
}
