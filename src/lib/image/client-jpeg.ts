/** Browser only: downscale a photo to a 2000px long edge and encode it as JPEG 0.85. */
export async function jpegBlob(file: Blob): Promise<Blob> {
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
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) throw new Error("encode");
    return blob;
  } finally {
    bitmap.close();
  }
}
