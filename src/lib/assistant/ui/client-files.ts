export const FILE_CAP = 3;

export type PreparedFile = {
  id: string;
  name: string;
  mediaType: "image/jpeg" | "application/pdf";
  url: string;
  filename: string;
  status: "ready" | "invalid";
  message: string | null;
};

export function roomFor(count: number): number {
  return Math.max(0, FILE_CAP - count);
}

export function fileNotice(kind: "pages" | "encrypted" | "undecodable" | "too-many"): string {
  if (kind === "pages") return "PDFs can be up to 10 pages.";
  if (kind === "encrypted") return "That PDF is locked. Send one that opens without a password.";
  if (kind === "too-many") return "You can send up to 3 files.";
  return "This browser can't read that photo.";
}

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
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) throw new Error("encode");
    return blob;
  } finally {
    bitmap.close();
  }
}

export async function dataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return `data:${blob.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

export async function pdfPages(bytes: Uint8Array): Promise<{ pages: number } | { message: string }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const worker = new Worker(new URL("pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url), { type: "module" });
  pdfjs.GlobalWorkerOptions.workerPort = worker;
  const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 } as Parameters<typeof pdfjs.getDocument>[0]);
  try {
    const doc = await task.promise;
    const pages = doc.numPages;
    const permissions = await doc.getPermissions();
    if (permissions) return { message: fileNotice("encrypted") };
    if (pages > 10) return { message: fileNotice("pages") };
    return { pages };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "PasswordException") return { message: fileNotice("encrypted") };
    return { message: "That file needs to be a JPEG, PNG, WebP, or a PDF we can read." };
  } finally {
    worker.terminate();
  }
}
