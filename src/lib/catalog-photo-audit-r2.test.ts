import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  clients: [] as Array<{ config: Record<string, unknown>; send: ReturnType<typeof vi.fn> }>,
  put: vi.fn(),
  del: vi.fn(),
  copy: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => {
  class HeadBucketCommand {
    constructor(public input: { Bucket?: string }) {}
  }
  class HeadObjectCommand {
    constructor(public input: { Bucket?: string; Key?: string }) {}
  }
  class PutObjectCommand {
    constructor(input: unknown) { state.put(input); }
  }
  class DeleteObjectCommand {
    constructor(input: unknown) { state.del(input); }
  }
  class CopyObjectCommand {
    constructor(input: unknown) { state.copy(input); }
  }
  class ListObjectsV2Command {
    constructor(input: unknown) { state.list(input); }
  }
  class GetObjectCommand {
    constructor(public input: unknown) {}
  }
  const S3Client = vi.fn(function (this: { send: ReturnType<typeof vi.fn>; destroy: () => void }, config: Record<string, unknown>) {
    const send = vi.fn(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "HeadBucketCommand" || command.constructor.name === "HeadObjectCommand") {
        return { $metadata: { httpStatusCode: 200 } };
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    });
    this.send = send;
    this.destroy = vi.fn();
    state.clients.push({ config, send });
  });
  return {
    S3Client,
    HeadBucketCommand,
    HeadObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
    CopyObjectCommand,
    ListObjectsV2Command,
    GetObjectCommand,
  };
});

import { CatalogAuditError, statusLabel } from "./catalog-photo-audit";
import { createR2HeadObject } from "./catalog-photo-audit-r2";

const credentials = {
  accountId: "acct-a",
  accessKeyId: "key-a",
  secretAccessKey: "secret-a",
  bucket: "bucket-a",
};

function statusError(name: string, status?: number, attempts?: number) {
  return Object.assign(new Error(name), {
    name,
    $metadata: status === undefined ? undefined : { httpStatusCode: status, attempts },
  });
}

beforeEach(() => {
  state.clients.length = 0;
  state.put.mockClear();
  state.del.mockClear();
  state.copy.mockClear();
  state.list.mockClear();
  delete process.env.R2_ACCOUNT_ID;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_BUCKET;
  delete process.env.R2_PUBLIC_URL;
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
});

