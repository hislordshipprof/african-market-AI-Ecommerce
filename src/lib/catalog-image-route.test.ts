import { describe, it, expect, vi, beforeEach } from "vitest";

const mockStreamFromR2 = vi.fn();
vi.mock("@/lib/r2", () => ({ streamFromR2: mockStreamFromR2 }));

beforeEach(() => {
  mockStreamFromR2.mockReset();
});

async function importGET() {
  const mod = await import("../app/api/catalog-image/[...key]/route");
  return mod.GET;
}

function fakeRequest(path: string) {
  return new Request(`http://localhost:3000${path}`, { method: "GET" });
}

describe("GET /api/catalog-image/[...key]", () => {
  it("returns 404 for unknown key", async () => {
    mockStreamFromR2.mockResolvedValue(null);
    const GET = await importGET();
    const res = await GET(
      fakeRequest("/api/catalog-image/catalog/nonexistent.jpg") as never,
      { params: Promise.resolve({ key: ["catalog", "nonexistent.jpg"] }) },
    );
    expect(res.status).toBe(404);
  });

  it("streams image with immutable cache header", async () => {
    const body = new ReadableStream({
      start(c) { c.enqueue(new Uint8Array([0xFF, 0xD8])); c.close(); },
    });
    mockStreamFromR2.mockResolvedValue({ body, contentType: "image/jpeg" });
    const GET = await importGET();
    const res = await GET(
      fakeRequest("/api/catalog-image/catalog/test.jpg") as never,
      { params: Promise.resolve({ key: ["catalog", "test.jpg"] }) },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable");
  });

  it("joins path segments into a single key", async () => {
    mockStreamFromR2.mockResolvedValue(null);
    const GET = await importGET();
    await GET(
      fakeRequest("/api/catalog-image/catalog/test.jpg") as never,
      { params: Promise.resolve({ key: ["catalog", "test.jpg"] }) },
    );
    expect(mockStreamFromR2).toHaveBeenCalledWith("catalog/test.jpg");
  });

  it("returns correct content type for PNG", async () => {
    const body = new ReadableStream({
      start(c) { c.enqueue(new Uint8Array([0x89, 0x50])); c.close(); },
    });
    mockStreamFromR2.mockResolvedValue({ body, contentType: "image/png" });
    const GET = await importGET();
    const res = await GET(
      fakeRequest("/api/catalog-image/catalog/test.png") as never,
      { params: Promise.resolve({ key: ["catalog", "test.png"] }) },
    );
    expect(res.headers.get("Content-Type")).toBe("image/png");
  });
});
