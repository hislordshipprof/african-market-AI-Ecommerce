import { CSV_ACTION_BODY_LIMIT_BYTES } from "../listing/csv-file-cap";

/** Nothing larger can arrive: the photo comes through a server action. */
export const DELIVERY_PROOF_MAX_BYTES = CSV_ACTION_BODY_LIMIT_BYTES;
const MAX_EDGE = 2000;
const MAX_INPUT_PIXELS = 16_777_216;

export const STORE_DELIVERY_ONLY = "Only a store-delivery order can be sent out or marked delivered";

export const PROOF_STORAGE_NOT_SET_UP = "Delivery photos are not set up for this store yet. Contact support";

export const PROOF_PHOTO_MISSING = "Add a photo of the delivered order";
export const PROOF_PHOTO_NOT_IMAGE = "The delivery photo must be a JPEG, PNG or WebP image";
export const PROOF_PHOTO_TOO_LARGE = "The delivery photo is too large. Take it again or choose a smaller one";

function startsWith(bytes: Uint8Array, prefix: number[], offset = 0): boolean {
  return prefix.every((byte, i) => bytes[offset + i] === byte);
}

/** The file's own magic bytes decide the type; the browser's content type is never trusted. */
function isPhotoType(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0xff, 0xd8, 0xff])
    || startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    || (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8));
}

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
    const jpeg = await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "warning", animated: false })
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .toColorspace("srgb")
      .jpeg({ quality: 85 })
      .toBuffer();
    return { ok: true, jpeg };
  } catch {
    return { ok: false, error: PROOF_PHOTO_NOT_IMAGE };
  }
}
