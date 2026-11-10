import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@aws-sdk/client-s3", () => {
  const send = vi.fn();
  return {
    S3Client: vi.fn(() => ({ send })),
    PutObjectCommand: vi.fn(),
    GetObjectCommand: vi.fn(),
    __mockSend: send,
  };
});

const { __mockSend } = await import("@aws-sdk/client-s3") as unknown as {
  __mockSend: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.resetModules();
  __mockSend.mockReset();
  process.env.R2_ACCOUNT_ID = "test-account";
  process.env.R2_ACCESS_KEY_ID = "test-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret";
  process.env.R2_BUCKET = "test-bucket";
  delete process.env.R2_PUBLIC_URL;
});

describe("catalogImageUrl", () => {
  it("returns fallback route when R2_PUBLIC_URL is not set", async () => {
    const { catalogImageUrl } = await import("./r2");
    expect(catalogImageUrl("catalog/foo.jpg")).toBe("/api/catalog-image/catalog/foo.jpg");
  });

  it("returns public URL when R2_PUBLIC_URL is set", async () => {
    process.env.R2_PUBLIC_URL = "https://images.example.com";
    const { catalogImageUrl } = await import("./r2");
    expect(catalogImageUrl("catalog/foo.jpg")).toBe("https://images.example.com/catalog/foo.jpg");
  });

  it("strips trailing slash from R2_PUBLIC_URL", async () => {
    process.env.R2_PUBLIC_URL = "https://images.example.com/";
    const { catalogImageUrl } = await import("./r2");
    expect(catalogImageUrl("catalog/foo.jpg")).toBe("https://images.example.com/catalog/foo.jpg");
  });
});

describe("streamFromR2 key allowlist", () => {
  it("allows valid catalog keys", async () => {
    const stream = new ReadableStream();
    __mockSend.mockResolvedValue({
      Body: { transformToWebStream: () => stream },
      ContentType: "image/jpeg",
    });

    const { streamFromR2 } = await import("./r2");
    const result = await streamFromR2("catalog/foo-bar_123.jpg");
    expect(result).not.toBeNull();
    expect(result!.contentType).toBe("image/jpeg");
  });

  it("allows png extension", async () => {
    const stream = new ReadableStream();
    __mockSend.mockResolvedValue({
      Body: { transformToWebStream: () => stream },
      ContentType: "image/png",
    });

    const { streamFromR2 } = await import("./r2");
    const result = await streamFromR2("catalog/item.png");
    expect(result).not.toBeNull();
  });

  it("allows webp extension", async () => {
    const stream = new ReadableStream();
    __mockSend.mockResolvedValue({
      Body: { transformToWebStream: () => stream },
      ContentType: "image/webp",
    });

    const { streamFromR2 } = await import("./r2");
    const result = await streamFromR2("catalog/item.webp");
    expect(result).not.toBeNull();
  });

  it("rejects path traversal", async () => {
    const { streamFromR2 } = await import("./r2");
    const result = await streamFromR2("catalog/../secrets.txt");
    expect(result).toBeNull();
    expect(__mockSend).not.toHaveBeenCalled();
  });

  it("rejects keys outside catalog prefix", async () => {
    const { streamFromR2 } = await import("./r2");
    const result = await streamFromR2("private/secret.jpg");
    expect(result).toBeNull();
    expect(__mockSend).not.toHaveBeenCalled();
  });

  it("rejects directory listing attempt (no extension)", async () => {
    const { streamFromR2 } = await import("./r2");
    const result = await streamFromR2("catalog/");
    expect(result).toBeNull();
    expect(__mockSend).not.toHaveBeenCalled();
  });

  it("rejects nested paths within catalog", async () => {
    const { streamFromR2 } = await import("./r2");
    const result = await streamFromR2("catalog/sub/dir/file.jpg");
    expect(result).toBeNull();
    expect(__mockSend).not.toHaveBeenCalled();
  });

  it("rejects executable extensions", async () => {
    const { streamFromR2 } = await import("./r2");
    const result = await streamFromR2("catalog/malware.exe");
    expect(result).toBeNull();
    expect(__mockSend).not.toHaveBeenCalled();
  });

  it("returns null when R2_BUCKET is not set", async () => {
    delete process.env.R2_BUCKET;
    const { streamFromR2 } = await import("./r2");
    const result = await streamFromR2("catalog/valid.jpg");
    expect(result).toBeNull();
  });

  it("returns null when S3 GetObject fails", async () => {
    __mockSend.mockRejectedValue(new Error("NoSuchKey"));
    const { streamFromR2 } = await import("./r2");
    const result = await streamFromR2("catalog/nonexistent.jpg");
    expect(result).toBeNull();
  });
});

describe("delivery proof keys", () => {
  it("a delivery-proof key is refused by the catalog reader, and the proof reader refuses catalog keys", async () => {
    __mockSend.mockResolvedValue({
      Body: { transformToWebStream: () => new ReadableStream() },
      ContentType: "image/jpeg",
    });
    const { deliveryProofKey, streamDeliveryProof, streamFromR2 } = await import("./r2");
    const key = deliveryProofKey("cmorder123", 1762700000000, "jpg");
    expect(key).toBe("delivery-proof/cmorder123/1762700000000.jpg");

    expect(await streamFromR2(key)).toBeNull();
    expect(await streamDeliveryProof("catalog/foo.jpg")).toBeNull();
    expect(await streamDeliveryProof("delivery-proof/cmorder123/../x.jpg")).toBeNull();
    expect(await streamDeliveryProof("delivery-proof/cmorder123/1762700000000.svg")).toBeNull();
    expect(__mockSend).not.toHaveBeenCalled();

    expect(await streamDeliveryProof(key)).not.toBeNull();
  });
});

describe("shared catalog key rule", () => {
  it("accepts a route key and rejects dotted names", async () => {
    const { isServableCatalogKey } = await import("./r2");
    expect(isServableCatalogKey("catalog/foo-bar_123.webp")).toBe(true);
    expect(isServableCatalogKey("catalog/logo.svg")).toBe(true);
    expect(isServableCatalogKey("catalog/a.b.jpg")).toBe(false);
    expect(isServableCatalogKey("catalog/../x.jpg")).toBe(false);
  });

  it("builds a client from supplied credentials without reading ambient R2 env", async () => {
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    const s3 = await import("@aws-sdk/client-s3") as unknown as { S3Client: ReturnType<typeof vi.fn> };
    s3.S3Client.mockClear();
    const { getR2Client } = await import("./r2");
    getR2Client({ accountId: "acct-a", accessKeyId: "key-a", secretAccessKey: "secret-a" });
    expect(s3.S3Client).toHaveBeenCalledWith({
      region: "auto",
      endpoint: "https://acct-a.r2.cloudflarestorage.com",
      credentials: { accessKeyId: "key-a", secretAccessKey: "secret-a" },
    });
  });

  it("shared imports remain inert with no R2 env in a production build context", async () => {
    vi.resetModules();
    const s3 = await import("@aws-sdk/client-s3") as unknown as { S3Client: ReturnType<typeof vi.fn> };
    s3.S3Client.mockClear();
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_SECRET_ACCESS_KEY;
    delete process.env.R2_BUCKET;
    delete process.env.R2_PUBLIC_URL;
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    try {
      await import("./r2");
      await import("./storefront/images");
      expect(s3.S3Client).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
