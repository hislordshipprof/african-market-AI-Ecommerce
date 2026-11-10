export const DELIVERY_PROOF_MAX_BYTES = 8 * 1024 * 1024;

export const STORE_DELIVERY_ONLY = "Only a store-delivery order can be sent out or marked delivered";

export const PROOF_PHOTO_MISSING = "Add a photo of the delivered order";
export const PROOF_PHOTO_NOT_IMAGE = "The delivery photo must be a JPEG, PNG or WebP image";
export const PROOF_PHOTO_TOO_LARGE = "The delivery photo must be 8 MB or smaller";

export type ProofImageType = { ext: "jpg" | "png" | "webp"; contentType: string };

function startsWith(bytes: Uint8Array, prefix: number[], offset = 0): boolean {
  return prefix.every((byte, i) => bytes[offset + i] === byte);
}

/** The file's own magic bytes decide the type; the browser's content type is never trusted. */
function sniff(bytes: Uint8Array): ProofImageType | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { ext: "jpg", contentType: "image/jpeg" };
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: "png", contentType: "image/png" };
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { ext: "webp", contentType: "image/webp" };
  }
  return null;
}

export function checkProofPhoto(
  bytes: Uint8Array | null,
): { ok: true; type: ProofImageType } | { ok: false; error: string } {
  if (!bytes || bytes.byteLength === 0) return { ok: false, error: PROOF_PHOTO_MISSING };
  if (bytes.byteLength > DELIVERY_PROOF_MAX_BYTES) return { ok: false, error: PROOF_PHOTO_TOO_LARGE };
  const type = sniff(bytes);
  return type ? { ok: true, type } : { ok: false, error: PROOF_PHOTO_NOT_IMAGE };
}
