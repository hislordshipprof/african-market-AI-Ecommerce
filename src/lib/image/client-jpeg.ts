const QUALITIES = [0.85, 0.7, 0.55, 0.4];

/**
 * Browser only: downscale a photo to a 2000px long edge and encode it as JPEG 0.85,
 * stepping the quality down until it fits `maxBytes`. Returns the smallest try if none fits.
 */
export async function jpegBlob(file: Blob, maxBytes = Infinity): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const edge = Math.max(bitmap.width, bitmap.height);
    const scale = edge > 2000 ? 2000 / edge : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("canvas");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let blob: Blob | null = null;
    for (const quality of QUALITIES) {
      blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (!blob) throw new Error("encode");
      if (blob.size <= maxBytes) break;
    }
    return blob!;
  } finally {
    bitmap.close();
  }
}
