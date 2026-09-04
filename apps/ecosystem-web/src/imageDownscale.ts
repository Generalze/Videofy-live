/** @author masterzee001 */
/**
 * A camera photo, made avatar-sized before it travels.
 *
 * The server caps uploads at 2MB and the face renders in a small circle, so
 * sending twelve megapixels would spend the person's upstream on nothing.
 * Canvas re-encoding also strips EXIF -- including GPS coordinates a phone
 * camera writes by default, which have no business in a profile picture.
 */
export async function downscaleToDataUrl(file: File, maxEdge: number): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('Canvas is unavailable.');
    context.drawImage(bitmap, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    bitmap.close();
  }
}
