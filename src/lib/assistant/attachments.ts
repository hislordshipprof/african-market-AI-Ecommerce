import { createHash } from "node:crypto";
import { generateId } from "ai";
import { FILENAME_CARD_SEPARATORS, scrubCardNumbers } from "./card-scrub";
import type { PdfRead } from "./pdf-document";

export const TEXT_BODY_CAP = 16 * 1024;
export const FILE_BODY_CAP = 4_300_000;
export const MAX_FILES = 3;
export const MAX_DECODED_BYTES = 3_145_728;
export const MAX_TEXT = 2000;
const MAX_EDGE = 4096;
const MAX_PIXELS = 16_777_216;

export const FILE_TURN_TOOLS = [
  "search_catalog",
  "show_products",
  "check_availability",
  "suggest_substitutes",
  "get_cart_summary",
  "offer_choices",
] as const;

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const FILE_TYPES = new Set([...IMAGE_TYPES, "application/pdf"]);

export interface AttachmentDescriptor {
  name: string;
  mediaType: string;
  bytes: number;
  pages?: number;
  digest: string;
}

export interface PreparedAttachment {
  descriptor: AttachmentDescriptor;
  modelMediaType: "image/jpeg" | "application/pdf";
  modelBytes: Buffer;
}

export interface IncomingFile {
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
  filename: string;
  bytes: Buffer;
}

export type ReadFailure = { ok: false; status: number; code: string; message: string };

export type ReadAssistantRequest =
  | {
      ok: true;
      id: string;
      text: string;
      files: IncomingFile[];
      /** A valid id and no parts. Completed turns replay; anything else is rejected later. */
      replayOnly: boolean;
    }
  | ReadFailure;

const COPY: Record<string, string> = {
  attachment_too_many: "You can send up to 3 files.",
  attachment_too_large: "Those files are too big to send. Keep them under 3 MB.",
  attachment_type: "That file needs to be a JPEG, PNG, WebP, or a PDF we can read.",
  attachment_pixels: "That photo is too large to read.",
  attachment_pages: "PDFs can be up to 10 pages.",
  attachment_encrypted: "That PDF is locked. Send one that opens without a password.",
  attachment_missing: "Send those files again so the helper can read them.",
  attachment_conflict: "That message does not match the files already sent.",
  assistant_unavailable: "The helper is not available right now.",
};

export function attachmentFailure(code: string, status = 400): ReadFailure {
  return { ok: false, status, code, message: COPY[code] ?? "Couldn't send that." };
}

export async function readAssistantRequest(request: Request): Promise<ReadAssistantRequest> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return { ok: false, status: 400, code: "invalid_request", message: "Send a JSON message." };
  }
  const declared = request.headers.get("content-length");
  if (declared != null && declared.trim() !== "") {
    const length = Number(declared);
    if (Number.isFinite(length) && length > FILE_BODY_CAP) return attachmentFailure("attachment_too_large");
  }
  const body = await readBounded(request);
  if (!body.ok) return body;
  if (body.bytes > FILE_BODY_CAP) return attachmentFailure("attachment_too_large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.raw);
  } catch {
    return { ok: false, status: 400, code: "invalid_request", message: "Send a JSON message." };
  }
  const message = parsed && typeof parsed === "object" ? (parsed as { message?: unknown }).message : undefined;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return { ok: false, status: 400, code: "invalid_request", message: "Send one user message." };
  }
  const record = message as { role?: unknown; parts?: unknown; id?: unknown };
  if (record.role !== "user" || !Array.isArray(record.parts)) {
    return { ok: false, status: 400, code: "invalid_request", message: "Send one user message." };
  }
  const rawId = typeof record.id === "string" ? record.id : "";
  const id = /^[A-Za-z0-9_-]{8,80}$/.test(rawId) ? rawId : generateId();
  if (record.parts.length === 0) return { ok: true, id, text: "", files: [], replayOnly: true };

  const files: IncomingFile[] = [];
  const texts: string[] = [];
  for (const part of record.parts) {
    if (!part || typeof part !== "object" || Array.isArray(part)) {
      return { ok: false, status: 400, code: "invalid_request", message: "Send plain text." };
    }
    const typed = part as Record<string, unknown>;
    if (typed.type === "text") {
      if (typeof typed.text !== "string" || Object.keys(typed).some((key) => key !== "type" && key !== "text")) {
        return { ok: false, status: 400, code: "invalid_request", message: "Send plain text." };
      }
      texts.push(typed.text);
      continue;
    }
    if (typed.type !== "file") return attachmentFailure("attachment_type");
    const allowed = new Set(["type", "mediaType", "filename", "url"]);
    if (Object.keys(typed).some((key) => !allowed.has(key))) return attachmentFailure("attachment_type");
    const mediaType = typeof typed.mediaType === "string" ? typed.mediaType.toLowerCase() : "";
    const url = typeof typed.url === "string" ? typed.url : "";
    if (!FILE_TYPES.has(mediaType)) return attachmentFailure("attachment_type");
    const decoded = decodeDataUrl(url, mediaType);
    if (!decoded) return attachmentFailure("attachment_type");
    if (!magicMatches(decoded, mediaType)) return attachmentFailure("attachment_type");
    files.push({
      mediaType: mediaType as IncomingFile["mediaType"],
      filename: typeof typed.filename === "string" ? typed.filename : "",
      bytes: decoded,
    });
  }
  if (files.length > MAX_FILES) return attachmentFailure("attachment_too_many");
  const decodedBytes = files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (decodedBytes > MAX_DECODED_BYTES) return attachmentFailure("attachment_too_large");
  const text = scrubCardNumbers(texts.join("")).text.trim();
  if (files.length === 0) {
    if (body.bytes > TEXT_BODY_CAP) {
      return { ok: false, status: 400, code: "invalid_request", message: "That message is too large." };
    }
    if (text.length < 1 || text.length > MAX_TEXT) {
      return { ok: false, status: 400, code: "invalid_request", message: "Write between 1 and 2000 characters." };
    }
  } else if (text.length > MAX_TEXT) {
    return { ok: false, status: 400, code: "invalid_request", message: "Write between 1 and 2000 characters." };
  }
  return { ok: true, id, text, files, replayOnly: false };
}

