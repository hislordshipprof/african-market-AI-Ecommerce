import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { planCatalogPrune } from "./catalog-prune";
import { deleteCatalogCandidates, listCatalogObjects } from "./catalog-prune-execute";
import { createFakeR2 } from "./catalog-prune-fake-r2";

const sandboxBucket = process.env.R2_SANDBOX_BUCKET;
const sandboxAccess = process.env.R2_SANDBOX_ACCESS_KEY_ID;
const sandboxSecret = process.env.R2_SANDBOX_SECRET_ACCESS_KEY;
const hasSandbox = Boolean(sandboxBucket && sandboxAccess && sandboxSecret && process.env.R2_ACCOUNT_ID);

describe("catalog prune sandbox", () => {
  it("production executor deletes only the old unreferenced object and a later list matches the provider", async () => {
    const bucket = "t225-sandbox-fake";
    const prefix = "catalog/prune-sandbox/run/";
    const orphan = `${prefix}orphan.jpg`;
    const keep = `${prefix}keep.jpg`;
    const unrelated = `${prefix}unrelated.jpg`;
    const now = new Date("2026-06-15T12:00:00.000Z");
    const old = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fresh = new Date(now.getTime() - 60 * 60 * 1000);
    const fake = createFakeR2({
      bucket,
      objects: [
        { key: orphan, lastModified: old },
        { key: keep, lastModified: old },
        { key: unrelated, lastModified: fresh },
      ],
    });
    const listed = await listCatalogObjects(fake, bucket, prefix);
    const candidates = planCatalogPrune({
      objects: listed,
      references: [keep],
      now,
    });
    expect(candidates).toEqual([orphan]);
    const logs: string[] = [];
    await deleteCatalogCandidates({ client: fake, bucket, keys: candidates, log: (line) => logs.push(line) });
    expect(logs).toContain(`deleted ${orphan}`);
    const after = await listCatalogObjects(fake, bucket, prefix);
    expect(after.map((object) => object.key).sort()).toEqual([keep, unrelated].sort());
  });

  it("a failed delete still cleans the manifest and the next list is empty", async () => {
    const bucket = "t225-sandbox-fake";
    const prefix = "catalog/prune-sandbox/fail/";
    const orphan = `${prefix}orphan.jpg`;
    const keep = `${prefix}keep.jpg`;
    const now = new Date("2026-06-15T12:00:00.000Z");
    const old = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fake = createFakeR2({
      bucket,
      objects: [
        { key: orphan, lastModified: old },
        { key: keep, lastModified: old },
      ],
    });
    const listed = await listCatalogObjects(fake, bucket, prefix);
    const candidates = planCatalogPrune({ objects: listed, references: [keep], now });
    expect(candidates).toEqual([orphan]);
    let deny = true;
    const client = {
      async send(command: unknown) {
        const input = (command as { input?: { Delete?: { Objects?: { Key?: string }[] } } }).input;
        if (deny && input?.Delete) {
          deny = false;
          return {
            Deleted: [],
            Errors: [{ Key: orphan, Code: "AccessDenied" }],
            $metadata: { httpStatusCode: 200 },
          };
        }
        return fake.send(command);
      },
    };
    await expect(deleteCatalogCandidates({
      client,
      bucket,
      keys: candidates,
      log: () => undefined,
    })).rejects.toThrow(/AccessDenied/);
    expect((await listCatalogObjects(fake, bucket, prefix)).map((object) => object.key).sort()).toEqual([keep, orphan].sort());
    const leftover = (await listCatalogObjects(fake, bucket, prefix)).map((object) => object.key);
    await deleteCatalogCandidates({
      client,
      bucket,
      keys: leftover,
      log: () => undefined,
    });
    expect(await listCatalogObjects(fake, bucket, prefix)).toEqual([]);
  });

  it("real R2 scratch bucket: dry-run lists and bucket-name prune deletes only the unreferenced old object", async (ctx) => {
    if (!hasSandbox) {
      ctx.skip("R2_SANDBOX_BUCKET, R2_SANDBOX_ACCESS_KEY_ID and R2_SANDBOX_SECRET_ACCESS_KEY are not set. This does not block the build.");
      return;
    }
    if (sandboxBucket === process.env.R2_BUCKET || sandboxBucket === "african-markets-dev") {
      throw new Error("Refusing sandbox prune: scratch bucket matches the shared bucket");
    }
    const run = `t225-${Date.now().toString(36)}`;
    const prefix = `catalog/prune-sandbox/${run}/`;
    const orphan = `${prefix}orphan.jpg`;
    const keep = `${prefix}keep.jpg`;
    const unrelated = `${prefix}unrelated.jpg`;
    const client = new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: sandboxAccess!, secretAccessKey: sandboxSecret! },
    });
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const manifest = [orphan, keep, unrelated];
    let cleanupError: unknown;
    try {
      for (const key of manifest) {
        await client.send(new PutObjectCommand({
          Bucket: sandboxBucket,
          Key: key,
          Body: Buffer.from("t225"),
          ContentType: "image/jpeg",
        }));
      }
      const now = new Date(Date.now() + 25 * 60 * 60 * 1000);
      const listed = await listCatalogObjects(client, sandboxBucket!, prefix);
      const candidates = planCatalogPrune({
        objects: listed,
        references: [keep, unrelated],
        now,
      });
      expect(candidates).toEqual([orphan]);
      await deleteCatalogCandidates({
        client,
        bucket: sandboxBucket!,
        keys: candidates,
        log: () => undefined,
      });
      const after = await listCatalogObjects(client, sandboxBucket!, prefix);
      expect(after.map((object) => object.key).sort()).toEqual([keep, unrelated].sort());
    } finally {
      try {
        const left = await listCatalogObjects(client, sandboxBucket!, prefix);
        if (left.length > 0) {
          await deleteCatalogCandidates({
            client,
            bucket: sandboxBucket!,
            keys: left.map((object) => object.key),
            log: () => undefined,
          });
        }
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError) throw cleanupError;
  });

  it("sandbox execution and cleanup are restricted to this run manifest", () => {
    const manifest = ["catalog/prune-sandbox/run/orphan.jpg"];
    const foreign = "catalog/alligator-pepper.jpg";
    const candidates = planCatalogPrune({
      objects: [
        { key: manifest[0]!, lastModified: new Date("2020-01-01T00:00:00.000Z") },
        { key: foreign, lastModified: new Date("2020-01-01T00:00:00.000Z") },
      ].filter((object) => object.key.startsWith("catalog/prune-sandbox/run/")),
      references: [],
      now: new Date("2026-06-15T00:00:00.000Z"),
    });
    expect(candidates).toEqual(manifest);
    expect(candidates).not.toContain(foreign);
    expect(sandboxBucket === "african-markets-dev").toBe(false);
  });
});
