import { uploadToR2 } from "./r2";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;

export type ImageDownloadOptions = {
  /** Convert to webp (max 960px) with sharp before upload. Default: store the original bytes. */
  sharp?: boolean;
  /** Fetch attempts (429 and network errors back off and retry). Default 1: no retry. */
  retries?: number;
  /** Try a 960px Wikimedia thumbnail first, then the original URL. Default false. */
  rewriteWikimedia?: boolean;
  /** Key file extension. Default: derived from the response content type. */
  format?: string;
  /** Follow redirects. Default false (a redirect is treated as a failure). */
  followRedirects?: boolean;
  /** Per-request timeout in ms. Default 15s. */
  timeoutMs?: number;
  userAgent?: string;
};

export type ImageDownloadResult =
  | { ok: true; key: string; url: string; bytes: number }
  | { ok: false; reason: "download" | "upload" | "convert"; cause?: unknown };

export function toThumbnailUrl(originalUrl: string, width: number): string {
  try {
    const url = new URL(originalUrl);
    if (!url.hostname.endsWith("wikimedia.org")) return originalUrl;
    const parts = url.pathname.split("/");
    const commonsIdx = parts.indexOf("commons");
    if (commonsIdx === -1) return originalUrl;
    if (parts[commonsIdx + 1] === "thumb") return originalUrl;
    const filename = parts[parts.length - 1];
    const thumbSuffix = filename.toLowerCase().endsWith(".svg")
      ? `${width}px-${filename}.png`
      : `${width}px-${filename}`;
    const newParts = [...parts];
    newParts.splice(commonsIdx + 1, 0, "thumb");
    newParts.push(thumbSuffix);
    return `${url.origin}${newParts.join("/")}`;
  } catch {
    return originalUrl;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Read a body into memory, cancelling the stream once it passes `MAX_IMAGE_BYTES`. */
async function readCapped(body: ReadableStream<Uint8Array> | null): Promise<Buffer | null> {
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return total === 0 ? null : Buffer.concat(chunks);
}

async function fetchImage(
  url: string,
  opts: Required<Pick<ImageDownloadOptions, "retries" | "followRedirects" | "userAgent" | "timeoutMs">>,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  for (let attempt = 0; attempt < opts.retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": opts.userAgent },
        redirect: opts.followRedirects ? "follow" : "error",
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
      if (response.status === 429) {
        if (attempt >= opts.retries - 1) return null;
        const retryAfter = response.headers.get("Retry-After");
        const baseMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 1000 * Math.pow(2, attempt);
        await sleep(Math.min(baseMs + Math.random() * 1000, 60000));
        continue;
      }
      if (!response.ok) return null;
      const declared = response.headers.get("content-length");
      if (declared && parseInt(declared, 10) > MAX_IMAGE_BYTES) return null;
      const buffer = await readCapped(response.body);
      if (!buffer) return null;
      return { buffer, contentType: response.headers.get("content-type") || "image/jpeg" };
    } catch {
      if (attempt < opts.retries - 1) {
        await sleep(1000 * Math.pow(2, attempt) + Math.random() * 1000);
        continue;
      }
      return null;
    }
  }
  return null;
}

async function toWebp(raw: Buffer): Promise<{ webp: Buffer } | { error: unknown }> {
  try {
    const { default: sharp } = await import("sharp");
    const webp = await sharp(raw)
      .resize(960, 960, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    return { webp };
  } catch (error) {
    return { error };
  }
}

function extensionFor(contentType: string): string {
  return contentType.includes("png") ? "png" : contentType.includes("svg") ? "svg" : "jpg";
}

/**
 * Download a remote image and store it in R2 under `catalog/{id}.{ext}`.
 * The one place that owns the key scheme and the `uploadToR2` call; callers choose
 * conversion, retry and key-format behaviour through `options`.
 */
export async function downloadAndUploadImage(
  sourceUrl: string,
  id: string,
  options: ImageDownloadOptions = {},
): Promise<ImageDownloadResult> {
  const fail = { ok: false, reason: "download" } as const;
  if (!sourceUrl) return fail;
  try {
    const parsed = new URL(sourceUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return fail;
  } catch {
    return fail;
  }

  const fetchOpts = {
    retries: Math.max(1, options.retries ?? 1),
    followRedirects: options.followRedirects ?? false,
    userAgent: options.userAgent ?? "AfricanMarketsPlatform/1.0 (catalog)",
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  const thumb = options.rewriteWikimedia ? toThumbnailUrl(sourceUrl, 960) : sourceUrl;
  const candidates = thumb !== sourceUrl ? [thumb, sourceUrl] : [sourceUrl];

  let image: { buffer: Buffer; contentType: string } | null = null;
  let convertError: unknown;
  for (const candidate of candidates) {
    const raw = await fetchImage(candidate, fetchOpts);
    if (!raw) continue;
    if (options.sharp) {
      const converted = await toWebp(raw.buffer);
      if ("error" in converted) {
        convertError = converted.error;
        continue;
      }
      image = { buffer: converted.webp, contentType: "image/webp" };
    } else {
      image = raw;
    }
    break;
  }
  if (!image) {
    return convertError === undefined ? fail : { ok: false, reason: "convert", cause: convertError };
  }

  const key = `catalog/${id}.${options.format ?? extensionFor(image.contentType)}`;
  try {
    const url = await uploadToR2(key, image.buffer, image.contentType);
    return { ok: true, key, url, bytes: image.buffer.byteLength };
  } catch (cause) {
    return { ok: false, reason: "upload", cause };
  }
}