export async function prepareAttachments(files: IncomingFile[]): Promise<
  { ok: true; files: PreparedAttachment[] } | ReadFailure
> {
  const prepared: PreparedAttachment[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const digest = createHash("sha256").update(file.bytes).digest("hex");
    const name = safeAttachmentName(file.filename, index + 1, file.mediaType);
    if (file.mediaType === "application/pdf") {
      const { readPdfDocument } = await import("./pdf-document");
      const pdf = await readPdfDocument(file.bytes);
      if (!pdf.ok) return attachmentFailure(pdf.code);
      prepared.push({
        descriptor: { name, mediaType: file.mediaType, bytes: file.bytes.length, pages: pdf.pages, digest },
        modelMediaType: "application/pdf",
        modelBytes: Buffer.from(file.bytes),
      });
      continue;
    }
    const header = pngHeader(file.bytes);
    if (header && (header.width > MAX_EDGE || header.height > MAX_EDGE || header.width * header.height > MAX_PIXELS)) {
      return attachmentFailure("attachment_pixels");
    }
    const photo = await reencodePhoto(file.bytes);
    if (!photo.ok) return photo;
    prepared.push({
      descriptor: { name, mediaType: file.mediaType, bytes: file.bytes.length, digest },
      modelMediaType: "image/jpeg",
      modelBytes: photo.bytes,
    });
  }
  return { ok: true, files: prepared };
}

function keepExtension(name: string, mediaType: string): string {
  const fallbackExt = mediaType === "application/pdf" ? ".pdf" : ".jpg";
  const dot = name.lastIndexOf(".");
  const rawExt = dot > 0 ? name.slice(dot).toLowerCase() : fallbackExt;
  const ext = /^\.[a-z0-9]{1,8}$/.test(rawExt) ? rawExt : fallbackExt;
  const stem = (dot > 0 ? name.slice(0, dot) : name).replace(/\s+/g, " ").trim();
  const room = Math.max(1, 80 - ext.length);
  return `${stem.slice(0, room).trim()}${ext}`;
}

export function safeAttachmentName(filename: string, index: number, mediaType: string): string {
  const base = filename.normalize("NFKC").split(/[/\\]/).pop() ?? "";
  const cleaned = base
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/[^0-9A-Za-z ._()\-]/g, "")
    .trim();
  const fallback = mediaType === "application/pdf" ? `document-${index}.pdf` : `photo-${index}.jpg`;
  const named = cleaned.length > 0 ? cleaned : fallback;
  const scrubbed = scrubCardNumbers(keepExtension(named, mediaType), { separators: FILENAME_CARD_SEPARATORS }).text
    .replace(/\s+/g, " ")
    .trim();
  const capped = keepExtension(scrubbed.length > 0 ? scrubbed : fallback, mediaType);
  return capped.length > 0 ? capped : fallback;
}

