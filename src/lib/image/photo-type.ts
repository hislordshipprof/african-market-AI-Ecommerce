function startsWith(bytes: Uint8Array, prefix: number[], offset = 0): boolean {
  return prefix.every((byte, i) => bytes[offset + i] === byte);
}

/** JPEG, PNG or WebP by the file's own magic bytes; the browser's content type is never trusted. */
export function isPhotoType(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0xff, 0xd8, 0xff])
    || startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    || (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8));
}

/** SVG text, after an optional BOM and whitespace, an XML declaration, comments or a doctype. */
export function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 4096)).replace(/^\uFEFF/, "").trimStart().toLowerCase();
  return head.startsWith("<svg") || (head.startsWith("<") && head.includes("<svg"));
}
