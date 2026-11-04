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
});