export function descriptorsMatch(stored: AttachmentDescriptor[], files: IncomingFile[]): boolean {
  if (stored.length !== files.length) return false;
  return stored.every((descriptor, index) => descriptor.digest === createHash("sha256").update(files[index].bytes).digest("hex"));
}

export function attachmentDescriptors(value: unknown): AttachmentDescriptor[] {
  if (!value || typeof value !== "object" || !("parts" in value)) return [];
  const parts = (value as { parts?: unknown }).parts;
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part) => {
    if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "data-attachment") return [];
    const data = (part as { data?: unknown }).data;
    if (!data || typeof data !== "object") return [];
    const record = data as { name?: unknown; mediaType?: unknown; bytes?: unknown; pages?: unknown; digest?: unknown };
    if (typeof record.name !== "string" || typeof record.mediaType !== "string" || typeof record.bytes !== "number") return [];
    return [{
      name: record.name,
      mediaType: record.mediaType,
      bytes: record.bytes,
      ...(typeof record.pages === "number" ? { pages: record.pages } : {}),
      digest: typeof record.digest === "string" ? record.digest : "",
    }];
  });
}

export function attachmentNote(descriptor: AttachmentDescriptor, index: number): string {
  const kind = descriptor.mediaType === "application/pdf" ? "PDF" : "photo";
  const pages = descriptor.pages != null ? `, ${descriptor.pages} pages` : "";
  return `[Attachment ${index} from an earlier message: ${kind}${pages}, not available any more]`;
}

function decodeDataUrl(url: string, mediaType: string): Buffer | null {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
  if (!match || match[1].toLowerCase() !== mediaType) return null;
  const payload = match[2];
  if (payload.length % 4 !== 0) return null;
  const bytes = Buffer.from(payload, "base64");
  if (bytes.toString("base64") !== payload) return null;
  return bytes;
}

function pngHeader(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function magicMatches(bytes: Buffer, mediaType: string): boolean {
  if (mediaType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mediaType === "image/png") {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mediaType === "image/webp") {
    return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  }
  if (mediaType === "application/pdf") return bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  return false;
}

async function readBounded(request: Request): Promise<{ ok: true; raw: string; bytes: number } | ReadFailure> {
  const reader = request.body?.getReader();
  if (!reader) {
    try {
      const raw = await request.text();
      return { ok: true, raw, bytes: Buffer.byteLength(raw, "utf8") };
    } catch {
      return { ok: false, status: 400, code: "invalid_request", message: "That message did not finish sending." };
    }
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > FILE_BODY_CAP) {
        await reader.cancel().catch(() => {});
        return attachmentFailure("attachment_too_large");
      }
      chunks.push(next.value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    return { ok: false, status: 400, code: "invalid_request", message: "That message did not finish sending." };
  }
  const raw = new TextDecoder().decode(Buffer.concat(chunks));
  return { ok: true, raw, bytes: total };
}

async function reencodePhoto(bytes: Buffer): Promise<{ ok: true; bytes: Buffer } | ReadFailure> {
  let sharp: (input: Buffer, options: { limitInputPixels: number; failOn: "warning"; animated: false }) => import("sharp").Sharp;
  try {
    const loaded = await import("sharp");
    sharp = loaded.default as unknown as typeof sharp;
  } catch {
    console.error("[assistant] photo library failed to load");
    return attachmentFailure("assistant_unavailable", 503);
  }
  try {
    const image = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "warning", animated: false });
    const meta = await image.metadata();
    const format = meta.format;
    if (format !== "jpeg" && format !== "png" && format !== "webp") return attachmentFailure("attachment_type");
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) return attachmentFailure("attachment_pixels");
    const encoded = await image
      .rotate()
      .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .toColorspace("srgb")
      .jpeg({ quality: 85 })
      .toBuffer();
    return { ok: true, bytes: encoded };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/pixel limit|exceeds pixel|too large/i.test(message)) return attachmentFailure("attachment_pixels");
    if (/unsupported|premature|corrupt|Vips|Input|warning|boomerang/i.test(message)) {
      return attachmentFailure("attachment_type");
    }
    console.error("[assistant] photo could not be read");
    return attachmentFailure("assistant_unavailable", 503);
  }
}

export type { PdfRead };
