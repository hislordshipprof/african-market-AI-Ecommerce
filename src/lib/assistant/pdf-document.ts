const PAGE_LIMIT = 10;
const PARSE_MS = 8_000;

export type PdfRead =
  | { ok: true; pages: number }
  | { ok: false; code: "attachment_encrypted" | "attachment_pages" | "attachment_type" };

/**
 * Page count and encryption only. The worker takes ownership of the typed
 * array it is given, so callers pass a copy and keep their own bytes.
 * Node runs pdf.js on the main thread (`PDFWorker` disables the worker there),
 * so the route must not resolve `pdf.worker.mjs`: a production bundle turns
 * `require.resolve` of that file into a numeric module id and `pathToFileURL`
 * then throws before any page is read.
 * `isEvalSupported: false` is the pdf.js 4.2.67+ CVE-2024-4367 switch. 6.5
 * no longer evaluates font programs; the flag stays so a future build cannot
 * turn that path back on unnoticed.
 */
export async function readPdfDocument(bytes: Uint8Array): Promise<PdfRead> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  let askedForPassword = false;
  const task = pdfjs.getDocument({
    data: copy,
    isEvalSupported: false,
    verbosity: 0,
    disableFontFace: true,
    useSystemFonts: false,
    isOffscreenCanvasSupported: false,
    onPassword: () => {
      askedForPassword = true;
    },
  } as Parameters<typeof pdfjs.getDocument>[0]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<PdfRead>((resolve) => {
    timer = setTimeout(() => {
      void task.destroy().catch(() => {});
      resolve({ ok: false, code: "attachment_type" });
    }, PARSE_MS);
  });
  try {
    return await Promise.race([inspect(task, () => askedForPassword), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    await task.destroy().catch(() => {});
  }
}

function passwordException(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const named = error as { name?: string; constructor?: { name?: string } };
  return named.name === "PasswordException" || named.constructor?.name === "PasswordException";
}

async function inspect(
  task: { promise: Promise<{ numPages: number; getPermissions: () => Promise<Set<number> | null> }> },
  asked: () => boolean,
): Promise<PdfRead> {
  try {
    const doc = await task.promise;
    const pages = doc.numPages;
    const permissions = await doc.getPermissions();
    if (asked() || permissions != null) return { ok: false, code: "attachment_encrypted" };
    if (!Number.isInteger(pages) || pages < 1) return { ok: false, code: "attachment_type" };
    if (pages > PAGE_LIMIT) return { ok: false, code: "attachment_pages" };
    return { ok: true, pages };
  } catch (error) {
    if (asked() || passwordException(error)) return { ok: false, code: "attachment_encrypted" };
    return { ok: false, code: "attachment_type" };
  }
}
