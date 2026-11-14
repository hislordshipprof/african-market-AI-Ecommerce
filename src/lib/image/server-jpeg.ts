import type { Sharp } from "sharp";

/** Server only: upright, long edge at most 2000px, white behind transparency, sRGB JPEG 85, no metadata. */
export function cleanJpeg(image: Sharp): Promise<Buffer> {
  return image
    .rotate()
    .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .toColorspace("srgb")
    .jpeg({ quality: 85 })
    .toBuffer();
}
