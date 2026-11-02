import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const uploadToR2 = vi.fn(async (key: string) => `https://cdn.test/${key}`);
vi.mock("./r2", () => ({ uploadToR2: (...a: unknown[]) => uploadToR2(...(a as [string])) }));

const sharpPipeline = {
  resize: vi.fn().mockReturnThis(),
  webp: vi.fn().mockReturnThis(),
  toBuffer: vi.fn(async () => Buffer.from("WEBP")),
};
const sharpFn = vi.fn(() => sharpPipeline);
vi.mock("sharp", () => ({ default: (...a: unknown[]) => (sharpFn as (...x: unknown[]) => unknown)(...a) }));

import { downloadAndUploadImage, toThumbnailUrl } from "./catalog-image";

function okResponse(body = "IMG", type = "image/png") {
  return new Response(body, { status: 200, headers: { "content-type": type } });
}

describe("downloadAndUploadImage", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    uploadToR2.mockClear();
    sharpFn.mockClear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("actions path: single fetch, original format, extension from content-type, no sharp", async () => {
    fetchMock.mockResolvedValueOnce(okResponse("PNGDATA", "image/png"));
    const res = await downloadAndUploadImage("https://x.test/a", "p1");
    expect(res).toEqual({ ok: true, key: "catalog/p1.png", url: "https://cdn.test/catalog/p1.png", bytes: 7 });
    expect(sharpFn).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].redirect).toBe("error");
    expect(uploadToR2).toHaveBeenCalledWith("catalog/p1.png", expect.any(Buffer), "image/png");
  });

  it("actions path: does not retry on a 429 and reports a download failure", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 429 }));
    const res = await downloadAndUploadImage("https://x.test/a", "p1");
    expect(res).toEqual({ ok: false, reason: "download" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(uploadToR2).not.toHaveBeenCalled();
  });

  it("rejects non-http(s) URLs without fetching", async () => {
    expect(await downloadAndUploadImage("file:///etc/passwd", "p1")).toEqual({ ok: false, reason: "download" });
    expect(await downloadAndUploadImage("not a url", "p1")).toEqual({ ok: false, reason: "download" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects oversized content-length", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("x", { status: 200, headers: { "content-length": String(11 * 1024 * 1024) } }),
    );
    expect(await downloadAndUploadImage("https://x.test/a", "p1")).toEqual({ ok: false, reason: "download" });
  });

  it("seed path: sharp -> webp key, retries a 429 then succeeds, rewrites Wikimedia to a thumbnail", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "Retry-After": "1" } }))
      .mockResolvedValueOnce(okResponse("RAW", "image/jpeg"));
    const p = downloadAndUploadImage(
      "https://upload.wikimedia.org/wikipedia/commons/a/ab/Yam.jpg",
      "p2",
      { sharp: true, retries: 5, rewriteWikimedia: true, format: "webp", followRedirects: true },
    );
    await vi.runAllTimersAsync();
    const res = await p;
    expect(res).toEqual({ ok: true, key: "catalog/p2.webp", url: "https://cdn.test/catalog/p2.webp", bytes: 4 });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Yam.jpg/960px-Yam.jpg",
    );
    expect(fetchMock.mock.calls[0][1].redirect).toBe("follow");
    expect(sharpFn).toHaveBeenCalledTimes(1);
    expect(uploadToR2).toHaveBeenCalledWith("catalog/p2.webp", Buffer.from("WEBP"), "image/webp");
  });

  it("seed path: falls back to the original URL when the thumbnail fails", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("", { status: 404 }))
      .mockResolvedValueOnce(okResponse("RAW", "image/jpeg"));
    const res = await downloadAndUploadImage(
      "https://upload.wikimedia.org/wikipedia/commons/a/ab/Yam.jpg",
      "p2",
      { sharp: true, retries: 5, rewriteWikimedia: true, format: "webp", followRedirects: true },
    );
    expect(res.ok).toBe(true);
    expect(fetchMock.mock.calls[1][0]).toBe("https://upload.wikimedia.org/wikipedia/commons/a/ab/Yam.jpg");
  });

  it("reports an upload failure distinctly", async () => {
    fetchMock.mockResolvedValueOnce(okResponse());
    uploadToR2.mockRejectedValueOnce(new Error("boom"));
    expect(await downloadAndUploadImage("https://x.test/a", "p1")).toMatchObject({ ok: false, reason: "upload" });
  });
});

describe("toThumbnailUrl", () => {
  it("leaves non-Wikimedia and already-thumb URLs alone", () => {
    expect(toThumbnailUrl("https://x.test/a.jpg", 960)).toBe("https://x.test/a.jpg");
    const t = "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Y.jpg/960px-Y.jpg";
    expect(toThumbnailUrl(t, 960)).toBe(t);
  });
  it("renders svg as png", () => {
    expect(toThumbnailUrl("https://upload.wikimedia.org/wikipedia/commons/a/ab/Y.svg", 960)).toBe(
      "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Y.svg/960px-Y.svg.png",
    );
  });
});

describe("failure causes", () => {
  it("surfaces the upload error and a sharp conversion error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse()));
    const boom = new Error("denied");
    uploadToR2.mockRejectedValueOnce(boom);
    expect(await downloadAndUploadImage("https://x.test/a", "p1")).toEqual({ ok: false, reason: "upload", cause: boom });

    const bad = new Error("bad image");
    sharpPipeline.toBuffer.mockRejectedValueOnce(bad);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse()));
    expect(await downloadAndUploadImage("https://x.test/a", "p1", { sharp: true })).toEqual({ ok: false, reason: "convert", cause: bad });
    vi.unstubAllGlobals();
  });
});
