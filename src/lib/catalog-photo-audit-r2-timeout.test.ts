import net from "node:net";
import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { catalogHeadClientConfig, createR2HeadObject } from "./catalog-photo-audit-r2";

describe("catalog head deadline", () => {
  it("production config sets a finite timeout and the account endpoint", async () => {
    const config = catalogHeadClientConfig({
      accountId: "acct",
      accessKeyId: "key",
      secretAccessKey: "secret",
      bucket: "bucket",
    });
    expect(config.endpoint).toBe("https://acct.r2.cloudflarestorage.com");
    expect(config.region).toBe("auto");
    const handler = config.requestHandler as unknown as { configProvider: Promise<{ requestTimeout?: number; connectionTimeout?: number; throwOnRequestTimeout?: boolean }> };
    await expect(handler.configProvider).resolves.toMatchObject({
      connectionTimeout: 10000,
      requestTimeout: 10000,
      throwOnRequestTimeout: true,
    });
    expect("maxAttempts" in config).toBe(false);
  });

  it("stalled request terminates under the configured deadline", async () => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const settings = {
      accountId: "acct",
      accessKeyId: "key",
      secretAccessKey: "secret",
      bucket: "bucket",
      requestTimeoutMs: 300,
    };
    const client = new S3Client({
      ...catalogHeadClientConfig(settings),
      endpoint: `http://127.0.0.1:${address.port}`,
      forcePathStyle: true,
      maxAttempts: 1,
    });
    const api = createR2HeadObject(settings, { client });
    const started = Date.now();
    try {
      await expect(api.headBucket()).rejects.toThrow(/timeout|Timeout|aborted|Abort/i);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      api.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }, 15_000);
});
