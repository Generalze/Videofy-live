/** @author masterzee001 */
/**
 * Picking a profile picture, on a build that may not carry the modules yet.
 *
 * expo-image-picker and expo-image-manipulator are NATIVE modules: they exist
 * only in an APK built after they were added. On an older dev build the
 * import itself throws, so both are loaded lazily and a missing module
 * becomes a named sentence -- "install the newer app build" -- instead of a
 * red screen. This mirrors how every hardware-adjacent surface in this app
 * fails: with a name, never a crash.
 *
 * The image is resized to 512px JPEG before upload: the server caps bodies at
 * 2MB, faces render in small circles, and re-encoding strips the EXIF block
 * -- including the GPS position phone cameras write by default.
 */

export type PickOutcome =
  | { readonly ok: true; readonly dataUrl: string }
  | { readonly ok: false; readonly reason: string }
  | { readonly ok: false; readonly reason: null /* cancelled: say nothing */ };

const NEEDS_BUILD =
  'Picking a picture needs the newer app build. Install the latest APK and try again.';

export async function pickAvatar(): Promise<PickOutcome> {
  let picker: typeof import('expo-image-picker');
  let manipulator: typeof import('expo-image-manipulator');
  try {
    picker = require('expo-image-picker');
    manipulator = require('expo-image-manipulator');
  } catch {
    return { ok: false, reason: NEEDS_BUILD };
  }

  try {
    const permission = await picker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      return { ok: false, reason: 'Allow photo access in system settings to set a picture.' };
    }
    const chosen = await picker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 1,
    });
    const asset = chosen.assets?.[0];
    if (chosen.canceled || asset === undefined) return { ok: false, reason: null };

    const small = await manipulator.manipulateAsync(
      asset.uri,
      [{ resize: { width: 512 } }],
      { compress: 0.85, format: manipulator.SaveFormat.JPEG, base64: true },
    );
    if (!small.base64) return { ok: false, reason: 'That picture could not be read.' };
    return { ok: true, dataUrl: `data:image/jpeg;base64,${small.base64}` };
  } catch {
    return { ok: false, reason: 'That picture could not be read.' };
  }
}
