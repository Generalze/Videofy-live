/** @author masterzee001 */
/**
 * Where the other person's voice comes out of the phone.
 *
 * NO ARTIFICIAL GAIN ANYWHERE. "Not as loud" on a call is a ROUTING question:
 * a voice on the earpiece at arm's length is quiet, on the loudspeaker it is
 * not. So the call has a Speaker control and a sensible default -- earpiece
 * for an audio-only call held to the ear, loudspeaker the moment the camera
 * comes on, because a person looking at a screen is not holding it to their
 * ear.
 *
 * react-native-webrtc 124 has no Android routing API of its own; expo-audio's
 * `setAudioModeAsync({ shouldRouteThroughEarpiece })` writes AudioManager's
 * mode and speakerphone flag, which is the switch the platform actually
 * has. Injected here so the decision is testable without a device.
 */

export type AudioRoute = 'earpiece' | 'speaker';

/** The route nobody chose: camera on means the phone is in front of a face. */
export function defaultRoute(cameraOn: boolean): AudioRoute {
  return cameraOn ? 'speaker' : 'earpiece';
}

/** An explicit choice wins over the default, and keeps winning as the camera toggles. */
export function resolveRoute(cameraOn: boolean, chosen: AudioRoute | null): AudioRoute {
  return chosen ?? defaultRoute(cameraOn);
}

export type AudioModeSetter = (mode: { shouldRouteThroughEarpiece: boolean }) => Promise<void>;

export interface AudioRouter {
  /** Apply a route. False means the platform refused; the call continues. */
  apply(route: AudioRoute): Promise<boolean>;
  /** Back to the platform default on the way out, so music after a call is not on the earpiece. */
  release(): Promise<void>;
  current(): AudioRoute | null;
}

export function createAudioRouter(setMode: AudioModeSetter): AudioRouter {
  let applied: AudioRoute | null = null;
  return {
    async apply(route) {
      if (applied === route) return true;
      try {
        await setMode({ shouldRouteThroughEarpiece: route === 'earpiece' });
        applied = route;
        return true;
      } catch {
        return false;
      }
    },
    async release() {
      try {
        await setMode({ shouldRouteThroughEarpiece: false });
      } catch {
        // Best effort: an audio mode that cannot be reset is not worth an error.
      }
      applied = null;
    },
    current() {
      return applied;
    },
  };
}
