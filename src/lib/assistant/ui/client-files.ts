import { scrubFileNameCards } from "../card-scrub";

export { jpegBlob } from "@/lib/image/client-jpeg";

const NAME_CAP = 80;

/**
 * Stem and extension of a customer's filename with nothing unsafe left: the last path
 * segment only, no control or format characters (bidi, LRM/RLM/ALM, zero-width, BOM),
 * and card numbers masked however the digits are split.
 */
function safeNameParts(name: string): { stem: string; ext: string } {
  const segment = name.normalize("NFKC").split(/[/\\]/).pop() ?? "";
  const cleaned = segment.replace(/[\p{Cc}\p{Cf}]/gu, "").replace(/\s+/g, " ").trim();
  const scrubbed = scrubFileNameCards(cleaned).text;
  const dot = scrubbed.lastIndexOf(".");
  const rawExt = dot > 0 ? scrubbed.slice(dot) : "";
  const ext = /^\.[a-z0-9]{1,8}$/i.test(rawExt) ? rawExt : "";
  const stem = (dot > 0 ? scrubbed.slice(0, dot) : dot === 0 ? "" : scrubbed).replace(/^[.\s]+|[.\s]+$/g, "");
  return { stem: stem || "file", ext };
}

/** Cut by code points, so an emoji at the cut never leaves a lone surrogate. */
function withExtension(stem: string, ext: string): string {
  const room = Math.max(1, NAME_CAP - ext.length);
  const cut = Array.from(stem).slice(0, room).join("").trim();
  return `${cut || "file"}${ext}`;
}

/** The name shown on a tile. Card digits, bidi and format characters never reach the button. */
export function displayFileName(name: string): string {
  const { stem, ext } = safeNameParts(name);
  return withExtension(stem, ext);
}

/** The name posted with a photo. The bytes were re-encoded, so the extension is `.jpg`. */
export function postedPhotoName(name: string): string {
  return withExtension(safeNameParts(name).stem, ".jpg");
}

export const FILE_CAP = 3;
export const FILE_BYTE_CAP = 3_145_728;

export type PreparedFile = {
  id: string;
  name: string;
  mediaType: "image/jpeg" | "application/pdf";
  url: string;
  filename: string;
  status: "pending" | "ready" | "invalid";
  message: string | null;
  bytes: number;
};

export function roomFor(count: number): number {
  return Math.max(0, FILE_CAP - count);
}

export function withinByteCap(sizes: number[]): boolean {
  return sizes.reduce((sum, size) => sum + size, 0) <= FILE_BYTE_CAP;
}

export function fileNotice(kind: "pages" | "encrypted" | "undecodable" | "too-many" | "too-large"): string {
  if (kind === "pages") return "PDFs can be up to 10 pages.";
  if (kind === "encrypted") return "That PDF is locked. Send one that opens without a password.";
  if (kind === "too-many") return "You can send up to 3 files.";
  if (kind === "too-large") return "Those files are too big to send. Keep them under 3 MB.";
  return "This browser can't read that photo.";
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
  // pdf.js takes ownership of the typed array and detaches it. Keep the caller's bytes.
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const task = pdfjs.getDocument({ data: owned, isEvalSupported: false, verbosity: 0 } as Parameters<typeof pdfjs.getDocument>[0]);
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