describe("createR2HeadObject", () => {
  it("maps 200 to present and 404 NotFound to missing (contract)", async () => {
    const api = createR2HeadObject(credentials);
    const send = state.clients[0]!.send;
    send.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === "HeadBucketCommand") return { $metadata: { httpStatusCode: 200 } };
      if (command.constructor.name === "HeadObjectCommand") {
        throw statusError("NotFound", 404);
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    });
    await api.headBucket();
    await expect(api.headObject("catalog/missing.jpg")).resolves.toBe("missing");
  });

  it("throws on 403 Unknown, 429 and 503 after SDK attempts, and network errors (AC3, E1, E16)", async () => {
    const cases = [
      statusError("Unknown", 403, 1),
      statusError("SlowDown", 429, 3),
      statusError("ServiceUnavailable", 503, 3),
      Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" }),
    ];
    for (const failure of cases) {
      state.clients.length = 0;
      const api = createR2HeadObject(credentials);
      const send = state.clients[0]!.send;
      send.mockImplementation(async (command: { constructor: { name: string }; input?: { Key?: string } }) => {
        if (command.constructor.name === "HeadBucketCommand") return { $metadata: { httpStatusCode: 200 } };
        throw failure;
      });
      await api.headBucket();
      const before = send.mock.calls.length;
      await expect(api.headObject("catalog/biltong.jpg")).rejects.toThrow(/HeadObject failed for catalog\/biltong\.jpg/);
      expect(send.mock.calls.length - before).toBe(1);
      try {
        await api.headObject("catalog/biltong.jpg");
      } catch (err) {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).not.toMatch(/missing/);
      }
    }
  });

  it("HeadBucket 403 or 404 aborts before any HeadObject (E17)", async () => {
    for (const status of [403, 404]) {
      state.clients.length = 0;
      const api = createR2HeadObject({ ...credentials, bucket: "wrong-bucket" });
      const send = state.clients[0]!.send;
      send.mockImplementation(async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === "HeadBucketCommand") throw statusError("Unknown", status);
        throw new Error("HeadObject should not run");
      });
      await expect(api.headBucket()).rejects.toThrow(`HeadBucket failed for wrong-bucket: HTTP ${status}`);
      expect(send).toHaveBeenCalledTimes(1);
    }
  });

  it("sends only HeadBucket and HeadObject commands (AC5)", async () => {
    const api = createR2HeadObject(credentials);
    await api.headBucket();
    await expect(api.headObject("catalog/ok.webp")).resolves.toBe("present");
    const send = state.clients[0]!.send;
    for (const call of send.mock.calls) {
      expect(["HeadBucketCommand", "HeadObjectCommand"]).toContain(call[0].constructor.name);
    }
    expect(state.put).not.toHaveBeenCalled();
    expect(state.del).not.toHaveBeenCalled();
    expect(state.copy).not.toHaveBeenCalled();
    expect(state.list).not.toHaveBeenCalled();
  });

  it("constructor and commands use supplied env rather than ambient env (E25)", async () => {
    process.env.R2_ACCOUNT_ID = "ambient-account";
    process.env.R2_ACCESS_KEY_ID = "ambient-key";
    process.env.R2_SECRET_ACCESS_KEY = "ambient-secret";
    process.env.R2_BUCKET = "ambient-bucket";
    process.env.R2_PUBLIC_URL = "https://cdn.example.com";
    const before = { ...process.env };
    const first = createR2HeadObject(credentials);
    const second = createR2HeadObject({
      accountId: "acct-b",
      accessKeyId: "key-b",
      secretAccessKey: "secret-b",
      bucket: "bucket-b",
    });
    expect(state.clients[0]!.config).toMatchObject({
      region: "auto",
      endpoint: "https://acct-a.r2.cloudflarestorage.com",
      credentials: { accessKeyId: "key-a", secretAccessKey: "secret-a" },
    });
    const handler = state.clients[0]!.config.requestHandler as unknown as { configProvider: Promise<{ requestTimeout?: number; connectionTimeout?: number; throwOnRequestTimeout?: boolean }> };
    await expect(handler.configProvider).resolves.toMatchObject({
      requestTimeout: 10000,
      connectionTimeout: 10000,
      throwOnRequestTimeout: true,
    });
    expect(state.clients[0]!.config.maxAttempts).toBeUndefined();
    expect(String(state.clients[0]!.config.endpoint)).not.toContain("cdn.example.com");
    expect(state.clients[1]!.config).toMatchObject({
      endpoint: "https://acct-b.r2.cloudflarestorage.com",
      credentials: { accessKeyId: "key-b", secretAccessKey: "secret-b" },
    });
    await first.headBucket();
    await first.headObject("catalog/a.webp");
    await second.headObject("catalog/b.webp");
    expect(state.clients[0]!.send.mock.calls[1][0].input).toEqual({ Bucket: "bucket-a", Key: "catalog/a.webp" });
    expect(state.clients[1]!.send.mock.calls[0][0].input).toEqual({ Bucket: "bucket-b", Key: "catalog/b.webp" });
    expect(process.env.R2_ACCOUNT_ID).toBe(before.R2_ACCOUNT_ID);
    expect(process.env.R2_BUCKET).toBe(before.R2_BUCKET);
  });

  it("status beats name and unrecognized success metadata fails closed (E30)", async () => {
    const api = createR2HeadObject(credentials);
    const send = state.clients[0]!.send;
    send.mockImplementationOnce(async () => ({ $metadata: { httpStatusCode: 200 } }));
    await api.headBucket();

    send.mockImplementationOnce(async () => { throw statusError("NotFound", 403); });
    await expect(api.headObject("catalog/named-403.webp")).rejects.toThrow("HTTP 403");

    send.mockImplementationOnce(async () => { throw statusError("Unknown", 404); });
    await expect(api.headObject("catalog/unexpected-name.webp")).resolves.toBe("missing");

    send.mockImplementationOnce(async () => { throw statusError("NotFound"); });
    await expect(api.headObject("catalog/named-bare.webp")).rejects.toThrow("no status");

    send.mockImplementationOnce(async () => ({ $metadata: {} }));
    await expect(api.headObject("catalog/no-meta.webp")).rejects.toThrow("no status");

    send.mockImplementationOnce(async () => ({ $metadata: { httpStatusCode: 204 } }));
    await expect(api.headObject("catalog/no-content.webp")).rejects.toThrow("HTTP 204");

    send.mockImplementationOnce(async () => ({ $metadata: { httpStatusCode: 301 } }));
    await expect(api.headObject("catalog/redirect.webp")).rejects.toThrow("HTTP 301");
  });

  it("both HEAD methods preserve existing CatalogAuditError identity and details", async () => {
    const api = createR2HeadObject(credentials);
    const send = state.clients[0]!.send;
    const stored = new CatalogAuditError("kept object", {
      key: "catalog/kept.webp",
      bucket: "bucket-a",
      statusLabel: "custom",
    });
    send.mockImplementationOnce(async () => {
      throw stored;
    });
    await expect(api.headObject("catalog/kept.webp")).rejects.toBe(stored);
    expect(stored.statusLabel).toBe("custom");
    expect(stored.message).toBe("kept object");
    expect(stored.key).toBe("catalog/kept.webp");
    expect(stored.bucket).toBe("bucket-a");
    expect(statusLabel(stored)).toBe("no status");

    const withMeta = new CatalogAuditError("kept meta", {
      key: "catalog/meta.webp",
      statusLabel: "custom",
    });
    Object.assign(withMeta, { $metadata: { httpStatusCode: 403 } });
    send.mockImplementationOnce(async () => {
      throw withMeta;
    });
    await expect(api.headObject("catalog/meta.webp")).rejects.toBe(withMeta);
    expect(withMeta.statusLabel).toBe("custom");
    expect(withMeta.message).toBe("kept meta");
    expect(withMeta.key).toBe("catalog/meta.webp");
    expect(statusLabel(withMeta)).toBe("HTTP 403");

    const bucketErr = new CatalogAuditError("kept bucket", {
      bucket: "bucket-a",
      statusLabel: "custom",
    });
    Object.assign(bucketErr, { $metadata: { httpStatusCode: 404 } });
    send.mockImplementationOnce(async () => {
      throw bucketErr;
    });
    await expect(api.headBucket()).rejects.toBe(bucketErr);
    expect(bucketErr.statusLabel).toBe("custom");
    expect(bucketErr.message).toBe("kept bucket");
    expect(bucketErr.bucket).toBe("bucket-a");
    expect(statusLabel(bucketErr)).toBe("HTTP 404");
  });

  it("both HEAD methods retain their operation-specific status outcomes", async () => {
    const api = createR2HeadObject(credentials);
    const send = state.clients[0]!.send;

    send.mockImplementationOnce(async () => ({ $metadata: { httpStatusCode: 200 } }));
    await expect(api.headBucket()).resolves.toBeUndefined();
    send.mockImplementationOnce(async () => ({ $metadata: { httpStatusCode: 200 } }));
    await expect(api.headObject("catalog/ok.webp")).resolves.toBe("present");

    send.mockImplementationOnce(async () => {
      throw statusError("NotFound", 404);
    });
    await expect(api.headObject("catalog/gone.webp")).resolves.toBe("missing");

    send.mockImplementationOnce(async () => {
      throw statusError("NotFound", 404);
    });
    await expect(api.headBucket()).rejects.toMatchObject({
      name: "CatalogAuditError",
      message: "HeadBucket failed for bucket-a: HTTP 404",
      statusLabel: "HTTP 404",
      bucket: "bucket-a",
    });

    for (const status of [304, 405, 412]) {
      const key = `catalog/s${status}.webp`;
      send.mockImplementationOnce(async () => {
        throw statusError("Unknown", status);
      });
      await expect(api.headObject(key)).rejects.toMatchObject({
        message: `HeadObject failed for ${key}: HTTP ${status}`,
        statusLabel: `HTTP ${status}`,
        key,
      });
      send.mockImplementationOnce(async () => {
        throw statusError("Unknown", status);
      });
      await expect(api.headBucket()).rejects.toMatchObject({
        message: `HeadBucket failed for bucket-a: HTTP ${status}`,
        statusLabel: `HTTP ${status}`,
        bucket: "bucket-a",
      });
    }

    const malformed = { name: "NotFound", $metadata: { httpStatusCode: "404" } };
    send.mockImplementationOnce(async () => {
      throw malformed;
    });
    await expect(api.headObject("catalog/bad.webp")).rejects.toMatchObject({
      message: "HeadObject failed for catalog/bad.webp: no status",
      statusLabel: "no status",
      key: "catalog/bad.webp",
    });
    expect(statusLabel(malformed)).toBe("no status");

    send.mockImplementationOnce(async () => {
      throw { name: "TimeoutError" };
    });
    await expect(api.headObject("catalog/slow.webp")).rejects.toMatchObject({
      message: "HeadObject failed for catalog/slow.webp: timeout",
      statusLabel: "timeout",
      key: "catalog/slow.webp",
    });

    send.mockImplementationOnce(async () => {
      throw { name: "AbortError", $metadata: null };
    });
    await expect(api.headBucket()).rejects.toMatchObject({
      message: "HeadBucket failed for bucket-a: timeout",
      statusLabel: "timeout",
      bucket: "bucket-a",
    });
  });

  it("adapter and core report the same status label for every error shape", async () => {
    const shapes: Array<{ shape: unknown; label: string; key: string }> = [
      { shape: { name: "Unknown", $metadata: { httpStatusCode: 403 } }, label: "HTTP 403", key: "catalog/s403.webp" },
      { shape: { name: "Unknown", $metadata: { httpStatusCode: 503 } }, label: "HTTP 503", key: "catalog/s503.webp" },
      { shape: { name: "NotFound", $metadata: { httpStatusCode: "404" } }, label: "no status", key: "catalog/str.webp" },
      { shape: { name: "Error" }, label: "no status", key: "catalog/bare.webp" },
      { shape: { name: "Error", $metadata: null }, label: "no status", key: "catalog/null-meta.webp" },
      { shape: { name: "Error", $metadata: {} }, label: "no status", key: "catalog/empty-meta.webp" },
      { shape: { $metadata: { httpStatusCode: Number.NaN } }, label: "HTTP NaN", key: "catalog/nan.webp" },
      { shape: { name: "TimeoutError", $metadata: { httpStatusCode: 0 } }, label: "HTTP 0", key: "catalog/zero.webp" },
      { shape: "nope", label: "no status", key: "catalog/string.webp" },
      { shape: null, label: "no status", key: "catalog/null.webp" },
      { shape: undefined, label: "no status", key: "catalog/undef.webp" },
      { shape: 404, label: "no status", key: "catalog/number.webp" },
      { shape: { name: "TimeoutError" }, label: "timeout", key: "catalog/timeout.webp" },
      { shape: { name: "AbortError", $metadata: { httpStatusCode: "408" } }, label: "timeout", key: "catalog/abort.webp" },
    ];
    const api = createR2HeadObject(credentials);
    const send = state.clients[0]!.send;
    for (const { shape, label, key } of shapes) {
      expect(statusLabel(shape)).toBe(label);
      send.mockImplementationOnce(async () => {
        throw shape;
      });
      await expect(api.headObject(key)).rejects.toMatchObject({
        statusLabel: label,
        key,
        message: `HeadObject failed for ${key}: ${label}`,
      });
    }
    send.mockImplementationOnce(async () => {
      throw statusError("NotFound", 404);
    });
    await expect(api.headObject("catalog/missing-map.webp")).resolves.toBe("missing");
    expect(statusLabel(statusError("NotFound", 404))).toBe("HTTP 404");
  });
});
