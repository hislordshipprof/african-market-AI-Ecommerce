import { PHOTO_UPLOAD_MAX_BYTES } from "../listing/csv-file-cap";
import { isPhotoType } from "../image/photo-type";
import { cleanJpeg } from "../image/server-jpeg";

export const DELIVERY_PROOF_MAX_BYTES = PHOTO_UPLOAD_MAX_BYTES;
const MAX_INPUT_PIXELS = 16_777_216;

export const STORE_DELIVERY_ONLY = "Only a store-delivery order can be sent out or marked delivered";

export const PROOF_STORAGE_NOT_SET_UP = "Delivery photos are not set up for this store yet. Contact support";

export const PROOF_PHOTO_MISSING = "Add a photo of the delivered order";
export const PROOF_PHOTO_NOT_IMAGE = "The delivery photo must be a JPEG, PNG or WebP image";
export const PROOF_PHOTO_TOO_LARGE = "The delivery photo is too large. Take it again or choose a smaller one";


/**
 * Checks the photo, then re-encodes it: upright, long edge at most 2000px, JPEG 85,
 * and no metadata, so the EXIF GPS position of a customer's home is never stored.
 */
export async function prepareProofPhoto(
  bytes: Uint8Array | null,
): Promise<{ ok: true; jpeg: Buffer } | { ok: false; error: string }> {
  if (!bytes || bytes.byteLength === 0) return { ok: false, error: PROOF_PHOTO_MISSING };
  if (bytes.byteLength > DELIVERY_PROOF_MAX_BYTES) return { ok: false, error: PROOF_PHOTO_TOO_LARGE };
  if (!isPhotoType(bytes)) return { ok: false, error: PROOF_PHOTO_NOT_IMAGE };
  const { default: sharp } = await import("sharp");
  try {
    const jpeg = await cleanJpeg(sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "warning", animated: false }));
    return { ok: true, jpeg };
  } catch {
    return { ok: false, error: PROOF_PHOTO_NOT_IMAGE };
  }
}
